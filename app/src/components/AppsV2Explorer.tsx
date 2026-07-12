/**
 * Apps v2 explorer — drill-down tree of git-backed apps (v1 AppsExplorer
 * parity): each app is a directory node whose children are its file tree
 * (loaded lazily from the durable worktree API), folders expand in place,
 * and every file opens in its own editor tab.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
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
  Plus as AddIcon,
  RefreshCw as RefreshIcon,
  Trash2 as DeleteIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
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
  const filesByApp = useAppsV2Store(s => s.filesByApp);
  const fetchApps = useAppsV2Store(s => s.fetchApps);
  const fetchFiles = useAppsV2Store(s => s.fetchFiles);
  const createApp = useAppsV2Store(s => s.createApp);
  const deleteApp = useAppsV2Store(s => s.deleteApp);

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

  const reveal = useExplorerRevealStore(selectRevealFor("apps-v2"));

  const [loadingApps, setLoadingApps] = useState<Record<string, boolean>>({});
  const [expandedFolders, setExpandedFolders] = useState<
    Record<string, boolean>
  >({});
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (workspaceId) void fetchApps(workspaceId);
  }, [workspaceId, fetchApps]);

  // App rows are directories whose children are the file tree — `undefined`
  // until fetched so ResourceTree shows the loading skeleton and fires
  // onLoadChildren (same contract as the v1 apps explorer).
  const sections = useMemo(
    () => [
      {
        key: "apps",
        label: "Apps",
        nodes: apps.map(app => ({
          id: app.id,
          name: app.title,
          path: app.id,
          isDirectory: true,
          children: filesByApp[app.id]
            ? buildFileNodes(app.id, filesByApp[app.id])
            : undefined,
        })),
        hideSectionHeader: true,
      },
    ],
    [apps, filesByApp],
  );

  const handleLoadChildren = useCallback(
    async (node: ResourceTreeNode) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind !== "app" || !workspaceId || filesByApp[parsed.appId]) {
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
        focusAppsV2Tab(parsed.appId, node.name);
        // Warm the file tree so expanding is instant.
        if (workspaceId && !filesByApp[parsed.appId]) {
          void fetchFiles(workspaceId, parsed.appId);
        }
      } else if (parsed.kind === "file") {
        focusAppsV2FileTab(parsed.appId, parsed.path);
      }
    },
    [workspaceId, filesByApp, fetchFiles],
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
          "Delete this app and its git repository? This cannot be undone.",
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
      <Tooltip title="New app">
        <IconButton size="small" onClick={() => setCreateOpen(true)}>
          <AddIcon size={20} strokeWidth={2} />
        </IconButton>
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
        {({ searchQuery }) =>
          apps.length === 0 && !loading ? (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              No apps yet. Create one, or ask the agent to build one (Apps v2
              tools).
            </Typography>
          ) : (
            <ResourceTree
              sections={sections}
              mode="sidebar"
              searchQuery={searchQuery}
              activeItemId={activeItemId}
              revealNodeId={reveal?.nodeId}
              revealNonce={reveal?.nonce}
              getItemIcon={node =>
                parseNodeId(node.id).kind === "app" ? (
                  <AppIcon size={16} strokeWidth={1.5} />
                ) : undefined
              }
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
              isFolderExpanded={key => !!expandedFolders[key]}
              onToggleFolder={key =>
                setExpandedFolders(prev => ({ ...prev, [key]: !prev[key] }))
              }
              onExpandFolder={key =>
                setExpandedFolders(prev => ({ ...prev, [key]: true }))
              }
            />
          )
        }
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
            Creates a real Vite + React project in a Mako-managed git
            repository.
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
