import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Box,
  IconButton,
  Tooltip,
  Typography,
  MenuItem,
  ListItemIcon,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  TextField,
  Button,
} from "@mui/material";
import {
  Plus as AddIcon,
  RefreshCw as RefreshIcon,
  AppWindow as AppIcon,
  FileCode as FileIcon,
  Globe as GlobeIcon,
  User as UserIcon,
  ExternalLink as OpenIcon,
  Pencil as RenameIcon,
  Trash2 as DeleteIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import { useAppStore, type AppListItem } from "../store/appStore";
import { focusAppTab, focusAppFileTab } from "../app-runtime/shell";
import type { AppFile } from "@mako/schemas";
import ResourceTree, { type ResourceTreeNode } from "./ResourceTree";
import ExplorerShell from "./ExplorerShell";

const EMPTY_LIST: AppListItem[] = [];

// Node id encoding so the flat ResourceTree ids stay unique and parseable.
// App node:    "<appId>"
// Folder node: "<appId>::dir::<dirPath>"
// File node:   "<appId>::file::<filePath>"
const FILE_SEP = "::file::";
const DIR_SEP = "::dir::";

function dirname(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

interface ParsedNode {
  kind: "app" | "dir" | "file";
  appId: string;
  path: string;
}
function parseNodeId(id: string): ParsedNode {
  if (id.includes(FILE_SEP)) {
    const [appId, path] = id.split(FILE_SEP);
    return { kind: "file", appId, path };
  }
  if (id.includes(DIR_SEP)) {
    const [appId, path] = id.split(DIR_SEP);
    return { kind: "dir", appId, path };
  }
  return { kind: "app", appId: id, path: "" };
}

/** Build nested ResourceTree nodes (folders + files) for one app's files. */
function buildAppFileNodes(
  appId: string,
  files: AppFile[],
): ResourceTreeNode[] {
  const root: ResourceTreeNode = {
    id: `${appId}${DIR_SEP}`,
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
        ? `${appId}${FILE_SEP}${path}`
        : `${appId}${DIR_SEP}${path}`;
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

export function AppsExplorer() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const myApps = useAppStore(
    s => (workspaceId ? s.myApps[workspaceId] : undefined) || EMPTY_LIST,
  );
  const workspaceApps = useAppStore(
    s => (workspaceId ? s.workspaceApps[workspaceId] : undefined) || EMPTY_LIST,
  );
  const openApps = useAppStore(s => s.openApps);
  const loading = useAppStore(s =>
    workspaceId ? !!s.loading[workspaceId] : false,
  );
  const error = useAppStore(s => (workspaceId ? s.error[workspaceId] : null));
  const fetchList = useAppStore(s => s.fetchList);
  const fetchApp = useAppStore(s => s.fetchApp);
  const createApp = useAppStore(s => s.createApp);
  const deleteApp = useAppStore(s => s.deleteApp);
  const renameApp = useAppStore(s => s.renameApp);
  const renameFile = useAppStore(s => s.renameFile);
  const deleteFile = useAppStore(s => s.deleteFile);
  const persistApp = useAppStore(s => s.persistApp);

  const activeTabId = useConsoleStore(s => s.activeTabId);
  const tabs = useConsoleStore(s => s.tabs);
  const activeTab = activeTabId ? tabs[activeTabId] : undefined;
  const activeItemId = useMemo(() => {
    if (activeTab?.kind === "app") return activeTab.metadata?.appId as string;
    if (activeTab?.kind === "app-file") {
      return `${activeTab.metadata?.appId}${FILE_SEP}${activeTab.metadata?.path}`;
    }
    return null;
  }, [activeTab]);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loadingApps, setLoadingApps] = useState<Record<string, boolean>>({});
  const [renameTarget, setRenameTarget] = useState<{
    parsed: ParsedNode;
    name: string;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{
    parsed: ParsedNode;
    name: string;
  } | null>(null);

  useEffect(() => {
    if (workspaceId) void fetchList(workspaceId);
  }, [workspaceId, fetchList]);

  // Build the section node trees. App nodes are directories whose children are
  // the file tree (undefined until the app is fetched, so ResourceTree shows a
  // loading skeleton and fires onLoadChildren).
  const buildSectionNodes = useCallback(
    (items: AppListItem[]): ResourceTreeNode[] =>
      items.map(item => {
        const loaded = openApps[item.id];
        return {
          id: item.id,
          name: item.name,
          path: item.id,
          isDirectory: true,
          access: item.access,
          owner_id: item.owner_id,
          children: loaded
            ? buildAppFileNodes(item.id, loaded.files)
            : undefined,
        };
      }),
    [openApps],
  );

  const sections = useMemo(
    () => [
      {
        key: "my",
        label: "My Apps",
        icon: <UserIcon size={16} strokeWidth={1.5} />,
        nodes: buildSectionNodes(myApps),
        defaultAccess: "private" as const,
      },
      {
        key: "workspace",
        label: "Workspace",
        icon: <GlobeIcon size={16} strokeWidth={1.5} />,
        nodes: buildSectionNodes(workspaceApps),
        defaultAccess: "workspace" as const,
      },
    ],
    [myApps, workspaceApps, buildSectionNodes],
  );

  const handleCreate = useCallback(async () => {
    if (!workspaceId) return;
    const created = await createApp(workspaceId, "Untitled App");
    if (created) focusAppTab(created._id, created.title);
  }, [workspaceId, createApp]);

  const handleRefresh = useCallback(() => {
    if (workspaceId) void fetchList(workspaceId);
  }, [workspaceId, fetchList]);

  const handleLoadChildren = useCallback(
    async (node: ResourceTreeNode) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind !== "app" || !workspaceId || openApps[parsed.appId]) {
        return;
      }
      setLoadingApps(prev => ({ ...prev, [parsed.appId]: true }));
      await fetchApp(workspaceId, parsed.appId);
      setLoadingApps(prev => ({ ...prev, [parsed.appId]: false }));
    },
    [workspaceId, openApps, fetchApp],
  );

  const handleItemClick = useCallback((node: ResourceTreeNode) => {
    const parsed = parseNodeId(node.id);
    if (parsed.kind === "file") focusAppFileTab(parsed.appId, parsed.path);
  }, []);

  const getItemIcon = useCallback((node: ResourceTreeNode) => {
    const parsed = parseNodeId(node.id);
    if (parsed.kind === "app") {
      return <AppIcon size={16} strokeWidth={1.5} />;
    }
    if (parsed.kind === "file") {
      return <FileIcon size={16} strokeWidth={1.5} />;
    }
    return undefined; // folders use the default folder icon
  }, []);

  const getContextMenuItems = useCallback(
    (node: ResourceTreeNode, helpers: { closeMenu: () => void }) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind === "dir") return []; // virtual folders: no actions
      const items = [];
      if (parsed.kind === "app") {
        items.push(
          <MenuItem
            key="open"
            onClick={() => {
              focusAppTab(parsed.appId, node.name);
              helpers.closeMenu();
            }}
          >
            <ListItemIcon>
              <OpenIcon size={16} strokeWidth={1.5} />
            </ListItemIcon>
            Open
          </MenuItem>,
        );
      } else {
        items.push(
          <MenuItem
            key="open"
            onClick={() => {
              focusAppFileTab(parsed.appId, parsed.path);
              helpers.closeMenu();
            }}
          >
            <ListItemIcon>
              <OpenIcon size={16} strokeWidth={1.5} />
            </ListItemIcon>
            Open
          </MenuItem>,
        );
      }
      items.push(
        <MenuItem
          key="rename"
          onClick={() => {
            setRenameTarget({ parsed, name: node.name });
            setRenameValue(node.name);
            helpers.closeMenu();
          }}
        >
          <ListItemIcon>
            <RenameIcon size={16} strokeWidth={1.5} />
          </ListItemIcon>
          Rename
        </MenuItem>,
        <MenuItem
          key="delete"
          onClick={() => {
            setDeleteTarget({ parsed, name: node.name });
            helpers.closeMenu();
          }}
        >
          <ListItemIcon>
            <DeleteIcon size={16} strokeWidth={1.5} />
          </ListItemIcon>
          Delete
        </MenuItem>,
      );
      return items;
    },
    [],
  );

  const handleRenameConfirm = useCallback(async () => {
    if (!renameTarget || !workspaceId) return;
    const next = renameValue.trim();
    const { parsed } = renameTarget;
    if (next && next !== renameTarget.name) {
      if (parsed.kind === "app") {
        await renameApp(workspaceId, parsed.appId, next);
      } else if (parsed.kind === "file") {
        const dir = dirname(parsed.path);
        const newPath = dir ? `${dir}/${next}` : next;
        renameFile(parsed.appId, parsed.path, newPath);
        await persistApp(workspaceId, parsed.appId);
      }
    }
    setRenameTarget(null);
  }, [
    renameTarget,
    renameValue,
    workspaceId,
    renameApp,
    renameFile,
    persistApp,
  ]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget || !workspaceId) return;
    const { parsed } = deleteTarget;
    if (parsed.kind === "app") {
      await deleteApp(workspaceId, parsed.appId);
    } else if (parsed.kind === "file") {
      deleteFile(parsed.appId, parsed.path);
      await persistApp(workspaceId, parsed.appId);
    }
    setDeleteTarget(null);
  }, [deleteTarget, workspaceId, deleteApp, deleteFile, persistApp]);

  const actions = (
    <>
      <Tooltip title="New App">
        <IconButton size="small" onClick={handleCreate}>
          <AddIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
      <Tooltip title="Refresh">
        <IconButton size="small" onClick={handleRefresh} disabled={loading}>
          <RefreshIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
    </>
  );

  const isApp = renameTarget?.parsed.kind === "app";
  const deleteIsApp = deleteTarget?.parsed.kind === "app";

  return (
    <>
      <ExplorerShell
        title="Apps"
        actions={actions}
        searchPlaceholder="Search apps..."
        error={error}
        onErrorClose={() => {
          if (workspaceId) {
            useAppStore.setState(state => {
              state.error[workspaceId] = null;
            });
          }
        }}
        loading={loading && myApps.length === 0 && workspaceApps.length === 0}
        skeleton={
          <Box sx={{ p: 3, textAlign: "center", color: "text.secondary" }}>
            <Typography variant="body2">Loading...</Typography>
          </Box>
        }
      >
        {({ searchQuery }) => (
          <ResourceTree
            sections={sections}
            mode="sidebar"
            searchQuery={searchQuery}
            activeItemId={activeItemId}
            getItemIcon={getItemIcon}
            getContextMenuItems={getContextMenuItems}
            onItemClick={handleItemClick}
            onLoadChildren={handleLoadChildren}
            isLoadingChildren={node => {
              const parsed = parseNodeId(node.id);
              return parsed.kind === "app" && !!loadingApps[parsed.appId];
            }}
            enableDragDrop={false}
            enableRename={false}
            enableDelete={false}
            enableNewFolder={false}
            isFolderExpanded={key => !!expanded[key]}
            onToggleFolder={key =>
              setExpanded(prev => ({ ...prev, [key]: !prev[key] }))
            }
            onExpandFolder={key =>
              setExpanded(prev => ({ ...prev, [key]: true }))
            }
            getFolderExpansionKey={node => node.id}
          />
        )}
      </ExplorerShell>

      {/* Rename dialog */}
      <Dialog
        open={!!renameTarget}
        onClose={() => setRenameTarget(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Rename {isApp ? "App" : "File"}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") void handleRenameConfirm();
            }}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameTarget(null)}>Cancel</Button>
          <Button onClick={handleRenameConfirm}>Rename</Button>
        </DialogActions>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Delete {deleteIsApp ? "App" : "File"}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete &quot;{deleteTarget?.name}&quot;?
            {deleteIsApp ? " This deletes the entire app." : ""} This action
            cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button onClick={handleDeleteConfirm} color="error">
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

export default AppsExplorer;
