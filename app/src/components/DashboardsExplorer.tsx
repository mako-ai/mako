import { useState, useCallback, useMemo } from "react";
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
  DialogActions,
  Button,
} from "@mui/material";
import {
  Plus as AddIcon,
  RefreshCw as RefreshIcon,
  Database as DataSourceIcon,
} from "lucide-react";
import { TAB_KIND_ICONS } from "../lib/entity-icons";
import { ConfirmDialog } from "./ConfirmDialog";

const DashboardIcon = TAB_KIND_ICONS.dashboard;
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";
import { useConsoleStore } from "../store/consoleStore";
import { useDashboardStore } from "../store/dashboardStore";
import { useDashboardTreeStore } from "../store/dashboardTreeStore";
import { useResourceTreeExplorer } from "../hooks/useResourceTreeExplorer";
import { useExplorerStore } from "../store/explorerStore";
import {
  useExplorerRevealStore,
  selectRevealFor,
} from "../store/explorerRevealStore";
import {
  focusDashboardDataSourceTab,
  focusDashboardTab,
} from "../dashboard-runtime/shell";
import { DASHBOARD_DATA_SOURCE_SEP } from "../lib/explorer-reveal";
import type { Dashboard } from "../dashboard-runtime/types";
import { computeDashboardStateHash } from "../utils/stateHash";
import ResourceTree, { type ResourceTreeNode } from "./ResourceTree";
import ExplorerShell from "./ExplorerShell";

const DATA_SOURCES_DIR = "__datasources";
const DASHBOARD_DATA_SOURCE_DIR_SEP = "::dashboard-data-sources::";
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

  // A dashboard renders as a folder (it holds its data sources) but is an
  // item to the store; only real folders are folders. Read from the store
  // rather than the hook's selections so the predicate can be handed to the
  // hook without a circular definition.
  const isDashboardEntryId = useCallback(
    (id: string) => {
      const s = useDashboardTreeStore.getState();
      const nodes = workspaceId
        ? [
            ...(s.myItems[workspaceId] ?? []),
            ...(s.workspaceItems[workspaceId] ?? []),
          ]
        : [];
      return nodes.some(function visit(node: ResourceTreeNode): boolean {
        if (node.id === id) return !node.isDirectory;
        return node.children?.some(visit) ?? false;
      });
    },
    [workspaceId],
  );
  const tree = useResourceTreeExplorer(useDashboardTreeStore, workspaceId, {
    isFolder: (id, isDirectory) => isDirectory && !isDashboardEntryId(id),
  });
  const { loading, fetchTree } = tree;
  const createDashboard = useDashboardStore(s => s.createDashboard);
  const duplicateDashboard = useDashboardStore(s => s.duplicateDashboard);
  const openDashboard = useDashboardStore(s => s.openDashboard);
  const openDashboards = useDashboardStore(s => s.openDashboards);

  const dashboardExpandedFolders = useExplorerStore(
    s => s.dashboard.expandedFolders,
  );
  const toggleDashboardFolder = useExplorerStore(s => s.toggleDashboardFolder);
  const expandDashboardFolder = useExplorerStore(s => s.expandDashboardFolder);

  const isDashboardFolderExpanded = useCallback(
    (key: string) => !!dashboardExpandedFolders[key],
    [dashboardExpandedFolders],
  );

  const reveal = useExplorerRevealStore(selectRevealFor("dashboards"));

  const { activeTabId, tabs } = useConsoleStore();

  const [moveTarget, setMoveTarget] = useState<ResourceTreeNode | null>(null);
  const [infoTarget, setInfoTarget] = useState<ResourceTreeNode | null>(null);
  const [loadingDashboards, setLoadingDashboards] = useState<
    Record<string, boolean>
  >({});

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

  const handleItemClick = useCallback((node: ResourceTreeNode) => {
    if (node.id.includes(DASHBOARD_DATA_SOURCE_SEP)) {
      const [dashboardId, dataSourceId] = node.id.split(
        DASHBOARD_DATA_SOURCE_SEP,
      );
      focusDashboardDataSourceTab(dashboardId, dataSourceId, node.name);
      return;
    }
    if (node.id.includes(DASHBOARD_DATA_SOURCE_DIR_SEP)) return;

    focusDashboardTab(node.id, node.name);
  }, []);

  const handleDuplicate = useCallback(
    async (node: ResourceTreeNode) => {
      if (!workspaceId) return;
      const result = await duplicateDashboard(workspaceId, node.id);
      if (result) {
        await fetchTree(workspaceId);
        focusDashboardTab(result._id, result.title);
      }
    },
    [workspaceId, duplicateDashboard, fetchTree],
  );

  const canManageItem = useCallback(
    (node: ResourceTreeNode) => {
      if (
        node.id.includes(DASHBOARD_DATA_SOURCE_SEP) ||
        node.id.includes(DASHBOARD_DATA_SOURCE_DIR_SEP)
      ) {
        return false;
      }
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
    // Data source leaves keep their database glyph.
    if (node.id.includes(DASHBOARD_DATA_SOURCE_SEP)) {
      return <DataSourceIcon size={16} strokeWidth={1.5} />;
    }
    // Dashboards carry a dashboard glyph. Folders (both real folders and the
    // synthetic "Data sources" folder) show no icon — matching the consoles
    // explorer, where only leaves carry icons. Returning null lets ResourceTree
    // collapse the icon column so the label sits right after the chevron.
    if (node.entityType === "dashboard") {
      return <DashboardIcon size={20} strokeWidth={1.5} />;
    }
    return null;
  }, []);

  const withDataSourceNodes = useCallback(
    (nodes: ResourceTreeNode[]): ResourceTreeNode[] =>
      nodes.map(node => {
        if (node.isDirectory) {
          return {
            ...node,
            entityType: "dashboard-folder",
            children: node.children ? withDataSourceNodes(node.children) : [],
          };
        }

        const loaded = openDashboards[node.id];
        return {
          ...node,
          isDirectory: true,
          entityType: "dashboard",
          children: loaded
            ? [
                {
                  id: `${node.id}${DASHBOARD_DATA_SOURCE_DIR_SEP}${DATA_SOURCES_DIR}`,
                  name: "Data sources",
                  path: DATA_SOURCES_DIR,
                  isDirectory: true,
                  entityType: "data-source-folder",
                  children: loaded.dataSources.map(dataSource => ({
                    id: `${node.id}${DASHBOARD_DATA_SOURCE_SEP}${dataSource.id}`,
                    name: dataSource.name,
                    path: `data-source/${dataSource.id}`,
                    isDirectory: false,
                    entityType: "data-source",
                  })),
                },
              ]
            : undefined,
        };
      }),
    [openDashboards],
  );

  const handleLoadChildren = useCallback(
    async (node: ResourceTreeNode) => {
      if (!workspaceId) return;
      if (
        node.id.includes(DASHBOARD_DATA_SOURCE_SEP) ||
        node.id.includes(DASHBOARD_DATA_SOURCE_DIR_SEP) ||
        node.entityType !== "dashboard" ||
        openDashboards[node.id] ||
        loadingDashboards[node.id]
      ) {
        return;
      }
      setLoadingDashboards(state => ({ ...state, [node.id]: true }));
      try {
        await openDashboard(workspaceId, node.id);
      } finally {
        setLoadingDashboards(state => {
          const next = { ...state };
          delete next[node.id];
          return next;
        });
      }
    },
    [workspaceId, openDashboard, openDashboards, loadingDashboards],
  );

  const sectionsDef = useMemo(
    () => tree.sections({ my: "My Dashboards" }, withDataSourceNodes),
    [tree, withDataSourceNodes],
  );

  const folderOnlyNodes = useCallback(function onlyFolders(
    nodes: ResourceTreeNode[],
  ): ResourceTreeNode[] {
    return nodes
      .filter(node => node.isDirectory)
      .map(node => ({
        ...node,
        children: node.children ? onlyFolders(node.children) : [],
      }));
  }, []);

  const pickerSectionsDef = useMemo(
    () => tree.sections({ my: "My Dashboards" }, folderOnlyNodes),
    [tree, folderOnlyNodes],
  );

  const activeDashboardTabId = (() => {
    if (!activeTabId) return null;
    const tab = tabs[activeTabId];
    if (tab?.kind === "dashboard" && tab.metadata?.dashboardId) {
      return tab.metadata.dashboardId as string;
    }
    if (tab?.kind === "dashboard-data-source") {
      return `${tab.metadata?.dashboardId}${DASHBOARD_DATA_SOURCE_SEP}${tab.metadata?.dataSourceId}`;
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
        <IconButton
          size="small"
          onClick={() => void tree.refresh()}
          disabled={loading}
        >
          <RefreshIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
    </>
  );

  return (
    <>
      <ExplorerShell
        title="Dashboards"
        actions={actions}
        searchPlaceholder="Search dashboards..."
        error={tree.error}
        onErrorClose={tree.clearError}
        loading={tree.isInitialLoading}
      >
        {({ searchQuery }) => (
          <ResourceTree
            sections={sectionsDef}
            mode="sidebar"
            searchQuery={searchQuery}
            activeItemId={activeDashboardTabId}
            revealNodeId={reveal?.nodeId}
            revealNonce={reveal?.nonce}
            getItemIcon={getItemIcon}
            enableDragDrop
            enableRename
            enableDuplicate
            enableDelete
            enableNewFolder
            onItemClick={handleItemClick}
            shouldFolderClickActivate={node => node.entityType === "dashboard"}
            onLoadChildren={handleLoadChildren}
            isLoadingChildren={node => !!loadingDashboards[node.id]}
            {...tree.treeHandlers}
            onDuplicateItem={handleDuplicate}
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
      <ConfirmDialog
        open={!!tree.deleteTarget}
        title={`Delete ${
          tree.deleteTarget?.isDirectory &&
          !isDashboardEntryId(tree.deleteTarget.id)
            ? "Folder"
            : "Dashboard"
        }`}
        body={`Are you sure you want to delete "${tree.deleteTarget?.name}"?${
          tree.deleteTarget?.isDirectory &&
          !isDashboardEntryId(tree.deleteTarget.id)
            ? " All dashboards inside will be moved to the root level."
            : " This action cannot be undone."
        }`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void tree.confirmDelete()}
        onCancel={tree.cancelDelete}
      />

      {/* Move Dialog */}
      <Dialog
        open={!!moveTarget}
        onClose={() => setMoveTarget(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>
          Move{" "}
          {moveTarget?.isDirectory && !isDashboardEntryId(moveTarget.id)
            ? "Folder"
            : "Dashboard"}
        </DialogTitle>
        <DialogContent sx={{ p: 0, height: 320 }}>
          <ResourceTree
            sections={pickerSectionsDef}
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
              // onMoveFolder already moves a dashboard-that-looks-like-a-
              // folder as an item.
              if (moveTarget.isDirectory) {
                tree.treeHandlers.onMoveFolder(moveTarget.id, folderId, access);
              } else {
                tree.treeHandlers.onMoveItem(moveTarget.id, folderId, access);
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
        {item?.isDirectory && item.entityType !== "dashboard"
          ? "Folder"
          : "Dashboard"}{" "}
        Information
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
