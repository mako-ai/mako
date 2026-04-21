import { useEffect, useState, useMemo } from "react";
import {
  Box,
  Typography,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  CircularProgress,
  Tooltip,
  Alert,
  Menu,
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

  const [error] = useState<string | null>(null);

  // Context-menu & delete handling state
  const [contextMenu, setContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    item: Connector;
  } | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<Connector | null>(null);

  const fetchSources = async () => {
    if (!currentWorkspace) return;
    const list = await refresh(currentWorkspace.id);
    if (!list.length) {
      // Could set error based on future error handling in store
    }
  };

  useEffect(() => {
    if (currentWorkspace) {
      init(currentWorkspace.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace?.id]);

  const openTabForSource = (source?: Connector) => {
    // If editing an existing source, try to reuse an open tab; for a new source always open a fresh tab
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
      // Always create a new tab for a brand-new data source form
      const id = openTab({
        title: "New Connector",
        content: "", // will be populated after save
        kind: "connectors",
      });
      setActiveTab(id);
    }
  };

  const handleAdd = () => openTabForSource(undefined);

  // ---------- Context menu helpers ----------
  const handleContextMenu = (
    event: React.MouseEvent<HTMLDivElement, MouseEvent>,
    item: Connector,
  ) => {
    event.preventDefault();
    setContextMenu({
      mouseX: event.clientX + 2,
      mouseY: event.clientY - 6,
      item,
    });
  };

  const handleContextMenuClose = () => setContextMenu(null);

  const handleDelete = (item: Connector) => {
    setSelectedItem(item);
    setDeleteDialogOpen(true);
    handleContextMenuClose();
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

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <Box
        sx={{
          px: 1,
          py: 0.25,
          minHeight: 37,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            height: "100%",
            minHeight: 32,
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
            Connectors
          </Typography>
          <Box sx={{ display: "flex", gap: 0 }}>
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
          </Box>
        </Box>
      </Box>

      {/* List */}
      <Box sx={{ flexGrow: 1, overflow: "auto" }}>
        {currentWorkspace && loading[currentWorkspace.id] ? (
          <Box sx={{ p: 2, textAlign: "center" }}>
            <CircularProgress size={24} />
          </Box>
        ) : error ? (
          <Box sx={{ p: 2 }}>
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          </Box>
        ) : connectors.length === 0 ? (
          <Box sx={{ p: 3, textAlign: "center", color: "text.secondary" }}>
            <Typography variant="body2">No connectors configured.</Typography>
          </Box>
        ) : (
          <List dense>
            {connectors.map(src => {
              const isActive = !!(
                activeConsoleId &&
                consoleTabs.find(
                  t =>
                    t.id === activeConsoleId &&
                    t.kind === "connectors" &&
                    t.content === src._id,
                )
              );
              return (
                <ListItem key={src._id} disablePadding>
                  <ListItemButton
                    selected={isActive}
                    onClick={() => openTabForSource(src)}
                    onContextMenu={e => handleContextMenu(e, src)}
                  >
                    <ListItemIcon sx={{ minWidth: 32 }}>
                      <Box
                        component="img"
                        src={`/api/connectors/${src.type}/icon.svg`}
                        alt={`${src.type} icon`}
                        sx={{ width: 24, height: 24 }}
                      />
                    </ListItemIcon>
                    <ListItemText primary={src.name} />
                  </ListItemButton>
                </ListItem>
              );
            })}
          </List>
        )}
      </Box>

      {/* Context Menu */}
      <Menu
        open={contextMenu !== null}
        onClose={handleContextMenuClose}
        anchorReference="anchorPosition"
        anchorPosition={
          contextMenu !== null
            ? { top: contextMenu.mouseY, left: contextMenu.mouseX }
            : undefined
        }
      >
        <MenuItem onClick={() => contextMenu && handleDelete(contextMenu.item)}>
          <DeleteIcon size={18} strokeWidth={1.5} style={{ marginRight: 8 }} />
          Delete
        </MenuItem>
      </Menu>

      {/* Delete Confirmation Dialog */}
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
    </Box>
  );
}

export default ConnectorExplorer;
