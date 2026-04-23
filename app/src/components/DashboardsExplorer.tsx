import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Box,
  Chip,
  IconButton,
  Stack,
  Typography,
  Tooltip,
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
import { focusDashboardTab } from "../dashboard-runtime/shell";
import type { Dashboard } from "../dashboard-runtime/types";
import { computeDashboardStateHash } from "../utils/stateHash";
import ResourceTree, { type ResourceTreeNode } from "./ResourceTree";
import ExplorerShell from "./ExplorerShell";

const EMPTY_TREE: ResourceTreeNode[] = [];
const NEW_DASHBOARD_TEMPLATE = {
  title: "Untitled Dashboard",
  dataSources: [],
  widgets: [],
  relationships: [],
  globalFilters: [],
  crossFilter: {
    enabled: true,
    resolution: "intersect",
    engine: "mosaic",
  },
  materializationSchedule: {
    enabled: true,
    cron: "0 0 * * *",
    timezone: "UTC",
  },
  layout: { columns: 12, rowHeight: 80 },
  cache: {},
  access: "private",
} satisfies Partial<Dashboard>;

export function DashboardsExplorer() {
  const { currentWorkspace, members } = useWorkspace();
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
  const createDashboard = useDashboardStore(s => s.createDashboard);
  const duplicateDashboard = useDashboardStore(s => s.duplicateDashboard);

  const dashboardExpandedFolders = useExplorerStore(
    s => s.dashboard.expandedFolders,
  );
  const toggleDashboardFolder = useExplorerStore(s => s.toggleDashboardFolder);
  const expandDashboardFolder = useExplorerStore(s => s.expandDashboardFolder);

  const isDashboardFolderExpanded = useCallback(
    (key: string) => !!dashboardExpandedFolders[key],
    [dashboardExpandedFolders],
  );

  const { openTab, setActiveTab, activeTabId, tabs } = useConsoleStore();

  const [deleteTarget, setDeleteTarget] = useState<ResourceTreeNode | null>(
    null,
  );
  const [moveTarget, setMoveTarget] = useState<ResourceTreeNode | null>(null);
  const [infoTarget, setInfoTarget] = useState<ResourceTreeNode | null>(null);

  useEffect(() => {
    if (workspaceId) {
      fetchTree(workspaceId);
    }
  }, [workspaceId, fetchTree]);

  const handleRefresh = useCallback(async () => {
    if (workspaceId) await fetchTree(workspaceId);
  }, [workspaceId, fetchTree]);

  const handleCreate = useCallback(async () => {
    if (!workspaceId) return;

    const created = await createDashboard(workspaceId, NEW_DASHBOARD_TEMPLATE);
    if (!created) return;

    useDashboardStore.setState(state => {
      state.openDashboards[created._id] = created;
      state.activeDashboardId = created._id;
      state.historyMap[created._id] = { stack: [], index: -1 };
      state.savedStateHashes[created._id] = computeDashboardStateHash(created);
    });

    focusDashboardTab(created._id, created.title);
    void fetchTree(workspaceId);
  }, [workspaceId, createDashboard, fetchTree]);

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
    ): Promise<{ id: string; name: string } | null> => {
      if (!workspaceId) return null;
      const id = await createFolder(
        workspaceId,
        "New Folder",
        parentId,
        (access as "private" | "workspace") || undefined,
      );
      return id ? { id, name: "New Folder" } : null;
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

  const handleMoveRequest = useCallback((node: ResourceTreeNode) => {
    setMoveTarget(node);
  }, []);

  const handleInfoRequest = useCallback((node: ResourceTreeNode) => {
    setInfoTarget(node);
  }, []);

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

  const actions = (
    <>
      <Tooltip title="New Dashboard">
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

  const isInitialLoading =
    loading && myDashboards.length === 0 && workspaceDashboards.length === 0;

  return (
    <>
      <ExplorerShell
        title="Dashboards"
        actions={actions}
        searchPlaceholder="Search dashboards..."
        error={error}
        onErrorClose={() => {
          if (workspaceId) {
            useDashboardTreeStore.setState(state => {
              state.error[workspaceId] = null;
            });
          }
        }}
        loading={isInitialLoading}
        skeleton={
          <Box sx={{ p: 3, textAlign: "center", color: "text.secondary" }}>
            <Typography variant="body2">Loading...</Typography>
          </Box>
        }
      >
        {({ searchQuery }) => (
          <ResourceTree
            sections={sectionsDef}
            mode="sidebar"
            searchQuery={searchQuery}
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
            enableMove
            enableInfo
            onMoveRequest={handleMoveRequest}
            onInfoRequest={handleInfoRequest}
            onFolderInfoRequest={handleInfoRequest}
            isFolderExpanded={isDashboardFolderExpanded}
            onToggleFolder={toggleDashboardFolder}
            onExpandFolder={expandDashboardFolder}
            getFolderExpansionKey={node => node.id}
            canManageItem={canManageItem}
          />
        )}
      </ExplorerShell>

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

      {/* Move Dialog */}
      <Dialog
        open={!!moveTarget}
        onClose={() => setMoveTarget(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>
          Move {moveTarget?.isDirectory ? "Folder" : "Dashboard"}
        </DialogTitle>
        <DialogContent sx={{ p: 0, height: 320 }}>
          <ResourceTree
            sections={sectionsDef}
            mode="picker"
            showFiles={false}
            getItemIcon={getItemIcon}
            isFolderExpanded={isDashboardFolderExpanded}
            onToggleFolder={toggleDashboardFolder}
            onExpandFolder={expandDashboardFolder}
            getFolderExpansionKey={node => node.id}
            onLocationChange={(folderId, sectionKey) => {
              if (!moveTarget || !workspaceId) return;
              const access =
                sectionKey === "workspace" ? "workspace" : "private";
              if (moveTarget.isDirectory) {
                moveFolder(workspaceId, moveTarget.id, folderId, access);
              } else {
                moveItem(workspaceId, moveTarget.id, folderId, access);
              }
              setMoveTarget(null);
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMoveTarget(null)}>Cancel</Button>
        </DialogActions>
      </Dialog>

      {/* Information Dialog */}
      <DashboardInfoDialog
        item={infoTarget}
        onClose={() => setInfoTarget(null)}
        members={members}
      />
    </>
  );
}

const accessLabels: Record<string, string> = {
  private: "Private",
  workspace: "Shared with workspace",
};

function formatDate(value?: string): string {
  if (!value) return "Unknown";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "Unknown";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function DashboardInfoDialog({
  item,
  onClose,
  members,
}: {
  item: ResourceTreeNode | null;
  onClose: () => void;
  members: { userId: string; email: string }[];
}) {
  const ownerEmail = item?.owner_id
    ? members.find(m => m.userId === item.owner_id)?.email || item.owner_id
    : "Unknown";

  const dashboardEntry = item as ResourceTreeNode & {
    createdAt?: string;
    updatedAt?: string;
  };

  return (
    <Dialog open={!!item} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>
        {item?.isDirectory ? "Folder" : "Dashboard"} Information
      </DialogTitle>
      <DialogContent sx={{ pt: 1 }}>
        <Stack spacing={2}>
          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
              Name
            </Typography>
            <Typography variant="body2">{item?.name ?? "—"}</Typography>
          </Box>

          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
              Created by
            </Typography>
            <Typography variant="body2">{ownerEmail}</Typography>
          </Box>

          {dashboardEntry?.createdAt && (
            <Box>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mb: 0.5 }}
              >
                Created at
              </Typography>
              <Typography variant="body2">
                {formatDate(dashboardEntry.createdAt)}
              </Typography>
            </Box>
          )}

          {dashboardEntry?.updatedAt && (
            <Box>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mb: 0.5 }}
              >
                Last modified
              </Typography>
              <Typography variant="body2">
                {formatDate(dashboardEntry.updatedAt)}
              </Typography>
            </Box>
          )}

          {item?.access && (
            <Box>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mb: 0.5 }}
              >
                Access
              </Typography>
              <Chip
                label={accessLabels[item.access] || item.access}
                size="small"
                variant="outlined"
              />
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

export default DashboardsExplorer;
