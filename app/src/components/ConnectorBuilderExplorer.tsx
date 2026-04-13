import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogContentText,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  Plus as AddIcon,
  RefreshCw as RefreshIcon,
  SquareTerminal as BuilderIcon,
  Trash2 as DeleteIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import {
  useConnectorBuilderStore,
  type UserConnector,
} from "../store/connectorBuilderStore";

function ConnectorBuilderExplorer() {
  const { currentWorkspace } = useWorkspace();
  const { tabs, activeTabId, openTab, setActiveTab, closeTab } =
    useConsoleStore();
  const {
    connectors,
    loading,
    error,
    fetchConnectors,
    fetchTemplates,
    createConnector,
    createConnectorFromTemplate,
    deleteConnector,
    selectConnector,
  } = useConnectorBuilderStore();
  const [contextMenu, setContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    connector: UserConnector;
  } | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedConnector, setSelectedConnector] =
    useState<UserConnector | null>(null);
  const [creating, setCreating] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [templateOptions, setTemplateOptions] = useState<
    Array<{ id: string; name: string; description: string; category: string }>
  >([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [newConnectorName, setNewConnectorName] = useState("");

  const workspaceId = currentWorkspace?.id;
  const workspaceConnectors = useMemo(
    () => (workspaceId ? connectors[workspaceId] || [] : []),
    [connectors, workspaceId],
  );
  const tabsList = Object.values(tabs);

  useEffect(() => {
    if (!workspaceId) {
      return;
    }

    void fetchConnectors(workspaceId).catch(() => undefined);
  }, [fetchConnectors, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !createDialogOpen || templateOptions.length > 0) {
      return;
    }

    void fetchTemplates(workspaceId)
      .then(setTemplateOptions)
      .catch(() => undefined);
  }, [createDialogOpen, fetchTemplates, templateOptions.length, workspaceId]);

  const openConnectorTab = (connector: UserConnector) => {
    const existing = tabsList.find(
      tab =>
        tab.kind === "connector-studio" &&
        tab.metadata?.connectorId === connector._id,
    );

    selectConnector(connector._id);

    if (existing) {
      setActiveTab(existing.id);
      return;
    }

    const id = openTab({
      title: connector.name,
      content: connector.source.code,
      kind: "connector-studio",
      metadata: {
        connectorId: connector._id,
      },
    });

    setActiveTab(id);
  };

  const handleCreate = async () => {
    if (!workspaceId || creating) {
      return;
    }

    setCreating(true);
    try {
      const connector = selectedTemplateId
        ? await createConnectorFromTemplate(workspaceId, {
            templateId: selectedTemplateId,
            name: newConnectorName || undefined,
          })
        : await createConnector(workspaceId, {
            name: newConnectorName || "Untitled Connector",
          });
      setCreateDialogOpen(false);
      setSelectedTemplateId("");
      setNewConnectorName("");
      openConnectorTab(connector);
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!workspaceId || !selectedConnector) {
      return;
    }

    await deleteConnector(workspaceId, selectedConnector._id);

    const matchingTab = tabsList.find(
      tab =>
        tab.kind === "connector-studio" &&
        tab.metadata?.connectorId === selectedConnector._id,
    );
    if (matchingTab) {
      closeTab(matchingTab.id);
    }

    setDeleteDialogOpen(false);
    setSelectedConnector(null);
  };

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
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
            Connector Builder
          </Typography>
          <Box sx={{ display: "flex", gap: 0 }}>
            <Tooltip title="New Connector">
              <span>
                <IconButton
                  size="small"
                  onClick={() => setCreateDialogOpen(true)}
                  disabled={creating}
                >
                  {creating ? (
                    <CircularProgress size={16} />
                  ) : (
                    <AddIcon size={20} strokeWidth={2} />
                  )}
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Refresh">
              <IconButton
                size="small"
                onClick={() =>
                  workspaceId
                    ? void fetchConnectors(workspaceId).catch(() => undefined)
                    : undefined
                }
              >
                <RefreshIcon size={20} strokeWidth={2} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
      </Box>

      <Box sx={{ flexGrow: 1, overflow: "auto" }}>
        {workspaceId && loading[workspaceId] ? (
          <Box sx={{ p: 2, textAlign: "center" }}>
            <CircularProgress size={24} />
          </Box>
        ) : workspaceId && error[workspaceId] ? (
          <Box sx={{ p: 2 }}>
            <Alert severity="error">{error[workspaceId]}</Alert>
          </Box>
        ) : workspaceConnectors.length === 0 ? (
          <Box
            sx={{
              p: 3,
              height: "100%",
              display: "flex",
              flexDirection: "column",
              gap: 1.5,
              alignItems: "center",
              justifyContent: "center",
              color: "text.secondary",
              textAlign: "center",
            }}
          >
            <BuilderIcon size={28} strokeWidth={1.5} />
            <Typography variant="body2">
              No user-defined connectors yet.
            </Typography>
            <Button
              variant="outlined"
              onClick={() => setCreateDialogOpen(true)}
            >
              Create connector
            </Button>
          </Box>
        ) : (
          <List dense>
            {workspaceConnectors.map(connector => {
              const isSelected = tabsList.some(
                tab =>
                  tab.id === activeTabId &&
                  tab.kind === "connector-studio" &&
                  tab.metadata?.connectorId === connector._id,
              );

              return (
                <ListItem key={connector._id} disablePadding>
                  <ListItemButton
                    selected={isSelected}
                    onClick={() => openConnectorTab(connector)}
                    onContextMenu={event => {
                      event.preventDefault();
                      setContextMenu({
                        mouseX: event.clientX + 2,
                        mouseY: event.clientY - 6,
                        connector,
                      });
                    }}
                  >
                    <ListItemIcon sx={{ minWidth: 32 }}>
                      <BuilderIcon size={18} strokeWidth={1.75} />
                    </ListItemIcon>
                    <ListItemText
                      primary={connector.name}
                      secondary={connector.bundle.buildHash ? "Built" : "Draft"}
                    />
                  </ListItemButton>
                </ListItem>
              );
            })}
          </List>
        )}
      </Box>

      <Menu
        open={contextMenu !== null}
        onClose={() => setContextMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={
          contextMenu
            ? { top: contextMenu.mouseY, left: contextMenu.mouseX }
            : undefined
        }
      >
        <MenuItem
          onClick={() => {
            if (!contextMenu) {
              return;
            }
            setSelectedConnector(contextMenu.connector);
            setDeleteDialogOpen(true);
            setContextMenu(null);
          }}
        >
          <DeleteIcon size={18} strokeWidth={1.5} style={{ marginRight: 8 }} />
          Delete
        </MenuItem>
      </Menu>

      <Dialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Create Connector</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <DialogContentText>
              Start from a blank connector or choose a starter template.
            </DialogContentText>
            <TextField
              label="Name"
              value={newConnectorName}
              onChange={event => setNewConnectorName(event.target.value)}
              fullWidth
              size="small"
            />
            <TextField
              select
              label="Template"
              value={selectedTemplateId}
              onChange={event => setSelectedTemplateId(event.target.value)}
              fullWidth
              size="small"
              helperText="Optional. Leave blank for an empty starter."
            >
              <MenuItem value="">
                <em>Blank connector</em>
              </MenuItem>
              {templateOptions.map(template => (
                <MenuItem key={template.id} value={template.id}>
                  {template.name} — {template.category}
                </MenuItem>
              ))}
            </TextField>
            {selectedTemplateId ? (
              <Alert severity="info">
                {
                  templateOptions.find(
                    template => template.id === selectedTemplateId,
                  )?.description
                }
              </Alert>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleCreate}
            disabled={creating}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Delete Connector</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            This permanently removes the connector source, build bundle, and any
            related instances.
          </Alert>
          <Typography>Delete &quot;{selectedConnector?.name}&quot;?</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={handleDeleteConfirm}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default ConnectorBuilderExplorer;
