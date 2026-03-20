import { useEffect, useState } from "react";
import {
  Box,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
  Tooltip,
  Alert,
  Skeleton,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
} from "@mui/material";
import {
  Plus as AddIcon,
  RotateCw as RefreshIcon,
  Blocks as ConnectorIcon,
  Trash2 as DeleteIcon,
  MoreVertical as MoreIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useConnectorBuilderStore,
  type UserConnector,
} from "../store/connectorBuilderStore";
import { useConsoleStore } from "../store/consoleStore";
import { apiClient } from "../lib/api-client";

export function ConnectorBuilderExplorer() {
  const { currentWorkspace } = useWorkspace();
  const {
    connectors: connectorsMap,
    loading: loadingMap,
    error: errorMap,
    selectedConnectorId,
    fetchConnectors,
    createConnector,
    deleteConnector,
    selectConnector,
    clearError,
  } = useConnectorBuilderStore();

  const connectors = currentWorkspace
    ? connectorsMap[currentWorkspace.id] || []
    : [];
  const isLoading = currentWorkspace
    ? !!loadingMap[currentWorkspace.id]
    : false;
  const error = currentWorkspace ? errorMap[currentWorkspace.id] || null : null;

  const { openTab, setActiveTab } = useConsoleStore();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [templates, setTemplates] = useState<
    Array<{ id: string; name: string; description: string; category: string }>
  >([]);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [connectorToDelete, setConnectorToDelete] =
    useState<UserConnector | null>(null);

  // Load templates when dialog opens
  useEffect(() => {
    if (createDialogOpen && templates.length === 0 && currentWorkspace?.id) {
      apiClient
        .get<{
          success: boolean;
          data: Array<{
            id: string;
            name: string;
            description: string;
            category: string;
          }>;
        }>(`/workspaces/${currentWorkspace.id}/connector-builder/templates`)
        .then(res => {
          if (res.success) setTemplates(res.data || []);
        })
        .catch(() => {});
    }
  }, [createDialogOpen, templates.length, currentWorkspace?.id]);

  useEffect(() => {
    if (currentWorkspace?.id) {
      fetchConnectors(currentWorkspace.id);
    }
  }, [currentWorkspace?.id, fetchConnectors]);

  const handleRefresh = async () => {
    if (currentWorkspace?.id) {
      await fetchConnectors(currentWorkspace.id);
    }
  };

  const handleCreate = async () => {
    if (!currentWorkspace?.id) return;
    try {
      let connector: UserConnector;

      if (selectedTemplate) {
        // Create from template
        const res = await apiClient.post<{
          success: boolean;
          data: UserConnector;
        }>(
          `/workspaces/${currentWorkspace.id}/connector-builder/connectors/from-template`,
          {
            templateId: selectedTemplate,
            name: newName || undefined,
          },
        );
        if (!res.success) throw new Error("Failed to create from template");
        connector = res.data;
        // Refresh list
        await fetchConnectors(currentWorkspace.id);
      } else {
        connector = await createConnector(currentWorkspace.id, {
          name: newName || "Untitled Connector",
        });
      }

      setCreateDialogOpen(false);
      setNewName("");
      setSelectedTemplate("");
      openConnectorStudio(connector);
    } catch {
      // Error is handled by the store
    }
  };

  const handleDelete = async () => {
    if (!currentWorkspace?.id || !connectorToDelete) return;
    try {
      await deleteConnector(currentWorkspace.id, connectorToDelete._id);
      setDeleteDialogOpen(false);
      setConnectorToDelete(null);
    } catch {
      // Error is handled by the store
    }
  };

  const openConnectorStudio = (connector: UserConnector) => {
    selectConnector(connector._id);

    const existingTab = Object.values(useConsoleStore.getState().tabs).find(
      t =>
        t.kind === "connector-studio" &&
        t.metadata?.connectorId === connector._id,
    );

    if (existingTab) {
      setActiveTab(existingTab.id);
    } else {
      const id = openTab({
        title: connector.name,
        content: connector.source.code,
        kind: "connector-studio",
        metadata: {
          connectorId: connector._id,
          workspaceId: connector.workspaceId,
        },
      });
      setActiveTab(id);
    }
  };

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <Box
        sx={{
          px: 1.5,
          py: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid",
          borderColor: "divider",
          minHeight: 40,
        }}
      >
        <Typography variant="subtitle2" fontWeight={600} noWrap>
          Connector Builder
        </Typography>
        <Box sx={{ display: "flex", gap: 0.5 }}>
          <Tooltip title="Refresh">
            <IconButton
              size="small"
              onClick={handleRefresh}
              disabled={isLoading}
            >
              <RefreshIcon size={16} />
            </IconButton>
          </Tooltip>
          <Tooltip title="New Connector">
            <IconButton size="small" onClick={() => setCreateDialogOpen(true)}>
              <AddIcon size={16} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* Error */}
      {error && (
        <Alert
          severity="error"
          onClose={() => currentWorkspace && clearError(currentWorkspace.id)}
          sx={{ mx: 1, mt: 1, fontSize: "0.75rem" }}
        >
          {error}
        </Alert>
      )}

      {/* List */}
      <Box sx={{ flex: 1, overflow: "auto" }}>
        {isLoading && connectors.length === 0 ? (
          <Box sx={{ p: 1 }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton
                key={i}
                variant="rectangular"
                height={40}
                sx={{ mb: 0.5, borderRadius: 1 }}
              />
            ))}
          </Box>
        ) : connectors.length === 0 ? (
          <Box sx={{ p: 2, textAlign: "center" }}>
            <Typography variant="body2" color="text.secondary">
              No connectors yet
            </Typography>
            <Button
              size="small"
              startIcon={<AddIcon size={14} />}
              onClick={() => setCreateDialogOpen(true)}
              sx={{ mt: 1 }}
            >
              Create your first connector
            </Button>
          </Box>
        ) : (
          <List dense disablePadding>
            {connectors.map(connector => (
              <ListItem
                key={connector._id}
                disablePadding
                secondaryAction={
                  <IconButton
                    edge="end"
                    size="small"
                    onClick={e => {
                      e.stopPropagation();
                      setConnectorToDelete(connector);
                      setDeleteDialogOpen(true);
                    }}
                    sx={{ opacity: 0.5, "&:hover": { opacity: 1 } }}
                  >
                    <DeleteIcon size={14} />
                  </IconButton>
                }
              >
                <ListItemButton
                  selected={selectedConnectorId === connector._id}
                  onClick={() => openConnectorStudio(connector)}
                  sx={{ py: 0.75, pr: 5 }}
                >
                  <ListItemIcon sx={{ minWidth: 32 }}>
                    <ConnectorIcon size={16} />
                  </ListItemIcon>
                  <ListItemText
                    primary={connector.name}
                    secondary={
                      connector.bundle?.builtAt
                        ? `v${connector.version}`
                        : "Not built"
                    }
                    primaryTypographyProps={{
                      variant: "body2",
                      noWrap: true,
                      fontWeight:
                        selectedConnectorId === connector._id ? 600 : 400,
                    }}
                    secondaryTypographyProps={{
                      variant: "caption",
                      noWrap: true,
                    }}
                  />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        )}
      </Box>

      {/* Create Dialog */}
      <Dialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>New Connector</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Name (optional)"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleCreate()}
            sx={{ mt: 1, mb: 2 }}
          />

          {templates.length > 0 && (
            <>
              <Typography
                variant="caption"
                fontWeight={600}
                color="text.secondary"
                sx={{ mb: 1, display: "block" }}
              >
                START FROM TEMPLATE (optional)
              </Typography>
              <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
                {templates.map(t => (
                  <Chip
                    key={t.id}
                    label={t.name}
                    variant={selectedTemplate === t.id ? "filled" : "outlined"}
                    color={selectedTemplate === t.id ? "primary" : "default"}
                    onClick={() =>
                      setSelectedTemplate(selectedTemplate === t.id ? "" : t.id)
                    }
                    sx={{ fontSize: "0.75rem" }}
                  />
                ))}
              </Box>
              {selectedTemplate && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ mt: 0.5, display: "block" }}
                >
                  {templates.find(t => t.id === selectedTemplate)?.description}
                </Typography>
              )}
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleCreate} variant="contained">
            Create
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        maxWidth="xs"
      >
        <DialogTitle>Delete Connector</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            Are you sure you want to delete "{connectorToDelete?.name}"? This
            will also remove all associated instances.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleDelete} color="error" variant="contained">
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
