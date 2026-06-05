import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Box,
  IconButton,
  Tooltip,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
} from "@mui/material";
import {
  Plus as AddIcon,
  RefreshCw as RefreshIcon,
  ChevronRight as ChevronRightIcon,
  ChevronDown as ChevronDownIcon,
  AppWindow as AppIcon,
  Folder as FolderIcon,
  FileCode as FileIcon,
  Globe as GlobeIcon,
  User as UserIcon,
  Trash2 as DeleteIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import { useAppStore, type AppListItem } from "../store/appStore";
import { focusAppTab } from "../app-runtime/shell";
import type { AppFile } from "@mako/schemas";
import ExplorerShell from "./ExplorerShell";

const EMPTY_LIST: AppListItem[] = [];

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

/** Build a nested folder/file tree from a flat list of file paths. */
function buildFileTree(files: AppFile[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    let cursor = root;
    segments.forEach((segment, index) => {
      const isLeaf = index === segments.length - 1;
      const path = segments.slice(0, index + 1).join("/");
      let child = cursor.children.find(c => c.name === segment);
      if (!child) {
        child = { name: segment, path, isDir: !isLeaf, children: [] };
        cursor.children.push(child);
      }
      cursor = child;
    });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach(n => sort(n.children));
  };
  sort(root.children);
  return root.children;
}

function FileTree({
  nodes,
  depth,
  onFileClick,
}: {
  nodes: TreeNode[];
  depth: number;
  onFileClick: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return (
    <>
      {nodes.map(node => {
        const isOpen = expanded[node.path] ?? depth < 1;
        return (
          <Box key={node.path}>
            <Box
              onClick={() =>
                node.isDir
                  ? setExpanded(prev => ({ ...prev, [node.path]: !isOpen }))
                  : onFileClick(node.path)
              }
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                pl: `${depth * 12 + 28}px`,
                pr: 1,
                py: 0.25,
                cursor: "pointer",
                fontSize: "0.8rem",
                color: "text.secondary",
                "&:hover": { backgroundColor: "action.hover" },
              }}
            >
              {node.isDir ? (
                <>
                  {isOpen ? (
                    <ChevronDownIcon size={14} strokeWidth={1.5} />
                  ) : (
                    <ChevronRightIcon size={14} strokeWidth={1.5} />
                  )}
                  <FolderIcon size={14} strokeWidth={1.5} />
                </>
              ) : (
                <FileIcon
                  size={14}
                  strokeWidth={1.5}
                  style={{ marginLeft: 14 }}
                />
              )}
              <Typography
                variant="caption"
                sx={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {node.name}
              </Typography>
            </Box>
            {node.isDir && isOpen && (
              <FileTree
                nodes={node.children}
                depth={depth + 1}
                onFileClick={onFileClick}
              />
            )}
          </Box>
        );
      })}
    </>
  );
}

function AppRow({
  item,
  workspaceId,
  isActive,
  onDelete,
}: {
  item: AppListItem;
  workspaceId: string;
  isActive: boolean;
  onDelete: (item: AppListItem) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const fetchApp = useAppStore(s => s.fetchApp);
  const openApp = useAppStore(s => s.openApps[item.id]);

  useEffect(() => {
    if (expanded && !openApp) {
      void fetchApp(workspaceId, item.id);
    }
  }, [expanded, openApp, fetchApp, workspaceId, item.id]);

  const tree = useMemo(
    () => (openApp ? buildFileTree(openApp.files) : []),
    [openApp],
  );

  return (
    <Box>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          px: 1,
          py: 0.5,
          cursor: "pointer",
          backgroundColor: isActive ? "action.selected" : "transparent",
          "&:hover": { backgroundColor: "action.hover" },
          "&:hover .app-row-actions": { opacity: 1 },
        }}
      >
        <Box
          onClick={() => setExpanded(e => !e)}
          sx={{ display: "flex", alignItems: "center" }}
        >
          {expanded ? (
            <ChevronDownIcon size={16} strokeWidth={1.5} />
          ) : (
            <ChevronRightIcon size={16} strokeWidth={1.5} />
          )}
        </Box>
        <Box
          onClick={() => focusAppTab(item.id, item.name)}
          onDoubleClick={() => setExpanded(true)}
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.75,
            flex: 1,
            minWidth: 0,
          }}
        >
          <AppIcon size={16} strokeWidth={1.5} />
          <Typography
            variant="body2"
            sx={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.name}
          </Typography>
        </Box>
        <Box
          className="app-row-actions"
          sx={{ opacity: 0, transition: "opacity 0.15s" }}
        >
          <Tooltip title="Delete app">
            <IconButton size="small" onClick={() => onDelete(item)}>
              <DeleteIcon size={14} strokeWidth={1.5} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>
      {expanded &&
        (openApp ? (
          tree.length > 0 ? (
            <FileTree
              nodes={tree}
              depth={0}
              onFileClick={path => focusAppTab(item.id, item.name, path)}
            />
          ) : (
            <Typography
              variant="caption"
              sx={{ pl: 4, py: 0.5, display: "block", color: "text.disabled" }}
            >
              No files
            </Typography>
          )
        ) : (
          <Typography
            variant="caption"
            sx={{ pl: 4, py: 0.5, display: "block", color: "text.disabled" }}
          >
            Loading…
          </Typography>
        ))}
    </Box>
  );
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
  const loading = useAppStore(s =>
    workspaceId ? !!s.loading[workspaceId] : false,
  );
  const error = useAppStore(s =>
    workspaceId ? s.error[workspaceId] || null : null,
  );
  const fetchList = useAppStore(s => s.fetchList);
  const createApp = useAppStore(s => s.createApp);
  const deleteApp = useAppStore(s => s.deleteApp);

  const activeTabId = useConsoleStore(s => s.activeTabId);
  const tabs = useConsoleStore(s => s.tabs);
  const activeAppId =
    activeTabId && tabs[activeTabId]?.kind === "app"
      ? (tabs[activeTabId]?.metadata?.appId as string | undefined)
      : undefined;

  const [deleteTarget, setDeleteTarget] = useState<AppListItem | null>(null);

  useEffect(() => {
    if (workspaceId) void fetchList(workspaceId);
  }, [workspaceId, fetchList]);

  const handleCreate = useCallback(async () => {
    if (!workspaceId) return;
    const created = await createApp(workspaceId, "Untitled App");
    if (created) focusAppTab(created._id, created.title);
  }, [workspaceId, createApp]);

  const handleRefresh = useCallback(() => {
    if (workspaceId) void fetchList(workspaceId);
  }, [workspaceId, fetchList]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget || !workspaceId) return;
    await deleteApp(workspaceId, deleteTarget.id);
    setDeleteTarget(null);
  }, [deleteTarget, workspaceId, deleteApp]);

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

  const renderSection = (
    label: string,
    icon: React.ReactNode,
    items: AppListItem[],
  ) => (
    <Box sx={{ mb: 1 }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          px: 1,
          py: 0.5,
          color: "text.secondary",
        }}
      >
        {icon}
        <Typography
          variant="caption"
          sx={{ fontWeight: 600, letterSpacing: 0.3 }}
        >
          {label}
        </Typography>
      </Box>
      {items.length === 0 ? (
        <Typography
          variant="caption"
          sx={{ pl: 3, py: 0.25, display: "block", color: "text.disabled" }}
        >
          No apps
        </Typography>
      ) : (
        items.map(item =>
          workspaceId ? (
            <AppRow
              key={item.id}
              item={item}
              workspaceId={workspaceId}
              isActive={activeAppId === item.id}
              onDelete={setDeleteTarget}
            />
          ) : null,
        )
      )}
    </Box>
  );

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
        {() => (
          <Box sx={{ py: 0.5 }}>
            {renderSection(
              "My Apps",
              <UserIcon size={14} strokeWidth={1.5} />,
              myApps,
            )}
            {renderSection(
              "Workspace",
              <GlobeIcon size={14} strokeWidth={1.5} />,
              workspaceApps,
            )}
          </Box>
        )}
      </ExplorerShell>

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Delete App</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete &quot;{deleteTarget?.name}&quot;?
            This action cannot be undone.
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
