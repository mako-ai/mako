/**
 * Apps explorer — drill-down tree of git-backed apps (the legacy explorer
 * parity): each app is a directory node whose children are its file tree
 * (loaded lazily from the durable worktree API), folders expand in place,
 * and every file opens in its own editor tab.
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
  Users as SharedIcon,
  User as UserIcon,
  Braces as JsonFileIcon,
  Database as BindingIcon,
  File as PlainFileIcon,
  FileCode as CodeFileIcon,
  FileText as TextFileIcon,
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  KeyRound as EnvIcon,
  Plus as AddIcon,
  Github as LinkIcon,
  RefreshCw as RefreshIcon,
  Trash2 as DeleteIcon,
  UserPlus as ShareMenuIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useConsoleStore,
  selectTabBySettingsSection,
} from "../store/consoleStore";
import { SECTION_LABELS } from "../pages/settings/sections";
import { useAppsStore, type AppFileEntry } from "../store/appsStore";
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
import ExplorerShell from "./ExplorerShell";
import ResourceTree, { type ResourceTreeNode } from "./ResourceTree";
import { useConfirm } from "./ConfirmDialog";

const AppIcon = TAB_KIND_ICONS["app"];

type ParsedNode =
  | { kind: "app"; appId: string; path: "" }
  | { kind: "dir" | "file"; appId: string; path: string };

function parseNodeId(id: string): ParsedNode {
  if (id.includes(APP_FILE_SEP)) {
    const [appId, path] = id.split(APP_FILE_SEP);
    return { kind: "file", appId, path };
  }
  if (id.includes(APP_DIR_SEP)) {
    const [appId, path] = id.split(APP_DIR_SEP);
    return { kind: "dir", appId, path };
  }
  return { kind: "app", appId: id, path: "" };
}

/** Build nested folder/file nodes for one app. */
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
  if (/^(apps\/[^/]+\/)?bindings\//.test(path) && name.endsWith(".sql")) {
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

export default function AppsExplorer() {
  const { currentWorkspace } = useWorkspace();
  const confirm = useConfirm();
  const workspaceId = currentWorkspace?.id;

  const apps = useAppsStore(s => s.apps);
  const { user } = useAuth();
  const userId = user?.id;
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
  const setAppAccess = useAppsStore(s => s.setAppAccess);
  const fetchFiles = useAppsStore(s => s.fetchFiles);
  const createApp = useAppsStore(s => s.createApp);
  const deleteApp = useAppsStore(s => s.deleteApp);
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
  // (or one of its files) is currently focused, same as Transforms' single
  // "active project" scoping for its Version control section.
  const activeAppId = useMemo(() => {
    if (activeTab?.kind === "app" || activeTab?.kind === "app-file") {
      return (activeTab.metadata?.appId as string) ?? undefined;
    }
    return undefined;
  }, [activeTab]);

  const editingByApp = useAppsStore(s => s.editingByApp);

  const reveal = useExplorerRevealStore(selectRevealFor("apps"));

  const [loadingApps, setLoadingApps] = useState<Record<string, boolean>>({});
  // Synthetic org/repo mount nodes default OPEN (their ids are dynamic, so
  // the default lives in the lookup, not the initial state).
  const [expandedFolders, setExpandedFolders] = useState<
    Record<string, boolean>
  >({});
  const isFolderOpen = useCallback(
    (key: string) => expandedFolders[key] ?? false,
    [expandedFolders],
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [shareAppId, setShareAppId] = useState<string | null>(null);
  const [envAppId, setEnvAppId] = useState<string | null>(null);
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
    if (workspaceId) void fetchApps(workspaceId);
  }, [workspaceId, fetchApps]);

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

  // App rows are directories whose children are the file tree — `undefined`
  // until fetched so ResourceTree shows the loading skeleton and fires
  // onLoadChildren (same contract as the legacy apps explorer).
  const sections = useMemo(() => {
    const appNodes = apps.map(app => ({
      id: app.id,
      name: app.title,
      path: app.id,
      isDirectory: true,
      children: filesByApp[app.id]
        ? buildFileNodes(app.id, filesByApp[app.id])
        : undefined,
    }));
    // §10 monorepo: ONE repo per workspace — the repo is not a tree level.
    // Three sections. "My Apps" and "Workspace" split by access, kept from
    // the v1 rail; "Shared with me" is the private apps someone ELSE
    // restricted and then shared with you personally — splitting by access
    // alone filed those under "My Apps", next to apps you own, which read as
    // "mine" while they were Vadim's. Access is organization, not security
    // (§11.5): builders with repo access see all folders either way.
    const byId = new Map(apps.map(a => [a.id, a]));
    const isWorkspace = (id: string) =>
      (byId.get(id)?.access ?? "workspace") === "workspace";
    // No owner recorded (a row older than owner tracking) counts as yours —
    // the old behaviour, so nothing silently moves out of "My Apps".
    const isSharedWithMe = (id: string) => {
      const owner = byId.get(id)?.owner_id;
      return !isWorkspace(id) && !!owner && !!userId && owner !== userId;
    };
    const mine = appNodes.filter(
      n => !isWorkspace(n.id) && !isSharedWithMe(n.id),
    );
    const sharedWithMe = appNodes.filter(n => isSharedWithMe(n.id));
    const shared = appNodes.filter(n => isWorkspace(n.id));
    return [
      {
        key: "my",
        label: "My Apps",
        icon: <UserIcon size={16} strokeWidth={1.5} />,
        nodes: mine,
        droppableId: "__section_my",
        defaultAccess: "private" as const,
      },
      // Not a drop target: only the owner can change these apps' sharing, so
      // there is nothing a drop here could legitimately do.
      ...(sharedWithMe.length > 0
        ? [
            {
              key: "shared-with-me",
              label: "Shared with me",
              icon: <SharedIcon size={16} strokeWidth={1.5} />,
              nodes: sharedWithMe,
            },
          ]
        : []),
      {
        key: "workspace",
        label: "Workspace",
        icon: <GlobeIcon size={16} strokeWidth={1.5} />,
        nodes: shared,
        droppableId: "__section_workspace",
        defaultAccess: "workspace" as const,
      },
    ];
  }, [apps, filesByApp, userId]);

  // Drag an app onto the other section (or any node inside it) to flip its
  // sharing. Drops within the same section no-op.
  const handleMoveNode = useCallback(
    (nodeId: string, targetId: string | null, access?: string) => {
      if (!workspaceId) return;
      const parsed = parseNodeId(nodeId);
      if (parsed.kind !== "app") return;
      // Someone else's private app, shared with you: the API refuses to
      // change its sharing for anyone but the owner, so don't ask.
      const dragged = apps.find(a => a.id === parsed.appId);
      if (
        dragged?.access === "private" &&
        dragged.owner_id &&
        userId &&
        dragged.owner_id !== userId
      ) {
        return;
      }
      const accessOf = (appId: string) =>
        (apps.find(a => a.id === appId)?.access ?? "workspace") === "workspace"
          ? "workspace"
          : "private";
      let next: "private" | "workspace" | null =
        access === "private" || access === "workspace" ? access : null;
      if (!next && targetId) {
        const target = parseNodeId(targetId);
        if (target.kind === "app" || target.kind === "file") {
          next = accessOf(target.appId);
        }
      }
      if (!next || accessOf(parsed.appId) === next) return;
      void setAppAccess(workspaceId, parsed.appId, next);
    },
    [workspaceId, apps, setAppAccess, userId],
  );

  const handleLoadChildren = useCallback(
    async (node: ResourceTreeNode) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind !== "app" || !workspaceId || filesByApp[parsed.appId]) {
        return;
      }
      setLoadingApps(prev => ({ ...prev, [parsed.appId]: true }));
      // Live only while editing: the sandbox is already running then, and its
      // uncommitted work is exactly what the tree would otherwise be missing.
      await fetchFiles(workspaceId, parsed.appId);
      setLoadingApps(prev => ({ ...prev, [parsed.appId]: false }));
    },
    [workspaceId, filesByApp, fetchFiles, editingByApp],
  );

  const handleItemClick = useCallback(
    (node: ResourceTreeNode) => {
      const parsed = parseNodeId(node.id);
      const slug = apps.find(a => a.id === parsed.appId)?.slug;
      if (parsed.kind === "app") {
        focusAppsTab(parsed.appId, node.name, slug);
        // Warm the file tree so expanding is instant.
        if (workspaceId && !filesByApp[parsed.appId]) {
          void fetchFiles(workspaceId, parsed.appId);
        }
      } else if (parsed.kind === "file") {
        focusAppsFileTab(parsed.appId, parsed.path, slug);
      }
    },
    [workspaceId, filesByApp, fetchFiles, editingByApp, apps],
  );

  const handleCreate = useCallback(async () => {
    if (!workspaceId || !newTitle.trim()) return;
    setCreating(true);
    const app = await createApp(workspaceId, newTitle.trim());
    setCreating(false);
    if (app) {
      setCreateOpen(false);
      setNewTitle("");
      focusAppsTab(app.id, app.title, app.slug);
    }
  }, [workspaceId, newTitle, createApp]);

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

  const getContextMenuItems = useCallback(
    (node: ResourceTreeNode, helpers: { closeMenu: () => void }) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind !== "app") return null;
      return [
        <MenuItem
          key="share"
          onClick={() => {
            helpers.closeMenu();
            setShareAppId(parsed.appId);
          }}
        >
          <ListItemIcon>
            <ShareMenuIcon size={16} />
          </ListItemIcon>
          Share…
        </MenuItem>,
        <MenuItem
          key="env"
          onClick={() => {
            helpers.closeMenu();
            setEnvAppId(parsed.appId);
          }}
        >
          <ListItemIcon>
            <EnvIcon size={16} />
          </ListItemIcon>
          Environment variables…
        </MenuItem>,
        <MenuItem
          key="delete"
          onClick={() => {
            helpers.closeMenu();
            void handleDelete(parsed.appId);
          }}
        >
          <ListItemIcon>
            <DeleteIcon size={16} />
          </ListItemIcon>
          Delete app
        </MenuItem>,
      ];
    },
    [handleDelete],
  );

  const shareApp = shareAppId ? apps.find(a => a.id === shareAppId) : null;
  const envApp = envAppId ? apps.find(a => a.id === envAppId) : null;

  const actions = (
    <>
      <Tooltip title={canCreate ? "New app" : "Link a GitHub repo first"}>
        <span>
          <IconButton
            size="small"
            disabled={!canCreate}
            onClick={() => setCreateOpen(true)}
          >
            <AddIcon size={20} strokeWidth={2} />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Refresh">
        <IconButton
          size="small"
          disabled={loading || !workspaceId}
          onClick={() => workspaceId && fetchApps(workspaceId)}
        >
          <RefreshIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
    </>
  );

  return (
    <>
      <ExplorerShell
        title="Apps"
        actions={actions}
        searchPlaceholder="Search apps and files..."
        error={error}
        onErrorClose={clearError}
        loading={loading && apps.length === 0}
      >
        {({ searchQuery }) => (
          <Box sx={{ display: "flex", flexDirection: "column" }}>
            {canCreate === false ? (
              <Box sx={{ p: 2 }}>
                <Typography variant="body2" color="text.secondary" gutterBottom>
                  Apps apps live in a GitHub repository. Link one to get started
                  — each app is a folder in the repo, everyone works on their
                  own branch, and publishing merges it back to the default
                  branch.
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
            ) : apps.length === 0 && !loading ? (
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
                  sections={sections}
                  mode="sidebar"
                  searchQuery={searchQuery}
                  activeItemId={activeItemId}
                  revealNodeId={reveal?.nodeId}
                  revealNonce={reveal?.nonce}
                  getRightAdornment={node => {
                    const parsed = parseNodeId(node.id);
                    if (parsed.kind !== "app") return null;
                    const slug = apps.find(a => a.id === parsed.appId)?.slug;
                    const running = !!slug && runningDevApps.includes(slug);
                    const p = previewByApp[parsed.appId];
                    // Tri-state dot: amber while a boot is in flight, green
                    // when the box says it serves, red when the last start
                    // failed. Nothing → no dot.
                    const booting = !!p?.building;
                    const failed = !running && !booting && !!p?.error;
                    if (!running && !booting && !failed) return null;
                    const [color, title] = booting
                      ? ["warning.main", "Dev server starting…"]
                      : running
                        ? ["success.main", "Dev server running"]
                        : ["error.main", "Last dev start failed"];
                    return (
                      <Tooltip title={title}>
                        <Box
                          component="span"
                          sx={{
                            width: 7,
                            height: 7,
                            borderRadius: "50%",
                            bgcolor: color,
                            display: "inline-block",
                            flexShrink: 0,
                          }}
                        />
                      </Tooltip>
                    );
                  }}
                  getItemIcon={(node, ctx) => {
                    const kind = parseNodeId(node.id).kind;
                    if (kind === "app") {
                      return <AppIcon size={16} strokeWidth={1.5} />;
                    }
                    if (kind === "file") {
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
                    return parsed.kind === "app" && !!loadingApps[parsed.appId];
                  }}
                  getContextMenuItems={getContextMenuItems}
                  enableRename={false}
                  enableDelete={false}
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
        <DialogTitle>New Apps app</DialogTitle>
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
          <Typography variant="caption" color="text.secondary">
            {repos.length > 0
              ? `Creates a real Vite + React project in the connected GitHub repo (${repos[0].owner}/${repos[0].repo}).`
              : "Creates a real Vite + React project in Mako-hosted cloud storage — no GitHub setup needed."}
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
            // A folder-only app gets its row (and a real id) on first share;
            // the list is the only place that learns about it.
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
