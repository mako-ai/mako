/**
 * Apps explorer — three trees over the workspace repo's apps.
 *
 * - **Starred**: this person's favourites, in folders of their own. A star is
 *   a shortcut, never a move; folders here are bookmark folders, kept in the
 *   database, instant, no commit.
 * - **Personal**: this person's own apps under `users/<handle>/apps/`,
 *   visible to nobody else — first, since new apps start here.
 * - **Workspace**: the real `apps/` tree of the repo. Folders are directories;
 *   dragging an app into one is a `git mv` on main (editors only). The app
 *   keeps its id, so its tab, deployment, sharing and everyone's stars
 *   follow it and nothing rebuilds.
 *
 * Each app is a directory node whose children are its file tree (loaded
 * lazily from the durable worktree API); every file opens in its own editor
 * tab. Sharing is changed from the Share dialog, not by dragging.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, IconButton, Tooltip, Typography } from "@mui/material";
import { Plus as AddIcon, RefreshCw as RefreshIcon } from "lucide-react";
import LinkIcon from "./icons/GithubIcon";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useConsoleStore,
  selectTabBySettingsSection,
} from "../store/consoleStore";
import { SECTION_LABELS } from "../pages/settings/sections";
import {
  appUrlRef,
  devServerKeyMatches,
  useAppsStore,
} from "../store/appsStore";
import {
  selectFavourites,
  starredRefs,
  useFavouritesStore,
} from "../store/favouritesStore";
import { useAuth } from "../contexts/auth-context";
import { useIsWorkspaceAdmin } from "../hooks/useIsWorkspaceAdmin";
import ShareDialog from "./ShareDialog";
import AppEnvDialog from "./AppEnvDialog";
import ShareWithWorkspaceDialog from "./ShareWithWorkspaceDialog";
import {
  useExplorerRevealStore,
  selectRevealFor,
} from "../store/explorerRevealStore";
import { APP_FILE_SEP } from "../lib/explorer-reveal";
import { folderNodeId, parentPathOf } from "../lib/apps-explorer-tree";
import ExplorerShell from "./ExplorerShell";
import ResourceTree, { type ResourceTreeNode } from "./ResourceTree";
import { useConfirm } from "./ConfirmDialog";
import {
  favouriteIdFromFolderRow,
  starredFolderId,
} from "./starred/starred-section";
import {
  FolderNameDialog,
  isValidFolderName,
} from "./apps-explorer/AppFolderDialogs";
import {
  selectDiscovery,
  useAppsDiscoveryStore,
} from "../store/appsDiscoveryStore";
import {
  focusAppsFileTab,
  focusAppsHomeTab,
  focusAppsTab,
} from "../apps-runtime/shell";
import { whenAppOpenSettled } from "../lib/app-open-gate";
import {
  AppsHomeIcon,
  WORKSPACE_ROOT,
  buildFileNodes,
  folderLabel,
  folderOptionsFor,
  parseNodeId,
  type FolderDialogState,
} from "./apps-explorer/node-model";
import { buildAppsSections } from "./apps-explorer/build-sections";
import { useAppsTreeActions } from "./apps-explorer/useAppsTreeActions";
import { useAppsExplorerMenus } from "./apps-explorer/AppsExplorerMenus";
import {
  AppRowAdornment,
  appsTreeItemIcon,
} from "./apps-explorer/AppRowDecorations";
import { CreateAppDialog } from "./apps-explorer/CreateAppDialog";

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
  // Named by the person's handle, which only the server knows (GET /apps).
  const personalRoot = useAppsStore(s => s.personalRoot);
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
  const shareAppWithWorkspace = useAppsStore(s => s.shareAppWithWorkspace);

  const favourites = useFavouritesStore(selectFavourites(workspaceId));
  const fetchFavourites = useFavouritesStore(s => s.fetch);
  const createFavouriteFolder = useFavouritesStore(s => s.createFolder);
  const renameFavourite = useFavouritesStore(s => s.rename);
  const removeFavourite = useFavouritesStore(s => s.remove);
  const favouritesError = useFavouritesStore(s => s.error);
  const clearFavouritesError = useFavouritesStore(s => s.clearError);
  const starred = useMemo(() => starredRefs(favourites, "app"), [favourites]);

  // Recently viewed + Popular come from the usage API; until it is deployed
  // both 404 and their sections simply do not render.
  const discovery = useAppsDiscoveryStore(selectDiscovery(workspaceId));
  const fetchUsage = useAppsDiscoveryStore(s => s.fetchUsage);
  const fetchRecent = useAppsDiscoveryStore(s => s.fetchRecent);

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
  const [shareWsAppId, setShareWsAppId] = useState<string | null>(null);
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
      void fetchUsage(workspaceId);
      void fetchRecent(workspaceId);
    }
  }, [workspaceId, fetchApps, fetchFavourites, fetchUsage, fetchRecent]);

  // Green dots for live dev servers — discovery, refreshed while the
  // explorer is on screen.
  const appsLoaded = apps.length > 0;
  useEffect(() => {
    if (!workspaceId || !appsLoaded) return;
    // A sandbox round trip (4.8 s on prod): not ahead of the app being opened.
    let cancelled = false;
    void whenAppOpenSettled().then(() => {
      if (!cancelled) void fetchRunningDevApps(workspaceId);
    });
    const timer = setInterval(
      () => void fetchRunningDevApps(workspaceId),
      30_000,
    );
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
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

  const sections = useMemo(
    () =>
      buildAppsSections({
        apps,
        folders,
        favourites,
        appById,
        appChildren,
        personalRoot,
        userId,
        discovery,
      }),
    [
      apps,
      folders,
      favourites,
      appById,
      appChildren,
      personalRoot,
      userId,
      discovery,
    ],
  );

  const {
    isSharedWithMe,
    mayWriteTo,
    handleToggleStar,
    folderOfApp,
    handleSectionDrop,
    handleMoveNode,
  } = useAppsTreeActions({
    workspaceId,
    userId,
    personalRoot,
    canOrganize,
    appById,
    starred,
    favourites,
  });

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
      if (parsed.kind === "app" && parsed.shortcut) return;
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

  /**
   * Inline rename (F2 / double-click): a git folder, a Starred folder, or an
   * app row — which renames the app's FOLDER (its slug) in place, the one
   * name the row can honestly change; the title lives in mako.json.
   */
  const handleRename = useCallback(
    (id: string, name: string) => {
      if (!workspaceId) return;
      const parsed = parseNodeId(id);
      if (parsed.kind === "starfolder") {
        void renameFavourite(workspaceId, parsed.favId, name);
        return;
      }
      // Git folders and app folders: the same name rule as the server's
      // isSafeSegment — a value it would refuse is dropped here, silently
      // (the row simply keeps its name), rather than becoming a 400.
      if (!isValidFolderName(name)) return;
      if (parsed.kind === "folder") {
        const to = `${parentPathOf(parsed.folderPath)}/${name}`;
        if (to !== parsed.folderPath && mayWriteTo(parsed.folderPath)) {
          void moveAppFolder(workspaceId, parsed.folderPath, to);
        }
      } else if (parsed.kind === "app" && !parsed.pinned) {
        const app = appById.get(parsed.appId);
        const folder = folderOfApp(parsed.appId);
        if (!app || !folder || isSharedWithMe(parsed.appId)) return;
        if (name !== app.slug && mayWriteTo(folder)) {
          void moveApp(workspaceId, parsed.appId, folder, name);
        }
      }
    },
    [
      workspaceId,
      renameFavourite,
      mayWriteTo,
      moveAppFolder,
      moveApp,
      appById,
      folderOfApp,
      isSharedWithMe,
    ],
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

  const { getContextMenuItems, getSectionContextMenuItems } =
    useAppsExplorerMenus({
      workspaceId,
      user,
      isWorkspaceAdmin,
      personalRoot,
      appById,
      starred,
      favourites,
      handleToggleStar,
      handleDelete,
      handleDeleteFolder,
      handleCreateStarFolder,
      handleDeleteStarFolder,
      setShareAppId,
      setEnvAppId,
      setShareWsAppId,
      setCreateFolder,
      setCreateOpen,
      setFolderDialog,
    });

  const shareApp = shareAppId ? apps.find(a => a.id === shareAppId) : null;
  const shareWsApp = shareWsAppId
    ? apps.find(a => a.id === shareWsAppId)
    : null;
  const envApp = envAppId ? apps.find(a => a.id === envAppId) : null;

  const folderOptions = useMemo(
    () => folderOptionsFor(folders, personalRoot),
    [folders, personalRoot],
  );

  const actions = (
    <>
      <Tooltip title="Apps home">
        <IconButton size="small" onClick={() => focusAppsHomeTab()}>
          <AppsHomeIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
      <Tooltip title={canCreate ? "New app" : "Link a GitHub repo first"}>
        <span>
          <IconButton
            size="small"
            disabled={!canCreate}
            onClick={() => {
              // Personal by default: sharing with the workspace is a
              // deliberate move, not where a new app starts.
              setCreateFolder(personalRoot ?? WORKSPACE_ROOT);
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
            void fetchUsage(workspaceId);
            void fetchRecent(workspaceId);
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
                <Typography
                  variant="body2"
                  gutterBottom
                  sx={{
                    color: "text.secondary",
                  }}
                >
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
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                  p: 2,
                }}
              >
                No apps yet. Create one, or ask the agent to build one (Apps
                tools).
              </Typography>
            ) : (
              <>
                {activeAppId && filesTruncatedByApp[activeAppId] && (
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                      px: 2,
                      py: 0.5,
                      display: "block",
                    }}
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
                    const p = previewByApp[parsed.appId];
                    return (
                      <AppRowAdornment
                        running={
                          !!app &&
                          runningDevApps.some(k => devServerKeyMatches(k, app))
                        }
                        booting={!!p?.building}
                        lastStartFailed={!!p?.error}
                        starred={starred.has(parsed.appId)}
                        onToggleStar={() => handleToggleStar(parsed.appId)}
                      />
                    );
                  }}
                  getItemIcon={(node, ctx) =>
                    appsTreeItemIcon(node, ctx, userId, {
                      workspaceId,
                      byId: appById,
                    })
                  }
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
                  // An app row displays its TITLE but renames its FOLDER
                  // (the slug); editing the visible title must not git-mv
                  // the directory to "Daily tracker v2".
                  getRenameSeed={node => {
                    const parsed = parseNodeId(node.id);
                    if (parsed.kind === "app" && !parsed.pinned) {
                      return appById.get(parsed.appId)?.slug ?? node.name;
                    }
                    return node.name;
                  }}
                  onDeleteItem={handleDeleteNode}
                  // Rename, delete and drag act on folders and app rows. A
                  // file or directory INSIDE an app has no handler (the editor
                  // owns files), and a shared app is the owner's to arrange.
                  canManageItem={node => {
                    const parsed = parseNodeId(node.id);
                    if (parsed.kind === "file" || parsed.kind === "dir") {
                      return false;
                    }
                    if (parsed.kind === "app" && parsed.shortcut) return false;
                    if (parsed.kind === "app" && !parsed.pinned) {
                      return !isSharedWithMe(parsed.appId);
                    }
                    return true;
                  }}
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

      <CreateAppDialog
        open={createOpen}
        creating={creating}
        title={newTitle}
        onTitleChange={setNewTitle}
        folder={createFolder}
        onFolderChange={setCreateFolder}
        folderOptions={folderOptions}
        repo={repos[0]}
        onClose={() => setCreateOpen(false)}
        onCreate={() => void handleCreate()}
      />

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

      {shareWsApp && workspaceId && (
        <ShareWithWorkspaceDialog
          open={!!shareWsAppId}
          appTitle={shareWsApp.title}
          initialDescription={shareWsApp.description}
          onClose={() => setShareWsAppId(null)}
          onSubmit={description =>
            shareAppWithWorkspace(workspaceId, shareWsApp.id, description)
          }
        />
      )}

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
          chatEnabled={shareApp.chatEnabled === true}
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
              if (changes.chatEnabled !== undefined) {
                app.chatEnabled = changes.chatEnabled;
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
