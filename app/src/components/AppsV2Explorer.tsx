/**
 * Apps v2 explorer — drill-down tree of git-backed apps (v1 AppsExplorer
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
  Braces as JsonFileIcon,
  Database as BindingIcon,
  File as PlainFileIcon,
  FileCode as CodeFileIcon,
  FileText as TextFileIcon,
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  Plus as AddIcon,
  Github as LinkIcon,
  RefreshCw as RefreshIcon,
  Trash2 as DeleteIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useConsoleStore,
  selectTabBySettingsSection,
} from "../store/consoleStore";
import { SECTION_LABELS } from "../pages/settings/sections";
import { useAppsV2Store, type AppV2FileEntry } from "../store/appsV2Store";
import { focusAppsV2FileTab, focusAppsV2Tab } from "../apps-v2-runtime/shell";
import {
  useExplorerRevealStore,
  selectRevealFor,
} from "../store/explorerRevealStore";
import { APP_DIR_SEP, APP_FILE_SEP } from "../lib/explorer-reveal";
import { TAB_KIND_ICONS } from "../lib/entity-icons";
import ExplorerShell from "./ExplorerShell";
import ResourceTree, { type ResourceTreeNode } from "./ResourceTree";

const AppIcon = TAB_KIND_ICONS["app-v2"];

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

/** Build nested folder/file nodes for one app (mirrors v1 buildAppFileNodes). */
// Per-extension file icons — the same mapping as v1's AppsExplorer, so the
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
  files: AppV2FileEntry[],
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

export default function AppsV2Explorer() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const apps = useAppsV2Store(s => s.apps);
  const loading = useAppsV2Store(s => s.appsLoading);
  const error = useAppsV2Store(s => s.error);
  const clearError = useAppsV2Store(s => s.clearError);
  const canCreate = useAppsV2Store(s => s.canCreate);
  const repos = useAppsV2Store(s => s.repos);
  const probeEnabled = useAppsV2Store(s => s.probeEnabled);
  const filesByApp = useAppsV2Store(s => s.filesByApp);
  const runningDevApps = useAppsV2Store(s => s.runningDevApps);
  const previewByApp = useAppsV2Store(s => s.previewByApp);
  const fetchRunningDevApps = useAppsV2Store(s => s.fetchRunningDevApps);
  const filesTruncatedByApp = useAppsV2Store(s => s.filesTruncatedByApp);
  const fetchApps = useAppsV2Store(s => s.fetchApps);
  const fetchFiles = useAppsV2Store(s => s.fetchFiles);
  const createApp = useAppsV2Store(s => s.createApp);
  const deleteApp = useAppsV2Store(s => s.deleteApp);
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
    if (activeTab?.kind === "app-v2") {
      return (activeTab.metadata?.appV2Id as string) ?? null;
    }
    if (activeTab?.kind === "app-v2-file") {
      return `${activeTab.metadata?.appV2Id}${APP_FILE_SEP}${activeTab.metadata?.path}`;
    }
    return null;
  }, [activeTab]);

  // The app whose version control this sidebar shows — whichever app-v2 tab
  // (or one of its files) is currently focused, same as Transforms' single
  // "active project" scoping for its Version control section.
  const activeAppId = useMemo(() => {
    if (activeTab?.kind === "app-v2" || activeTab?.kind === "app-v2-file") {
      return (activeTab.metadata?.appV2Id as string) ?? undefined;
    }
    return undefined;
  }, [activeTab]);

  const editingByApp = useAppsV2Store(s => s.editingByApp);

  const reveal = useExplorerRevealStore(selectRevealFor("apps-v2"));

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
  // onLoadChildren (same contract as the v1 apps explorer).
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
    // The rail lists apps directly (org/repo grouping died with N-repos).
    return [
      {
        key: "apps",
        label: "Apps",
        nodes: appNodes,
        hideSectionHeader: true,
      },
    ];
  }, [apps, filesByApp]);

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
      if (parsed.kind === "app") {
        focusAppsV2Tab(parsed.appId, node.name);
        // Warm the file tree so expanding is instant.
        if (workspaceId && !filesByApp[parsed.appId]) {
          void fetchFiles(workspaceId, parsed.appId);
        }
      } else if (parsed.kind === "file") {
        focusAppsV2FileTab(parsed.appId, parsed.path);
      }
    },
    [workspaceId, filesByApp, fetchFiles, editingByApp],
  );

  const handleCreate = useCallback(async () => {
    if (!workspaceId || !newTitle.trim()) return;
    setCreating(true);
    const app = await createApp(workspaceId, newTitle.trim());
    setCreating(false);
    if (app) {
      setCreateOpen(false);
      setNewTitle("");
      focusAppsV2Tab(app.id, app.title);
    }
  }, [workspaceId, newTitle, createApp]);

  const handleDelete = useCallback(
    async (appId: string) => {
      if (!workspaceId) return;
      if (
        !window.confirm(
          "Delete this app? Its folder is removed from the workspace repo (history stays in git).",
        )
      ) {
        return;
      }
      await deleteApp(workspaceId, appId);
      const consoleStore = useConsoleStore.getState();
      for (const tab of Object.values(consoleStore.tabs)) {
        if (
          (tab.kind === "app-v2" || tab.kind === "app-v2-file") &&
          tab.metadata?.appV2Id === appId
        ) {
          consoleStore.closeTab(tab.id);
        }
      }
    },
    [workspaceId, deleteApp],
  );

  const getContextMenuItems = useCallback(
    (node: ResourceTreeNode, helpers: { closeMenu: () => void }) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind !== "app") return null;
      return [
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
        title="Apps v2"
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
                  Apps v2 apps live in a GitHub repository. Link one to get
                  started — each app is a folder in the repo, everyone works on
                  their own branch, and publishing merges it back to the default
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
                No apps yet. Create one, or ask the agent to build one (Apps v2
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
        <DialogTitle>New Apps v2 app</DialogTitle>
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
    </>
  );
}
