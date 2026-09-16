/**
 * Apps explorer — three trees over the workspace repo's apps.
 *
 * - **Starred**: this person's favourites, in folders of their own. A star is
 *   a shortcut, never a move; folders here are bookmark folders, kept in the
 *   database, instant, no commit.
 * - **Workspace**: the real `apps/` tree of the repo. Folders are directories;
 *   dragging an app into one is a `git mv` on main (editors only). The app
 *   keeps its id, so its tab, deployment, sharing and everyone's stars
 *   follow it and nothing rebuilds.
 * - **Personal**: the same, under `users/<me>/apps/` — this person's own
 *   apps, visible to nobody else.
 *
 * Each app is a directory node whose children are its file tree (loaded
 * lazily from the durable worktree API); every file opens in its own editor
 * tab. Sharing is changed from the Share dialog, not by dragging.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  ListItemIcon,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  Globe as GlobeIcon,
  User as UserIcon,
  Braces as JsonFileIcon,
  Database as BindingIcon,
  File as PlainFileIcon,
  FileCode as CodeFileIcon,
  FileText as TextFileIcon,
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  FolderPlus as FolderPlusIcon,
  KeyRound as EnvIcon,
  Pencil as RenameIcon,
  Plus as AddIcon,
  Github as LinkIcon,
  RefreshCw as RefreshIcon,
  Star as StarIcon,
  Trash2 as DeleteIcon,
  UserPlus as ShareMenuIcon,
  Wand2 as StampIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useConsoleStore,
  selectTabBySettingsSection,
} from "../store/consoleStore";
import { SECTION_LABELS } from "../pages/settings/sections";
import {
  appRootOf,
  appUrlRef,
  useAppsStore,
  type AppFileEntry,
  type AppMeta,
} from "../store/appsStore";
import {
  favouriteFor,
  selectFavourites,
  starredRefs,
  useFavouritesStore,
} from "../store/favouritesStore";
import { useAuth } from "../contexts/auth-context";
import { useIsWorkspaceAdmin } from "../hooks/useIsWorkspaceAdmin";
import ShareDialog from "./ShareDialog";
import AppEnvDialog from "./AppEnvDialog";
import { focusAppsFileTab, focusAppsTab } from "../apps-runtime/shell";
import {
  useExplorerRevealStore,
  selectRevealFor,
} from "../store/explorerRevealStore";
import { APP_DIR_SEP, APP_FILE_SEP } from "../lib/explorer-reveal";
import { TAB_KIND_ICONS } from "../lib/entity-icons";
import {
  basenameOf,
  buildAppTree,
  folderNodeId,
  folderPathFromNodeId,
  parentPathOf,
} from "../lib/apps-explorer-tree";
import ExplorerShell from "./ExplorerShell";
import ResourceTree, { type ResourceTreeNode } from "./ResourceTree";
import { useConfirm } from "./ConfirmDialog";
import AccessIcon from "./AccessIcon";
import { resolveAccessState } from "./access-state";
import StarToggle from "./starred/StarToggle";
import {
  STARRED_SECTION_KEY,
  buildStarredSection,
  entityIdFromStarredRow,
  favouriteIdFromFolderRow,
  starredFolderId,
} from "./starred/starred-section";
import { FolderNameDialog } from "./apps-explorer/AppFolderDialogs";

const AppIcon = TAB_KIND_ICONS["app"];

const WORKSPACE_ROOT = "apps";
const WORKSPACE_SECTION = "workspace";
const PERSONAL_SECTION = "personal";

type ParsedNode =
  | { kind: "app"; appId: string; pinned: boolean }
  | { kind: "dir" | "file"; appId: string; path: string }
  | { kind: "folder"; folderPath: string }
  | { kind: "starfolder"; favId: string };

function parseNodeId(id: string): ParsedNode {
  const folderPath = folderPathFromNodeId(id);
  if (folderPath !== null) return { kind: "folder", folderPath };
  const favId = favouriteIdFromFolderRow(id);
  if (favId !== null) return { kind: "starfolder", favId };
  const pinned = entityIdFromStarredRow(id);
  if (pinned !== null) return { kind: "app", appId: pinned, pinned: true };
  if (id.includes(APP_FILE_SEP)) {
    const [appId, path] = id.split(APP_FILE_SEP);
    return { kind: "file", appId, path };
  }
  if (id.includes(APP_DIR_SEP)) {
    const [appId, path] = id.split(APP_DIR_SEP);
    return { kind: "dir", appId, path };
  }
  return { kind: "app", appId: id, pinned: false };
}

// Per-extension file icons — the same mapping the legacy explorer used, so the
// two trees read identically. A binding (bindings/*.sql) gets the database
// icon: it IS a data binding, the .sql is just its serialization.
const CODE_FILE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "css",
  "scss",
  "html",
  "sql",
]);
function fileIcon(name: string, path: string) {
  if (/^bindings\//.test(path) && name.endsWith(".sql")) {
    return <BindingIcon size={16} strokeWidth={1.5} />;
  }
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (CODE_FILE_EXTENSIONS.has(ext)) {
    return <CodeFileIcon size={16} strokeWidth={1.5} />;
  }
  if (ext === "md" || ext === "mdx" || ext === "txt") {
    return <TextFileIcon size={16} strokeWidth={1.5} />;
  }
  if (ext === "json") {
    return <JsonFileIcon size={16} strokeWidth={1.5} />;
  }
  return <PlainFileIcon size={16} strokeWidth={1.5} />;
}

/** Build nested folder/file nodes for one app. */
function buildFileNodes(
  appId: string,
  files: AppFileEntry[],
): ResourceTreeNode[] {
  const root: ResourceTreeNode = {
    id: `${appId}${APP_DIR_SEP}`,
    name: "",
    path: "",
    isDirectory: true,
    children: [],
  };
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    let cursor = root;
    segments.forEach((segment, index) => {
      const isLeaf = index === segments.length - 1;
      const path = segments.slice(0, index + 1).join("/");
      const id = isLeaf
        ? `${appId}${APP_FILE_SEP}${path}`
        : `${appId}${APP_DIR_SEP}${path}`;
      let child = cursor.children?.find(c => c.id === id);
      if (!child) {
        child = {
          id,
          name: segment,
          path,
          isDirectory: !isLeaf,
          children: isLeaf ? undefined : [],
        };
        cursor.children?.push(child);
      }
      cursor = child;
    });
  }
  const sort = (nodes: ResourceTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach(n => n.children && sort(n.children));
  };
  sort(root.children || []);
  return root.children || [];
}

/** A folder path as a person reads it: `apps/Sales/CH` → `Workspace / Sales / CH`. */
function folderLabel(path: string, personalRoot: string | null): string {
  if (path === WORKSPACE_ROOT) return "Workspace";
  if (personalRoot && path === personalRoot) return "Personal";
  if (path.startsWith(`${WORKSPACE_ROOT}/`)) {
    return `Workspace / ${path.slice(WORKSPACE_ROOT.length + 1).replace(/\//g, " / ")}`;
  }
  if (personalRoot && path.startsWith(`${personalRoot}/`)) {
    return `Personal / ${path.slice(personalRoot.length + 1).replace(/\//g, " / ")}`;
  }
  return path;
}

interface FolderDialogState {
  mode: "create" | "rename";
  /** create: the parent folder; rename: the folder itself. */
  path: string;
  /** rename of a favourites folder instead of a git one. */
  favId?: string;
  initialName?: string;
}

export default function AppsExplorer() {
  const { currentWorkspace } = useWorkspace();
  const confirm = useConfirm();
  const workspaceId = currentWorkspace?.id;
  // Viewers read; every editing member may reorganise the Workspace tree.
  // A person's own tree is theirs regardless.
  const canOrganize = currentWorkspace?.role !== "viewer";

  const apps = useAppsStore(s => s.apps);
  const folders = useAppsStore(s => s.folders);
  const { user } = useAuth();
  const userId = user?.id;
  const personalRoot = userId ? `users/${userId}/apps` : null;
  const loading = useAppsStore(s => s.appsLoading);
  const error = useAppsStore(s => s.error);
  const clearError = useAppsStore(s => s.clearError);
  const canCreate = useAppsStore(s => s.canCreate);
  const repos = useAppsStore(s => s.repos);
  const probeEnabled = useAppsStore(s => s.probeEnabled);
  const filesByApp = useAppsStore(s => s.filesByApp);
  const runningDevApps = useAppsStore(s => s.runningDevApps);
  const previewByApp = useAppsStore(s => s.previewByApp);
  const fetchRunningDevApps = useAppsStore(s => s.fetchRunningDevApps);
  const filesTruncatedByApp = useAppsStore(s => s.filesTruncatedByApp);
  const fetchApps = useAppsStore(s => s.fetchApps);
  const fetchFiles = useAppsStore(s => s.fetchFiles);
  const createApp = useAppsStore(s => s.createApp);
  const deleteApp = useAppsStore(s => s.deleteApp);
  const moveApp = useAppsStore(s => s.moveApp);
  const createAppFolder = useAppsStore(s => s.createAppFolder);
  const moveAppFolder = useAppsStore(s => s.moveAppFolder);
  const deleteAppFolder = useAppsStore(s => s.deleteAppFolder);
  const stampAppId = useAppsStore(s => s.stampAppId);

  const favourites = useFavouritesStore(selectFavourites(workspaceId));
  const fetchFavourites = useFavouritesStore(s => s.fetch);
  const toggleFavourite = useFavouritesStore(s => s.toggle);
  const createFavouriteFolder = useFavouritesStore(s => s.createFolder);
  const renameFavourite = useFavouritesStore(s => s.rename);
  const moveFavourite = useFavouritesStore(s => s.move);
  const removeFavourite = useFavouritesStore(s => s.remove);
  const favouritesError = useFavouritesStore(s => s.error);
  const clearFavouritesError = useFavouritesStore(s => s.clearError);
  const starred = useMemo(() => starredRefs(favourites, "app"), [favourites]);

  const openGitHubSettings = useCallback(() => {
    const state = useConsoleStore.getState();
    const existing = selectTabBySettingsSection("github")(state);
    if (existing) {
      state.setActiveTab(existing.id);
      return;
    }
    const id = state.openTab({
      title: SECTION_LABELS.github,
      content: "",
      kind: "settings",
      settingsSection: "github",
    });
    state.setActiveTab(id);
  }, []);

  const activeTab = useConsoleStore(s =>
    s.activeTabId ? s.tabs[s.activeTabId] : undefined,
  );
  const activeItemId = useMemo(() => {
    if (activeTab?.kind === "app") {
      return (activeTab.metadata?.appId as string) ?? null;
    }
    if (activeTab?.kind === "app-file") {
      return `${activeTab.metadata?.appId}${APP_FILE_SEP}${activeTab.metadata?.path}`;
    }
    return null;
  }, [activeTab]);

  // The app whose version control this sidebar shows — whichever app tab
  // (or one of its files) is currently focused.
  const activeAppId = useMemo(() => {
    if (activeTab?.kind === "app" || activeTab?.kind === "app-file") {
      return (activeTab.metadata?.appId as string) ?? undefined;
    }
    return undefined;
  }, [activeTab]);

  const reveal = useExplorerRevealStore(selectRevealFor("apps"));

  const [loadingApps, setLoadingApps] = useState<Record<string, boolean>>({});
  const [expandedFolders, setExpandedFolders] = useState<
    Record<string, boolean>
  >({});
  const isFolderOpen = useCallback(
    (key: string) => expandedFolders[key] ?? false,
    [expandedFolders],
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [createFolder, setCreateFolder] = useState(WORKSPACE_ROOT);
  const [shareAppId, setShareAppId] = useState<string | null>(null);
  const [envAppId, setEnvAppId] = useState<string | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(
    null,
  );
  const [folderBusy, setFolderBusy] = useState(false);
  const isWorkspaceAdmin = useIsWorkspaceAdmin();
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    void probeEnabled(workspaceId);
  }, [workspaceId, probeEnabled]);

  // Listing existing apps never depends on the ability to CREATE one — a
  // stale/failed probe must not blank the explorer.
  useEffect(() => {
    if (workspaceId) {
      void fetchApps(workspaceId);
      void fetchFavourites(workspaceId);
    }
  }, [workspaceId, fetchApps, fetchFavourites]);

  // Green dots for live dev servers — discovery, refreshed while the
  // explorer is on screen.
  const appsLoaded = apps.length > 0;
  useEffect(() => {
    if (!workspaceId || !appsLoaded) return;
    void fetchRunningDevApps(workspaceId);
    const timer = setInterval(
      () => void fetchRunningDevApps(workspaceId),
      30_000,
    );
    return () => clearInterval(timer);
  }, [workspaceId, appsLoaded, fetchRunningDevApps]);

  const appById = useMemo(() => new Map(apps.map(a => [a.id, a])), [apps]);

  // App rows are directories whose children are the file tree — `undefined`
  // until fetched so ResourceTree shows the loading skeleton and fires
  // onLoadChildren.
  const appChildren = useCallback(
    (appId: string) =>
      filesByApp[appId] ? buildFileNodes(appId, filesByApp[appId]) : undefined,
    [filesByApp],
  );

  const sections = useMemo(() => {
    const treeApps = (list: AppMeta[]) =>
      list.map(a => ({
        id: a.id,
        title: a.title,
        path: appRootOf(a),
        access: a.access,
        owner_id: a.owner_id,
      }));
    const workspaceApps = apps.filter(
      a => (a.scope ?? "workspace") === "workspace",
    );
    const personalApps = personalRoot
      ? apps.filter(a => appRootOf(a).startsWith(`${personalRoot}/`))
      : [];
    const starredSection = buildStarredSection(
      favourites,
      "app",
      appId => {
        const app = appById.get(appId);
        return app
          ? {
              name: app.title,
              path: appRootOf(app),
              entityType: "app",
              access: app.access,
              owner_id: app.owner_id,
            }
          : undefined;
      },
      { droppable: true },
    );
    return [
      ...starredSection,
      {
        key: WORKSPACE_SECTION,
        label: "Workspace",
        icon: <GlobeIcon size={16} strokeWidth={1.5} />,
        nodes: buildAppTree({
          root: WORKSPACE_ROOT,
          folders,
          apps: treeApps(workspaceApps),
          appChildren,
        }),
        droppableId: "__section_workspace",
      },
      ...(personalRoot
        ? [
            {
              key: PERSONAL_SECTION,
              label: "Personal",
              icon: <UserIcon size={16} strokeWidth={1.5} />,
              nodes: buildAppTree({
                root: personalRoot,
                folders,
                apps: treeApps(personalApps),
                appChildren,
              }),
              droppableId: "__section_personal",
            },
          ]
        : []),
    ];
  }, [apps, folders, favourites, appById, appChildren, personalRoot]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const setError = useCallback((message: string) => {
    useAppsStore.setState(s => {
      s.error = message;
    });
  }, []);

  /** Where a target folder path may be written to by this person. */
  const mayWriteTo = useCallback(
    (folderPath: string): boolean => {
      if (
        personalRoot &&
        (folderPath === personalRoot ||
          folderPath.startsWith(`${personalRoot}/`))
      ) {
        return true;
      }
      if (!canOrganize) {
        setError("Only workspace editors can reorganise the Workspace tree.");
        return false;
      }
      return true;
    },
    [canOrganize, personalRoot, setError],
  );

  const handleToggleStar = useCallback(
    (appId: string, parentId: string | null = null) => {
      if (!workspaceId) return;
      void toggleFavourite(
        workspaceId,
        "app",
        appId,
        !starred.has(appId),
        parentId,
      );
    },
    [workspaceId, toggleFavourite, starred],
  );

  /** The folder an app or file row sits in (its parent directory). */
  const folderOfApp = useCallback(
    (appId: string): string | null => {
      const app = appById.get(appId);
      return app ? parentPathOf(appRootOf(app)) : null;
    },
    [appById],
  );

  /** A drop onto a section header: the root of that tree. */
  const handleSectionDrop = useCallback(
    (sectionKey: string, nodeId: string): boolean => {
      if (!workspaceId) return true;
      const dragged = parseNodeId(nodeId);
      if (sectionKey === STARRED_SECTION_KEY) {
        if (dragged.kind === "app") {
          const row = favouriteFor(favourites, "app", dragged.appId);
          if (row) void moveFavourite(workspaceId, row.id, null);
          else {
            void toggleFavourite(workspaceId, "app", dragged.appId, true, null);
          }
        } else if (dragged.kind === "starfolder") {
          void moveFavourite(workspaceId, dragged.favId, null);
        }
        return true;
      }
      const root =
        sectionKey === PERSONAL_SECTION ? personalRoot : WORKSPACE_ROOT;
      if (!root || !mayWriteTo(root)) return true;
      if (dragged.kind === "app" && !dragged.pinned) {
        if (folderOfApp(dragged.appId) !== root) {
          void moveApp(workspaceId, dragged.appId, root);
        }
      } else if (dragged.kind === "folder") {
        const to = `${root}/${basenameOf(dragged.folderPath)}`;
        if (to !== dragged.folderPath && mayWriteTo(dragged.folderPath)) {
          void moveAppFolder(workspaceId, dragged.folderPath, to);
        }
      }
      return true;
    },
    [
      workspaceId,
      favourites,
      moveFavourite,
      toggleFavourite,
      personalRoot,
      mayWriteTo,
      folderOfApp,
      moveApp,
      moveAppFolder,
    ],
  );

  /** A drop onto a row: file the dragged thing next to / inside it. */
  const handleMoveNode = useCallback(
    (nodeId: string, targetId: string | null) => {
      if (!workspaceId || !targetId) return;
      const dragged = parseNodeId(nodeId);
      const target = parseNodeId(targetId);

      // Destination: a git folder path, or a favourites folder id (null =
      // the Starred root when the target is a pinned row at the root).
      let destPath: string | null = null;
      let destFav: string | null | undefined;
      if (target.kind === "folder") destPath = target.folderPath;
      else if (target.kind === "starfolder") destFav = target.favId;
      else if (target.kind === "app" && target.pinned) {
        destFav =
          favouriteFor(favourites, "app", target.appId)?.parentId ?? null;
      } else if (target.kind === "app") destPath = folderOfApp(target.appId);
      else destPath = folderOfApp(target.appId);

      if (dragged.kind === "app") {
        if (destFav !== undefined) {
          const row = favouriteFor(favourites, "app", dragged.appId);
          if (row) void moveFavourite(workspaceId, row.id, destFav);
          else {
            void toggleFavourite(
              workspaceId,
              "app",
              dragged.appId,
              true,
              destFav,
            );
          }
          return;
        }
        // A pinned copy dragged into a real folder is a misdrop, not a move.
        if (dragged.pinned || !destPath) return;
        if (folderOfApp(dragged.appId) === destPath) return;
        if (!mayWriteTo(destPath)) return;
        const from = folderOfApp(dragged.appId);
        if (from && !mayWriteTo(from)) return;
        void moveApp(workspaceId, dragged.appId, destPath);
        return;
      }
      if (dragged.kind === "folder") {
        if (!destPath || destPath === dragged.folderPath) return;
        if (destPath.startsWith(`${dragged.folderPath}/`)) return;
        const to = `${destPath}/${basenameOf(dragged.folderPath)}`;
        if (!mayWriteTo(destPath) || !mayWriteTo(dragged.folderPath)) return;
        void moveAppFolder(workspaceId, dragged.folderPath, to);
        return;
      }
      if (dragged.kind === "starfolder" && destFav !== undefined) {
        if (destFav !== dragged.favId) {
          void moveFavourite(workspaceId, dragged.favId, destFav);
        }
      }
    },
    [
      workspaceId,
      favourites,
      folderOfApp,
      mayWriteTo,
      moveApp,
      moveAppFolder,
      moveFavourite,
      toggleFavourite,
    ],
  );

  const handleLoadChildren = useCallback(
    async (node: ResourceTreeNode) => {
      const parsed = parseNodeId(node.id);
      if (
        parsed.kind !== "app" ||
        parsed.pinned ||
        !workspaceId ||
        filesByApp[parsed.appId]
      ) {
        return;
      }
      setLoadingApps(prev => ({ ...prev, [parsed.appId]: true }));
      await fetchFiles(workspaceId, parsed.appId);
      setLoadingApps(prev => ({ ...prev, [parsed.appId]: false }));
    },
    [workspaceId, filesByApp, fetchFiles],
  );

  const handleItemClick = useCallback(
    (node: ResourceTreeNode) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind === "app") {
        const app = appById.get(parsed.appId);
        const ref = app ? appUrlRef(app) : undefined;
        focusAppsTab(
          parsed.appId,
          app?.title ?? node.name,
          ref && ref !== parsed.appId ? ref : undefined,
        );
        // Warm the file tree so expanding is instant.
        if (workspaceId && !filesByApp[parsed.appId]) {
          void fetchFiles(workspaceId, parsed.appId);
        }
      } else if (parsed.kind === "file") {
        const app = appById.get(parsed.appId);
        const ref = app ? appUrlRef(app) : undefined;
        focusAppsFileTab(
          parsed.appId,
          parsed.path,
          ref && ref !== parsed.appId ? ref : undefined,
        );
      }
    },
    [workspaceId, filesByApp, fetchFiles, appById],
  );

  const handleCreate = useCallback(async () => {
    if (!workspaceId || !newTitle.trim()) return;
    setCreating(true);
    const app = await createApp(
      workspaceId,
      newTitle.trim(),
      undefined,
      createFolder === WORKSPACE_ROOT ? undefined : createFolder,
    );
    setCreating(false);
    if (app) {
      setCreateOpen(false);
      setNewTitle("");
      const ref = appUrlRef(app);
      focusAppsTab(app.id, app.title, ref !== app.id ? ref : undefined);
      void fetchApps(workspaceId);
    }
  }, [workspaceId, newTitle, createFolder, createApp, fetchApps]);

  const handleDelete = useCallback(
    async (appId: string) => {
      if (!workspaceId) return;
      if (
        !(await confirm({
          title: "Delete this app?",
          body: "Its folder is removed from the workspace repo (history stays in git).",
          confirmLabel: "Delete",
          destructive: true,
        }))
      ) {
        return;
      }
      await deleteApp(workspaceId, appId);
      const consoleStore = useConsoleStore.getState();
      for (const tab of Object.values(consoleStore.tabs)) {
        if (
          (tab.kind === "app" || tab.kind === "app-file") &&
          tab.metadata?.appId === appId
        ) {
          consoleStore.closeTab(tab.id);
        }
      }
    },
    [workspaceId, deleteApp, confirm],
  );

  const handleDeleteFolder = useCallback(
    async (folderPath: string) => {
      if (!workspaceId || !mayWriteTo(folderPath)) return;
      if (
        !(await confirm({
          title: "Delete this folder?",
          body: "Only an empty folder can be deleted — move or delete the apps inside first.",
          confirmLabel: "Delete",
          destructive: true,
        }))
      ) {
        return;
      }
      await deleteAppFolder(workspaceId, folderPath);
    },
    [workspaceId, mayWriteTo, confirm, deleteAppFolder],
  );

  const handleDeleteStarFolder = useCallback(
    async (favId: string) => {
      if (!workspaceId) return;
      if (
        !(await confirm({
          title: "Remove this Starred folder?",
          body: "Its stars are removed too. The apps themselves are untouched.",
          confirmLabel: "Remove",
          destructive: true,
        }))
      ) {
        return;
      }
      await removeFavourite(workspaceId, favId);
    },
    [workspaceId, confirm, removeFavourite],
  );

  const handleDeleteNode = useCallback(
    (node: ResourceTreeNode) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind === "app" && parsed.pinned) {
        handleToggleStar(parsed.appId);
      } else if (parsed.kind === "app") void handleDelete(parsed.appId);
      else if (parsed.kind === "folder") {
        void handleDeleteFolder(parsed.folderPath);
      } else if (parsed.kind === "starfolder") {
        void handleDeleteStarFolder(parsed.favId);
      }
    },
    [
      handleToggleStar,
      handleDelete,
      handleDeleteFolder,
      handleDeleteStarFolder,
    ],
  );

  /** Inline rename (F2): folders only — an app row shows its title, not its folder. */
  const handleRename = useCallback(
    (id: string, name: string) => {
      if (!workspaceId) return;
      const parsed = parseNodeId(id);
      if (parsed.kind === "starfolder") {
        void renameFavourite(workspaceId, parsed.favId, name);
      } else if (parsed.kind === "folder") {
        const to = `${parentPathOf(parsed.folderPath)}/${name}`;
        if (to !== parsed.folderPath && mayWriteTo(parsed.folderPath)) {
          void moveAppFolder(workspaceId, parsed.folderPath, to);
        }
      }
    },
    [workspaceId, renameFavourite, mayWriteTo, moveAppFolder],
  );

  const submitFolderDialog = useCallback(
    async (name: string) => {
      if (!workspaceId || !folderDialog) return;
      setFolderBusy(true);
      try {
        if (folderDialog.favId) {
          await renameFavourite(workspaceId, folderDialog.favId, name);
        } else if (folderDialog.mode === "create") {
          if (!mayWriteTo(folderDialog.path)) return;
          if (
            await createAppFolder(workspaceId, `${folderDialog.path}/${name}`)
          ) {
            setExpandedFolders(prev => ({
              ...prev,
              [folderNodeId(folderDialog.path)]: true,
            }));
          }
        } else {
          const to = `${parentPathOf(folderDialog.path)}/${name}`;
          if (to !== folderDialog.path && mayWriteTo(folderDialog.path)) {
            await moveAppFolder(workspaceId, folderDialog.path, to);
          }
        }
        setFolderDialog(null);
      } finally {
        setFolderBusy(false);
      }
    },
    [
      workspaceId,
      folderDialog,
      renameFavourite,
      mayWriteTo,
      createAppFolder,
      moveAppFolder,
    ],
  );

  /** Starred folders are database rows: created on the spot, renamed inline. */
  const handleCreateStarFolder = useCallback(
    async (parentId: string | null) => {
      if (!workspaceId) return null;
      const row = await createFavouriteFolder(
        workspaceId,
        "New folder",
        parentId,
      );
      if (!row) return null;
      if (parentId) {
        setExpandedFolders(prev => ({
          ...prev,
          [starredFolderId(parentId)]: true,
        }));
      }
      return { id: starredFolderId(row.id), name: row.title ?? "New folder" };
    },
    [workspaceId, createFavouriteFolder],
  );

  const appMenuItems = useCallback(
    (appId: string, pinned: boolean, helpers: { closeMenu: () => void }) => {
      const app = appById.get(appId);
      const isStarred = starred.has(appId);
      const items = [
        <MenuItem
          key="star"
          onClick={() => {
            helpers.closeMenu();
            handleToggleStar(appId);
          }}
        >
          <ListItemIcon>
            <StarIcon size={16} fill={isStarred ? "currentColor" : "none"} />
          </ListItemIcon>
          {isStarred ? "Unstar" : "Star"}
        </MenuItem>,
        <MenuItem
          key="share"
          onClick={() => {
            helpers.closeMenu();
            setShareAppId(appId);
          }}
        >
          <ListItemIcon>
            <ShareMenuIcon size={16} />
          </ListItemIcon>
          Share…
        </MenuItem>,
      ];
      if (pinned) return items;
      items.push(
        <MenuItem
          key="env"
          onClick={() => {
            helpers.closeMenu();
            setEnvAppId(appId);
          }}
        >
          <ListItemIcon>
            <EnvIcon size={16} />
          </ListItemIcon>
          Environment variables…
        </MenuItem>,
      );
      if (app?.duplicateOf) {
        items.push(
          <MenuItem
            key="stamp"
            onClick={() => {
              helpers.closeMenu();
              if (workspaceId) void stampAppId(workspaceId, appId);
            }}
          >
            <ListItemIcon>
              <StampIcon size={16} />
            </ListItemIcon>
            Give this copy its own id
          </MenuItem>,
        );
      }
      items.push(
        <MenuItem
          key="delete"
          onClick={() => {
            helpers.closeMenu();
            void handleDelete(appId);
          }}
        >
          <ListItemIcon>
            <DeleteIcon size={16} />
          </ListItemIcon>
          Delete app
        </MenuItem>,
      );
      return items;
    },
    [appById, starred, handleToggleStar, workspaceId, stampAppId, handleDelete],
  );

  const folderMenuItems = useCallback(
    (folderPath: string, helpers: { closeMenu: () => void }) => [
      <MenuItem
        key="new-app"
        onClick={() => {
          helpers.closeMenu();
          setCreateFolder(folderPath);
          setCreateOpen(true);
        }}
      >
        <ListItemIcon>
          <AddIcon size={16} />
        </ListItemIcon>
        New app here…
      </MenuItem>,
      <MenuItem
        key="new-folder"
        onClick={() => {
          helpers.closeMenu();
          setFolderDialog({ mode: "create", path: folderPath });
        }}
      >
        <ListItemIcon>
          <FolderPlusIcon size={16} />
        </ListItemIcon>
        New folder…
      </MenuItem>,
      ...(folderPath !== WORKSPACE_ROOT && folderPath !== personalRoot
        ? [
            <MenuItem
              key="rename"
              onClick={() => {
                helpers.closeMenu();
                setFolderDialog({
                  mode: "rename",
                  path: folderPath,
                  initialName: basenameOf(folderPath),
                });
              }}
            >
              <ListItemIcon>
                <RenameIcon size={16} />
              </ListItemIcon>
              Rename…
            </MenuItem>,
            <MenuItem
              key="delete"
              onClick={() => {
                helpers.closeMenu();
                void handleDeleteFolder(folderPath);
              }}
            >
              <ListItemIcon>
                <DeleteIcon size={16} />
              </ListItemIcon>
              Delete folder
            </MenuItem>,
          ]
        : []),
    ],
    [personalRoot, handleDeleteFolder],
  );

  const starFolderMenuItems = useCallback(
    (favId: string, helpers: { closeMenu: () => void }) => {
      const row = favourites.find(f => f.id === favId);
      return [
        <MenuItem
          key="new-folder"
          onClick={() => {
            helpers.closeMenu();
            setFolderDialog({
              mode: "create",
              path: "",
              favId: undefined,
              initialName: "",
            });
            // A Starred subfolder is created on the spot; the dialog is not
            // needed. Mirror what the section header does.
            setFolderDialog(null);
            void handleCreateStarFolder(favId);
          }}
        >
          <ListItemIcon>
            <FolderPlusIcon size={16} />
          </ListItemIcon>
          New folder
        </MenuItem>,
        <MenuItem
          key="rename"
          onClick={() => {
            helpers.closeMenu();
            setFolderDialog({
              mode: "rename",
              path: "",
              favId,
              initialName: row?.title ?? "",
            });
          }}
        >
          <ListItemIcon>
            <RenameIcon size={16} />
          </ListItemIcon>
          Rename…
        </MenuItem>,
        <MenuItem
          key="delete"
          onClick={() => {
            helpers.closeMenu();
            void handleDeleteStarFolder(favId);
          }}
        >
          <ListItemIcon>
            <DeleteIcon size={16} />
          </ListItemIcon>
          Remove folder
        </MenuItem>,
      ];
    },
    [favourites, handleCreateStarFolder, handleDeleteStarFolder],
  );

  const getContextMenuItems = useCallback(
    (node: ResourceTreeNode, helpers: { closeMenu: () => void }) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind === "app") {
        return appMenuItems(parsed.appId, parsed.pinned, helpers);
      }
      if (parsed.kind === "folder") {
        return folderMenuItems(parsed.folderPath, helpers);
      }
      if (parsed.kind === "starfolder") {
        return starFolderMenuItems(parsed.favId, helpers);
      }
      return null;
    },
    [appMenuItems, folderMenuItems, starFolderMenuItems],
  );

  const getSectionContextMenuItems = useCallback(
    (sectionKey: string, helpers: { closeMenu: () => void }) => {
      if (sectionKey === STARRED_SECTION_KEY) {
        return [
          <MenuItem
            key="new-folder"
            onClick={() => {
              helpers.closeMenu();
              void handleCreateStarFolder(null);
            }}
          >
            <ListItemIcon>
              <FolderPlusIcon size={16} />
            </ListItemIcon>
            New folder
          </MenuItem>,
        ];
      }
      const root =
        sectionKey === PERSONAL_SECTION ? personalRoot : WORKSPACE_ROOT;
      if (!root) return null;
      return folderMenuItems(root, helpers);
    },
    [handleCreateStarFolder, personalRoot, folderMenuItems],
  );

  const shareApp = shareAppId ? apps.find(a => a.id === shareAppId) : null;
  const envApp = envAppId ? apps.find(a => a.id === envAppId) : null;

  const folderOptions = useMemo(() => {
    const out: Array<{ path: string; label: string }> = [
      { path: WORKSPACE_ROOT, label: "Workspace" },
      ...folders
        .filter(f => f.startsWith(`${WORKSPACE_ROOT}/`))
        .map(f => ({ path: f, label: folderLabel(f, personalRoot) })),
    ];
    if (personalRoot) {
      out.push({ path: personalRoot, label: "Personal" });
      out.push(
        ...folders
          .filter(f => f.startsWith(`${personalRoot}/`))
          .map(f => ({ path: f, label: folderLabel(f, personalRoot) })),
      );
    }
    return out;
  }, [folders, personalRoot]);

  const actions = (
    <>
      <Tooltip title={canCreate ? "New app" : "Link a GitHub repo first"}>
        <span>
          <IconButton
            size="small"
            disabled={!canCreate}
            onClick={() => {
              setCreateFolder(WORKSPACE_ROOT);
              setCreateOpen(true);
            }}
          >
            <AddIcon size={20} strokeWidth={2} />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Refresh">
        <IconButton
          size="small"
          disabled={loading || !workspaceId}
          onClick={() => {
            if (!workspaceId) return;
            void fetchApps(workspaceId);
            void fetchFavourites(workspaceId);
          }}
        >
          <RefreshIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
    </>
  );

  const hasAnything = apps.length > 0 || folders.length > 0;

  return (
    <>
      <ExplorerShell
        title="Apps"
        actions={actions}
        searchPlaceholder="Search apps and files..."
        error={error ?? favouritesError}
        onErrorClose={() => {
          clearError();
          clearFavouritesError();
        }}
        loading={loading && apps.length === 0}
      >
        {({ searchQuery }) => (
          <Box sx={{ display: "flex", flexDirection: "column" }}>
            {canCreate === false ? (
              <Box sx={{ p: 2 }}>
                <Typography variant="body2" color="text.secondary" gutterBottom>
                  Apps live in a GitHub repository. Link one to get started —
                  each app is a folder in the repo, everyone works on their own
                  branch, and publishing merges it back to the default branch.
                </Typography>
                <Button
                  variant="contained"
                  size="small"
                  startIcon={<LinkIcon size={16} />}
                  sx={{ mt: 1 }}
                  onClick={openGitHubSettings}
                >
                  Link a GitHub repo
                </Button>
              </Box>
            ) : !hasAnything && !loading ? (
              <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                No apps yet. Create one, or ask the agent to build one (Apps
                tools).
              </Typography>
            ) : (
              <>
                {activeAppId && filesTruncatedByApp[activeAppId] && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ px: 2, py: 0.5, display: "block" }}
                  >
                    Showing the first{" "}
                    {filesTruncatedByApp[activeAppId].shown.toLocaleString()}
                    {filesTruncatedByApp[activeAppId].total
                      ? ` of ${filesTruncatedByApp[activeAppId].total.toLocaleString()}`
                      : ""}{" "}
                    files — this app&apos;s tree is unusually large (a committed
                    node_modules?). Use the terminal or search instead of
                    browsing.
                  </Typography>
                )}
                <ResourceTree
                  enableDragDrop
                  onMoveItem={handleMoveNode}
                  onMoveFolder={handleMoveNode}
                  onSectionDrop={handleSectionDrop}
                  sections={sections}
                  mode="sidebar"
                  searchQuery={searchQuery}
                  activeItemId={activeItemId}
                  revealNodeId={reveal?.nodeId}
                  revealNonce={reveal?.nonce}
                  getRightAdornment={node => {
                    const parsed = parseNodeId(node.id);
                    if (parsed.kind !== "app") return null;
                    const app = appById.get(parsed.appId);
                    const slug = app?.slug;
                    const running = !!slug && runningDevApps.includes(slug);
                    const p = previewByApp[parsed.appId];
                    // Tri-state dot: amber while a boot is in flight, green
                    // when the box says it serves, red when the last start
                    // failed. Nothing → no dot.
                    const booting = !!p?.building;
                    const failed = !running && !booting && !!p?.error;
                    const dot =
                      running || booting || failed ? (
                        <Tooltip
                          title={
                            booting
                              ? "Dev server starting…"
                              : running
                                ? "Dev server running"
                                : "Last dev start failed"
                          }
                        >
                          <Box
                            component="span"
                            sx={{
                              width: 7,
                              height: 7,
                              borderRadius: "50%",
                              bgcolor: booting
                                ? "warning.main"
                                : running
                                  ? "success.main"
                                  : "error.main",
                              display: "inline-block",
                              flexShrink: 0,
                            }}
                          />
                        </Tooltip>
                      ) : null;
                    return (
                      <Box
                        component="span"
                        sx={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 0.5,
                        }}
                      >
                        {dot}
                        <StarToggle
                          starred={starred.has(parsed.appId)}
                          onToggle={() => handleToggleStar(parsed.appId)}
                        />
                      </Box>
                    );
                  }}
                  getItemIcon={(node, ctx) => {
                    const parsed = parseNodeId(node.id);
                    if (parsed.kind === "app") {
                      const state = resolveAccessState(node, userId);
                      // The overlay says who can see it, wherever the row
                      // sits — a folder header no longer does.
                      if (parsed.pinned || state !== "workspace") {
                        return (
                          <AccessIcon
                            Glyph={AppIcon}
                            state={
                              node.access === "private" &&
                              node.owner_id === userId &&
                              node.path?.startsWith("users/")
                                ? "private"
                                : state
                            }
                            kindLabel="App"
                          />
                        );
                      }
                      return <AppIcon size={16} strokeWidth={1.5} />;
                    }
                    if (parsed.kind === "file") {
                      return fileIcon(node.name, node.path ?? node.name);
                    }
                    return ctx?.isExpanded ? (
                      <FolderOpenIcon size={16} strokeWidth={1.5} />
                    ) : (
                      <FolderIcon size={16} strokeWidth={1.5} />
                    );
                  }}
                  onItemClick={handleItemClick}
                  shouldFolderClickActivate={node =>
                    parseNodeId(node.id).kind === "app"
                  }
                  onLoadChildren={node => void handleLoadChildren(node)}
                  isLoadingChildren={node => {
                    const parsed = parseNodeId(node.id);
                    return (
                      parsed.kind === "app" &&
                      !parsed.pinned &&
                      !!loadingApps[parsed.appId]
                    );
                  }}
                  getContextMenuItems={getContextMenuItems}
                  getSectionContextMenuItems={getSectionContextMenuItems}
                  onCreateFolder={parentId => {
                    // The tree's own "New Folder" reaches here only for the
                    // Starred tree (git folders go through the dialog).
                    const favId = parentId
                      ? favouriteIdFromFolderRow(parentId)
                      : null;
                    if (parentId && favId === null) {
                      return Promise.resolve(null);
                    }
                    return handleCreateStarFolder(favId);
                  }}
                  onRenameItem={handleRename}
                  onDeleteItem={handleDeleteNode}
                  enableRename
                  enableDelete
                  enableNewFolder={false}
                  isFolderExpanded={isFolderOpen}
                  onToggleFolder={key =>
                    setExpandedFolders(prev => ({ ...prev, [key]: !prev[key] }))
                  }
                  onExpandFolder={key =>
                    setExpandedFolders(prev => ({ ...prev, [key]: true }))
                  }
                />
              </>
            )}
          </Box>
        )}
      </ExplorerShell>

      <Dialog
        open={createOpen}
        onClose={() => !creating && setCreateOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>New app</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="Title"
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") void handleCreate();
            }}
            disabled={creating}
          />
          <TextField
            select
            fullWidth
            margin="dense"
            label="Folder"
            value={createFolder}
            onChange={e => setCreateFolder(e.target.value)}
            disabled={creating}
            slotProps={{ select: { native: true } }}
          >
            {folderOptions.map(o => (
              <option key={o.path} value={o.path}>
                {o.label}
              </option>
            ))}
          </TextField>
          <Typography variant="caption" color="text.secondary">
            {repos.length > 0
              ? `Creates a real Vite + React project in the connected GitHub repo (${repos[0].owner}/${repos[0].repo}).`
              : "Creates a real Vite + React project in the workspace repo."}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)} disabled={creating}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleCreate()}
            disabled={creating || !newTitle.trim()}
          >
            {creating ? "Creating..." : "Create"}
          </Button>
        </DialogActions>
      </Dialog>

      <FolderNameDialog
        open={!!folderDialog}
        title={folderDialog?.mode === "rename" ? "Rename folder" : "New folder"}
        parentLabel={
          folderDialog?.favId
            ? "Starred"
            : folderDialog
              ? folderLabel(
                  folderDialog.mode === "create"
                    ? folderDialog.path
                    : parentPathOf(folderDialog.path),
                  personalRoot,
                )
              : ""
        }
        initialName={folderDialog?.initialName}
        confirmLabel={folderDialog?.mode === "rename" ? "Rename" : "Create"}
        busy={folderBusy}
        onClose={() => !folderBusy && setFolderDialog(null)}
        onConfirm={submitFolderDialog}
      />

      {shareApp && (
        <ShareDialog
          open={!!shareAppId}
          onClose={() => setShareAppId(null)}
          resourceType="app"
          resourceId={shareApp.id}
          resourceName={shareApp.title}
          ownerId={shareApp.owner_id}
          access={shareApp.access ?? "workspace"}
          workspaceRole={shareApp.workspaceRole ?? "viewer"}
          publicShare={shareApp.publicShare}
          canManage={
            !shareApp.owner_id ||
            shareApp.owner_id === userId ||
            isWorkspaceAdmin
          }
          onSharingChanged={changes => {
            useAppsStore.setState(s => {
              const app = s.apps.find(a => a.id === shareApp.id);
              if (!app) return;
              if (changes.access) app.access = changes.access;
              if (changes.workspaceRole) {
                app.workspaceRole = changes.workspaceRole;
              }
              if (changes.publicShare) {
                app.publicShare = changes.publicShare;
              }
            });
            if (workspaceId) void fetchApps(workspaceId);
          }}
        />
      )}

      {envApp && workspaceId && (
        <AppEnvDialog
          open={!!envAppId}
          onClose={() => setEnvAppId(null)}
          workspaceId={workspaceId}
          appId={envApp.id}
          appTitle={envApp.title}
        />
      )}
    </>
  );
}
