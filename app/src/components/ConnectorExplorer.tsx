import { useEffect, useState, useMemo } from "react";
import {
  Box,
  Typography,
  IconButton,
  CircularProgress,
  Tooltip,
  Alert,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
} from "@mui/material";
import {
  Plus as AddIcon,
  RotateCw as RefreshIcon,
  Trash2 as DeleteIcon,
} from "lucide-react";

import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import { useDataSourceEntitiesStore } from "../store/dataSourceEntitiesStore";
import ResourceTree, {
  type ResourceTreeNode,
  type ResourceTreeSection,
} from "./ResourceTree";
import ExplorerShell from "./ExplorerShell";

interface Connector {
  _id: string;
  name: string;
  description?: string;
  type: string;
  isActive: boolean;
  workspaceId: string;
}

function ConnectorExplorer() {
  const { currentWorkspace } = useWorkspace();
  const { tabs, activeTabId, openTab, setActiveTab } = useConsoleStore();
  const consoleTabs = Object.values(tabs);
  const activeConsoleId = activeTabId;
  const {
    entities,
    loading,
    init,
    refresh,
    delete: deleteSource,
  } = useDataSourceEntitiesStore();

  const connectors: Connector[] = useMemo(() => {
    if (!currentWorkspace) return [];
    return Object.values(entities).filter(
      e => e.workspaceId === currentWorkspace.id,
    ) as Connector[];
  }, [entities, currentWorkspace]);

  const connectorById = useMemo(() => {
    const map = new Map<string, Connector>();
    for (const c of connectors) map.set(c._id, c);
    return map;
  }, [connectors]);

  const [error] = useState<string | null>(null);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<Connector | null>(null);

  const fetchSources = async () => {
    if (!currentWorkspace) return;
    await refresh(currentWorkspace.id);
  };

  useEffect(() => {
    if (currentWorkspace) {
      init(currentWorkspace.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace?.id]);

  const openTabForSource = (source?: Connector) => {
    if (source) {
      const contentKey = source._id;
      const existing = consoleTabs.find(
        t => t.kind === "connectors" && t.content === contentKey,
      );
      if (existing) {
        setActiveTab(existing.id);
        return;
      }

      const id = openTab({
        title: source.name,
        content: contentKey,
        kind: "connectors",
        icon: `/api/connectors/${source.type}/icon.svg`,
      });
      setActiveTab(id);
    } else {
      const id = openTab({
        title: "New Connector",
        content: "",
        kind: "connectors",
      });
      setActiveTab(id);
    }
  };

  const handleAdd = () => openTabForSource(undefined);

  const handleDelete = (item: Connector) => {
    setSelectedItem(item);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!currentWorkspace || !selectedItem) return;
    const res = await deleteSource(currentWorkspace.id, selectedItem._id);
    if (!res.success) {
      console.error("Failed to delete data source:", res.error);
    }
    setDeleteDialogOpen(false);
    setSelectedItem(null);
  };

  const sections = useMemo<ResourceTreeSection[]>(
    () => [
      {
        key: "connectors",
        label: "",
        hideSectionHeader: true,
        nodes: connectors.map(c => ({
          id: c._id,
          name: c.name,
          path: c.name,
          isDirectory: false,
        })),
      },
    ],
    [connectors],
  );

  const getItemIcon = (node: ResourceTreeNode) => {
    const src = connectorById.get(node.id);
    if (!src) return null;
    return (
      <Box
        component="img"
        src={`/api/connectors/${src.type}/icon.svg`}
        alt={`${src.type} icon`}
        sx={{ width: 20, height: 20 }}
      />
    );
  };

  const activeConnectorId = useMemo(() => {
    if (!activeConsoleId) return null;
    const tab = consoleTabs.find(
      t =>
        t.id === activeConsoleId &&
        t.kind === "connectors" &&
        typeof t.content === "string",
    );
    return tab?.content ?? null;
  }, [consoleTabs, activeConsoleId]);

  const actions = (
    <>
      <Tooltip title="Add Connector">
        <IconButton size="small" onClick={handleAdd}>
          <AddIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
      <Tooltip title="Refresh">
        <IconButton size="small" onClick={fetchSources}>
          <RefreshIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
    </>
  );

  const isLoading = !!(currentWorkspace && loading[currentWorkspace.id]);

  return (
    <>
      <ExplorerShell
        title="Connectors"
        actions={actions}
        searchPlaceholder="Search connectors..."
        error={error}
        loading={isLoading && connectors.length === 0}
        skeleton={
          <Box sx={{ p: 2, textAlign: "center" }}>
            <CircularProgress size={24} />
          </Box>
        }
      >
        {({ searchQuery }) =>
          connectors.length === 0 ? (
            <Box sx={{ p: 3, textAlign: "center", color: "text.secondary" }}>
              <Typography variant="body2">No connectors configured.</Typography>
            </Box>
          ) : (
            <ResourceTree
              sections={sections}
              mode="sidebar"
              searchQuery={searchQuery}
              activeItemId={activeConnectorId || undefined}
              getItemIcon={getItemIcon}
              hideFolderIcon
              isFolderExpanded={() => true}
              onToggleFolder={() => {}}
              onExpandFolder={() => {}}
              getFolderExpansionKey={node => node.id}
              onItemClick={node => {
                const src = connectorById.get(node.id);
                if (src) openTabForSource(src);
              }}
              getContextMenuItems={(node, { closeMenu }) => {
                const src = connectorById.get(node.id);
                if (!src) return null;
                return [
                  <MenuItem
                    key="delete"
                    onClick={() => {
                      closeMenu();
                      handleDelete(src);
                    }}
                  >
                    <DeleteIcon
                      size={16}
                      strokeWidth={1.5}
                      style={{ marginRight: 8 }}
                    />
                    Delete
                  </MenuItem>,
                ];
              }}
            />
          )
        }
      </ExplorerShell>

      <Dialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Delete Connector</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            This will permanently delete the connector.
          </Alert>
          <Typography>
            Are you sure you want to delete &quot;{selectedItem?.name}&quot;?
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button
            onClick={handleDeleteConfirm}
            color="error"
            variant="contained"
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

export default ConnectorExplorer;
