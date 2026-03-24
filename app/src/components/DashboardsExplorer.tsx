import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Box,
  IconButton,
  Typography,
  Tooltip,
  Alert,
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
  Lock as LockIcon,
  Globe as GlobeIcon,
  User as UserIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";
import { useConsoleStore } from "../store/consoleStore";
import { useDashboardStore } from "../store/dashboardStore";
import { useDashboardTreeStore } from "../store/dashboardTreeStore";
import { useExplorerStore } from "../store/explorerStore";
import ResourceTree, { type ResourceTreeNode } from "./ResourceTree";

const EMPTY_TREE: ResourceTreeNode[] = [];

export function DashboardsExplorer() {
  const { currentWorkspace } = useWorkspace();
  const { user } = useAuth();
  const workspaceId = currentWorkspace?.id;
  const isAdmin =
    currentWorkspace?.role === "owner" || currentWorkspace?.role === "admin";

  const myDashboards = useDashboardTreeStore(
    s => (workspaceId && s.myDashboards[workspaceId]) || EMPTY_TREE,
  );
  const workspaceDashboards = useDashboardTreeStore(
    s => (workspaceId && s.workspaceDashboards[workspaceId]) || EMPTY_TREE,
  );
  const loading = useDashboardTreeStore(s =>
    workspaceId ? !!s.loading[workspaceId] : false,
  );
  const error = useDashboardTreeStore(s =>
    workspaceId ? s.error[workspaceId] || null : null,
  );
  const fetchTree = useDashboardTreeStore(s => s.fetchTree);
  const moveItem = useDashboardTreeStore(s => s.moveItem);
  const moveFolder = useDashboardTreeStore(s => s.moveFolder);
  const createFolder = useDashboardTreeStore(s => s.createFolder);
  const renameItem = useDashboardTreeStore(s => s.renameItem);
  const deleteItem = useDashboardTreeStore(s => s.deleteItem);
  const resortItem = useDashboardTreeStore(s => s.resortItem);
  const duplicateDashboard = useDashboardStore(s => s.duplicateDashboard);

  const isDashboardFolderExpanded = useExplorerStore(
    s => s.isDashboardFolderExpanded,
  );
  const toggleDashboardFolder = useExplorerStore(s => s.toggleDashboardFolder);
  const expandDashboardFolder = useExplorerStore(s => s.expandDashboardFolder);

  const { openTab, setActiveTab, activeTabId, tabs } = useConsoleStore();

  const [deleteTarget, setDeleteTarget] = useState<ResourceTreeNode | null>(
    null,
  );

  useEffect(() => {
    if (workspaceId) {
      fetchTree(workspaceId);
    }
  }, [workspaceId, fetchTree]);

  const handleRefresh = useCallback(async () => {
    if (workspaceId) await fetchTree(workspaceId);
  }, [workspaceId, fetchTree]);

  const handleCreate = useCallback(() => {
    const id = openTab({
      title: "New Dashboard",
      content: "",
      kind: "dashboard",
      metadata: { isNew: true },
    });
    setActiveTab(id);
  }, [openTab, setActiveTab]);

  const handleItemClick = useCallback(
    (node: ResourceTreeNode) => {
      const existingTab = Object.values(tabs).find(
        (tab: any) =>
          tab.kind === "dashboard" && tab.metadata?.dashboardId === node.id,
      );
      if (existingTab) {
        setActiveTab(existingTab.id);
      } else {
        const id = openTab({
          title: node.name,
          content: "",
          kind: "dashboard",
          metadata: { dashboardId: node.id },
        });
        setActiveTab(id);
      }
    },
    [tabs, openTab, setActiveTab],
  );

  const handleDeleteItem = useCallback((node: ResourceTreeNode) => {
    setDeleteTarget(node);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget || !workspaceId) return;
    await deleteItem(workspaceId, deleteTarget.id, deleteTarget.isDirectory);
    setDeleteTarget(null);
  }, [deleteTarget, workspaceId, deleteItem]);

  const handleDuplicate = useCallback(
    async (node: ResourceTreeNode) => {
      if (!workspaceId) return;
      const result = await duplicateDashboard(workspaceId, node.id);
      if (result) {
        await fetchTree(workspaceId);
        const id = openTab({
          title: result.title,
          content: "",
          kind: "dashboard",
          metadata: { dashboardId: result._id },
        });
        setActiveTab(id);
      }
    },
    [workspaceId, duplicateDashboard, fetchTree, openTab, setActiveTab],
  );

  const handleCreateFolder = useCallback(
    async (
      parentId: string | null,
      access?: string,
    ): Promise<string | null> => {
      if (!workspaceId) return null;
      return createFolder(
        workspaceId,
        "New Folder",
        parentId,
        (access as "private" | "workspace") || undefined,
      );
    },
    [workspaceId, createFolder],
  );

  const handleMoveItem = useCallback(
    (itemId: string, targetFolderId: string | null, access?: string) => {
      if (!workspaceId) return;
      moveItem(
        workspaceId,
        itemId,
        targetFolderId,
        (access as "private" | "workspace") || undefined,
      );
    },
    [workspaceId, moveItem],
  );

  const handleMoveFolder = useCallback(
    (folderId: string, parentId: string | null, access?: string) => {
      if (!workspaceId) return;
      moveFolder(
        workspaceId,
        folderId,
        parentId,
        (access as "private" | "workspace") || undefined,
      );
    },
    [workspaceId, moveFolder],
  );

  const handleRenameItem = useCallback(
    (id: string, name: string, isDirectory: boolean) => {
      if (!workspaceId) return;
      renameItem(workspaceId, id, name, isDirectory);
    },
    [workspaceId, renameItem],
  );

  const handleResortItem = useCallback(
    (id: string) => {
      if (!workspaceId) return;
      resortItem(workspaceId, id);
    },
    [workspaceId, resortItem],
  );

  const canManageItem = useCallback(
    (node: ResourceTreeNode) => {
      if (isAdmin) return true;
      if (node.owner_id === user?.id) return true;
      return false;
    },
    [isAdmin, user?.id],
  );

  const getItemIcon = useCallback((node: ResourceTreeNode) => {
    if (node.access === "workspace") {
      return <GlobeIcon size={16} strokeWidth={1.5} />;
    }
    return <LockIcon size={16} strokeWidth={1.5} />;
  }, []);

  const sectionsDef = useMemo(
    () => [
      {
        key: "my",
        label: "My Dashboards",
        icon: <UserIcon size={16} strokeWidth={1.5} />,
        nodes: myDashboards as ResourceTreeNode[],
        droppableId: "__section_my",
        defaultAccess: "private" as const,
      },
      {
        key: "workspace",
        label: "Workspace",
        icon: <GlobeIcon size={16} strokeWidth={1.5} />,
        nodes: workspaceDashboards as ResourceTreeNode[],
        droppableId: "__section_workspace",
        defaultAccess: "workspace" as const,
      },
    ],
    [myDashboards, workspaceDashboards],
  );

  const activeDashboardTabId = (() => {
    if (!activeTabId) return null;
    const tab = tabs[activeTabId];
    if (tab?.kind === "dashboard" && tab.metadata?.dashboardId) {
      return tab.metadata.dashboardId as string;
    }
    return null;
  })();

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <Box sx={{ px: 1, py: 0.5, borderBottom: 1, borderColor: "divider" }}>
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <Typography
            variant="h6"
            sx={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              textTransform: "uppercase",
            }}
          >
            Dashboards
          </Typography>
          <Box sx={{ display: "flex", gap: 0 }}>
            <Tooltip title="New Dashboard">
              <IconButton size="small" onClick={handleCreate}>
                <AddIcon size={20} strokeWidth={2} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Refresh">
              <IconButton
                size="small"
                onClick={handleRefresh}
                disabled={loading}
              >
                <RefreshIcon size={20} strokeWidth={2} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
      </Box>

      {/* Error Alert */}
      {error && (
        <Alert
          severity="error"
          onClose={() => {
            if (workspaceId) {
              useDashboardTreeStore.setState(state => {
                state.error[workspaceId] = null;
              });
            }
          }}
          sx={{ mx: 2, mt: 2 }}
        >
          {error}
        </Alert>
      )}

      {/* Tree */}
      <Box sx={{ flexGrow: 1, overflow: "auto" }}>
        {loading &&
        myDashboards.length === 0 &&
        workspaceDashboards.length === 0 ? (
          <Box sx={{ p: 3, textAlign: "center", color: "text.secondary" }}>
            <Typography variant="body2">Loading...</Typography>
          </Box>
        ) : (
          <ResourceTree
            sections={sectionsDef}
            mode="sidebar"
            activeItemId={activeDashboardTabId}
            getItemIcon={getItemIcon}
            enableDragDrop
            enableRename
            enableDuplicate
            enableDelete
            enableNewFolder
            onItemClick={handleItemClick}
            onMoveItem={handleMoveItem}
            onMoveFolder={handleMoveFolder}
            onRenameItem={handleRenameItem}
            onDeleteItem={handleDeleteItem}
            onDuplicateItem={handleDuplicate}
            onCreateFolder={handleCreateFolder}
            onResortItem={handleResortItem}
            isFolderExpanded={isDashboardFolderExpanded}
            onToggleFolder={toggleDashboardFolder}
            onExpandFolder={expandDashboardFolder}
            canManageItem={canManageItem}
          />
        )}
      </Box>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>
          Delete {deleteTarget?.isDirectory ? "Folder" : "Dashboard"}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete "{deleteTarget?.name}"?
            {deleteTarget?.isDirectory
              ? " All dashboards inside will be moved to the root level."
              : " This action cannot be undone."}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button onClick={handleDeleteConfirm} color="error">
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default DashboardsExplorer;
