import { useState, useCallback, useEffect, useMemo } from "react";
import {
  Box,
  Chip,
  IconButton,
  ListItemIcon,
  MenuItem,
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
  Star as StarIcon,
} from "lucide-react";
import {
  favouriteFor,
  selectFavourites,
  starredRefs,
  useFavouritesStore,
} from "../store/favouritesStore";
import StarToggle from "./starred/StarToggle";
import {
  buildStarredSection,
  entityIdFromStarredRow,
  favouriteIdFromFolderRow,
  flattenLeafRows,
  isStarredRow,
  realEntityId,
} from "./starred/starred-section";
import AccessIcon from "./AccessIcon";
import { resolveAccessState } from "./access-state";
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

  // Starred dashboards: a star is a SHORTCUT, not a move — dashboards keep
  // their real shared folders below and are also pinned on top, in this
  // person's own favourites folders.
  const favourites = useFavouritesStore(selectFavourites(workspaceId));
  const fetchFavourites = useFavouritesStore(s => s.fetch);
  const toggleFavourite = useFavouritesStore(s => s.toggle);
  const moveFavourite = useFavouritesStore(s => s.move);
  const createFavouriteFolder = useFavouritesStore(s => s.createFolder);
  const renameFavourite = useFavouritesStore(s => s.rename);
  const removeFavourite = useFavouritesStore(s => s.remove);
  const starred = useMemo(
    () => starredRefs(favourites, "dashboard"),
    [favourites],
  );
  useEffect(() => {
    if (workspaceId) void fetchFavourites(workspaceId);
  }, [workspaceId, fetchFavourites]);
  const handleToggleStar = useCallback(
    (dashboardId: string) => {
      if (!workspaceId) return;
      void toggleFavourite(
        workspaceId,
        "dashboard",
        dashboardId,
        !starred.has(dashboardId),
      );
    },
    [workspaceId, toggleFavourite, starred],
  );
  /**
   * Every dashboard in the tree, from the RAW store entries — a dashboard is
   * a leaf there; `withDataSourceNodes` turns it into a directory later.
   */
  const allDashboards = useMemo(
    () =>
      flattenLeafRows([
        ...(tree.myItems as ResourceTreeNode[]),
        ...(tree.workspaceItems as ResourceTreeNode[]),
      ]),
    [tree.myItems, tree.workspaceItems],
  );

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
    if (favouriteIdFromFolderRow(node.id)) return;
    // A pinned row points at the same dashboard as its real row below.
    focusDashboardTab(realEntityId(node.id), node.name);
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
      // Rows under Starred are this person's own: always theirs to manage.
      // (Pinned rows keep a real icon and stay draggable this way, too.)
      if (isStarredRow(node.id)) return true;
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

  const getItemIcon = useCallback(
    (node: ResourceTreeNode) => {
      // Data source leaves keep their database glyph.
      if (node.id.includes(DASHBOARD_DATA_SOURCE_SEP)) {
        return <DataSourceIcon size={16} strokeWidth={1.5} />;
      }
      // Dashboards carry a dashboard glyph. Folders (both real folders and the
      // synthetic "Data sources" folder) show no icon — matching the consoles
      // explorer, where only leaves carry icons. Returning null lets ResourceTree
      // collapse the icon column so the label sits right after the chevron.
      if (node.entityType === "dashboard") {
        // Only a PINNED row under Starred carries the access overlay: it has
        // left the section that would otherwise say who can see it.
        if (entityIdFromStarredRow(node.id)) {
          return (
            <AccessIcon
              Glyph={DashboardIcon}
              state={resolveAccessState(node, user?.id)}
              kindLabel="Dashboard"
              size={20}
            />
          );
        }
        return <DashboardIcon size={20} strokeWidth={1.5} />;
      }
      return null;
    },
    [user?.id],
  );

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

  const sectionsDef = useMemo(() => {
    const byId = new Map(allDashboards.map(d => [d.id, d]));
    return [
      ...buildStarredSection(
        favourites,
        "dashboard",
        refId => {
          const node = byId.get(refId);
          // Raw entries carry no entityType; the pinned row needs the one
          // getItemIcon looks for. A pinned row is a leaf: the real row
          // below owns the data-source children.
          return node
            ? {
                name: node.name,
                path: node.path,
                entityType: "dashboard",
                access: node.access,
                owner_id: node.owner_id,
              }
            : undefined;
        },
        { droppable: true },
      ),
      ...tree.sections({ my: "My Dashboards" }, withDataSourceNodes),
    ];
  }, [favourites, allDashboards, tree, withDataSourceNodes]);

  /**
   * Rows under Starred are views, not rows the dashboard tree owns: their
   * moves, renames and deletes go to the favourites store.
   */
  const treeHandlers = useMemo(() => {
    const { onMoveItem, onMoveFolder, onRenameItem, onDeleteItem, ...rest } =
      tree.treeHandlers;
    const moveStarred = (id: string, targetId: string | null) => {
      if (!workspaceId) return;
      const targetFav = targetId ? favouriteIdFromFolderRow(targetId) : null;
      const pinnedTarget = targetId ? entityIdFromStarredRow(targetId) : null;
      if (targetId && targetFav === null && pinnedTarget === null) return;
      const dest =
        targetFav ??
        (pinnedTarget
          ? (favourites.find(f => f.refId === pinnedTarget)?.parentId ?? null)
          : null);
      const pinned = entityIdFromStarredRow(id);
      const favId = pinned
        ? favourites.find(f => f.kind === "dashboard" && f.refId === pinned)?.id
        : favouriteIdFromFolderRow(id);
      if (favId) void moveFavourite(workspaceId, favId, dest);
    };
    // A real row dropped into a Starred folder: star it there — or, when
    // it is already starred, MOVE the existing star (adding again is
    // idempotent server-side and the row would snap back).
    const starInto = (id: string, folderId: string) => {
      if (!workspaceId) return;
      const fav = favouriteIdFromFolderRow(folderId);
      const existing = favouriteFor(favourites, "dashboard", id);
      if (existing) void moveFavourite(workspaceId, existing.id, fav);
      else void toggleFavourite(workspaceId, "dashboard", id, true, fav);
    };
    return {
      ...rest,
      onMoveItem: (id: string, folderId: string | null, access?: string) => {
        if (isStarredRow(id)) moveStarred(id, folderId);
        else if (folderId && isStarredRow(folderId)) {
          if (isDashboardEntryId(id)) starInto(id, folderId);
        } else onMoveItem(id, folderId, access);
      },
      onMoveFolder: (id: string, parentId: string | null, access?: string) => {
        if (isStarredRow(id)) moveStarred(id, parentId);
        else if (parentId && isStarredRow(parentId)) {
          // A dashboard row is a directory (its data sources): starring it.
          // A dashboard FOLDER dropped here is refused — an item pointing at
          // a folder id would be invisible and impossible to remove.
          if (isDashboardEntryId(id)) starInto(id, parentId);
        } else onMoveFolder(id, parentId, access);
      },
      onRenameItem: (id: string, name: string, isDirectory: boolean) => {
        const fav = favouriteIdFromFolderRow(id);
        if (fav) {
          if (workspaceId) void renameFavourite(workspaceId, fav, name);
        } else if (!isStarredRow(id)) onRenameItem(id, name, isDirectory);
      },
      onDeleteItem: (node: ResourceTreeNode) => {
        const pinned = entityIdFromStarredRow(node.id);
        const fav = favouriteIdFromFolderRow(node.id);
        if (pinned) handleToggleStar(pinned);
        else if (fav) {
          if (workspaceId) void removeFavourite(workspaceId, fav);
        } else onDeleteItem(node);
      },
      onCreateFolder: async (parentId: string | null, access?: string) => {
        const fav = parentId ? favouriteIdFromFolderRow(parentId) : null;
        if (!parentId || fav === null) {
          return tree.treeHandlers.onCreateFolder(parentId, access);
        }
        if (!workspaceId) return null;
        const row = await createFavouriteFolder(workspaceId, "New folder", fav);
        return row
          ? { id: `__starfolder__${row.id}`, name: row.title ?? "" }
          : null;
      },
    };
  }, [
    tree.treeHandlers,
    workspaceId,
    favourites,
    moveFavourite,
    toggleFavourite,
    renameFavourite,
    removeFavourite,
    handleToggleStar,
    createFavouriteFolder,
    isDashboardEntryId,
  ]);

  const handleSectionDrop = useCallback(
    (sectionKey: string, nodeId: string): boolean => {
      if (sectionKey !== "starred" || !workspaceId) return false;
      const pinned = entityIdFromStarredRow(nodeId);
      const fav = favouriteIdFromFolderRow(nodeId);
      if (fav) void moveFavourite(workspaceId, fav, null);
      else if (pinned) {
        const row = favourites.find(
          f => f.kind === "dashboard" && f.refId === pinned,
        );
        if (row) void moveFavourite(workspaceId, row.id, null);
      } else if (isDashboardEntryId(nodeId)) {
        void toggleFavourite(workspaceId, "dashboard", nodeId, true, null);
      }
      return true;
    },
    [
      workspaceId,
      favourites,
      moveFavourite,
      toggleFavourite,
      isDashboardEntryId,
    ],
  );

  const getContextMenuItems = useCallback(
    (node: ResourceTreeNode, helpers: { closeMenu: () => void }) => {
      const pinnedId = entityIdFromStarredRow(node.id);
      // Only pinned rows get a bespoke menu; every other row keeps the
      // tree's own rename/duplicate/move/info/delete entries.
      if (!pinnedId) return null;
      return [
        <MenuItem
          key="unstar"
          onClick={() => {
            helpers.closeMenu();
            handleToggleStar(pinnedId);
          }}
        >
          <ListItemIcon>
            <StarIcon size={16} fill="currentColor" />
          </ListItemIcon>
          Unstar
        </MenuItem>,
      ];
    },
    [handleToggleStar],
  );

  const getRightAdornment = useCallback(
    (node: ResourceTreeNode) => {
      const pinnedId = entityIdFromStarredRow(node.id);
      const dashboardId =
        pinnedId ?? (node.entityType === "dashboard" ? node.id : null);
      if (!dashboardId) return null;
      return (
        <StarToggle
          starred={starred.has(dashboardId)}
          onToggle={() => handleToggleStar(dashboardId)}
        />
      );
    },
    [starred, handleToggleStar],
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
            {...treeHandlers}
            onSectionDrop={handleSectionDrop}
            getContextMenuItems={getContextMenuItems}
            getRightAdornment={getRightAdornment}
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
