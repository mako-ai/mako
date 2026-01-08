import React, { useState, useEffect } from "react";
import {
  Box,
  Typography,
  Button,
  IconButton,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Tooltip,
  Chip,
  Skeleton,
  Snackbar,
} from "@mui/material";
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  ContentCopy as CopyIcon,
  Visibility as VisibilityIcon,
  VisibilityOff as VisibilityOffIcon,
} from "@mui/icons-material";
import { formatDistanceToNow } from "date-fns";
import { apiClient } from "../lib/api-client";
import { useWorkspace } from "../contexts/workspace-context";
import { trackEvent } from "../lib/analytics";

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  createdBy: string;
}

interface NewApiKeyResponse {
  id: string;
  name: string;
  prefix: string;
  key: string;
  createdAt: string;
}

export function ApiKeyManager() {
  const { currentWorkspace, loading: workspaceLoading } = useWorkspace();
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newApiKey, setNewApiKey] = useState<NewApiKeyResponse | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: "success" | "error";
  }>({ open: false, message: "", severity: "success" });

  // Fetch API keys
  const fetchApiKeys = async () => {
    if (workspaceLoading || !currentWorkspace) return;

    try {
      setLoading(true);
      const response = await apiClient.get<{
        success: boolean;
        apiKeys: ApiKey[];
      }>(`/workspaces/${currentWorkspace.id}/api-keys`);
      setApiKeys(response.apiKeys || []);
    } catch (error) {
      console.error("Failed to fetch API keys:", error);
      setSnackbar({
        open: true,
        message: "Failed to fetch API keys",
        severity: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchApiKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace?.id, workspaceLoading]);

  // Create new API key
  const handleCreateApiKey = async () => {
    if (!currentWorkspace || !newKeyName.trim()) return;

    setCreating(true);
    setCreateError(null);

    try {
      const response = await apiClient.post<{
        success: boolean;
        apiKey: NewApiKeyResponse;
      }>(`/workspaces/${currentWorkspace.id}/api-keys`, {
        name: newKeyName.trim(),
      });

      // Track API key creation
      trackEvent("api_key_created", {
        key_name: newKeyName.trim(),
      });

      setNewApiKey(response.apiKey);
      setShowKey(true);
      setCreateDialogOpen(false);
      setNewKeyName("");

      // Refresh the list
      fetchApiKeys();
    } catch (error: any) {
      setCreateError(error.message || "Failed to create API key");
    } finally {
      setCreating(false);
    }
  };

  // Delete API key
  const handleDeleteApiKey = async (keyId: string) => {
    if (!currentWorkspace) return;

    if (
      !confirm(
        "Are you sure you want to delete this API key? This action cannot be undone.",
      )
    ) {
      return;
    }

    try {
      await apiClient.delete(
        `/workspaces/${currentWorkspace.id}/api-keys/${keyId}`,
      );

      setSnackbar({
        open: true,
        message: "API key deleted successfully",
        severity: "success",
      });

      // Refresh the list
      fetchApiKeys();
    } catch (error) {
      console.error("Failed to delete API key:", error);
      setSnackbar({
        open: true,
        message: "Failed to delete API key",
        severity: "error",
      });
    }
  };

  // Copy to clipboard
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setSnackbar({
      open: true,
      message: "Copied to clipboard",
      severity: "success",
    });
  };

  return (
    <Box>
      <Box sx={{ display: "flex", justifyContent: "space-between", mb: 3 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          API Keys
        </Typography>
        <Button
          variant="contained"
          size="small"
          startIcon={<AddIcon />}
          onClick={() => setCreateDialogOpen(true)}
        >
          Create API Key
        </Button>
      </Box>

      {loading ? (
        <Box>
          <Skeleton variant="rectangular" height={60} sx={{ mb: 1 }} />
          <Skeleton variant="rectangular" height={60} sx={{ mb: 1 }} />
          <Skeleton variant="rectangular" height={60} />
        </Box>
      ) : apiKeys.length === 0 ? (
        <Alert severity="info">
          No API keys found. Create one to enable API access for third-party
          applications.
        </Alert>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Key Prefix</TableCell>
                <TableCell>Created</TableCell>
                <TableCell>Last Used</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {apiKeys.map(key => (
                <TableRow key={key.id}>
                  <TableCell>{key.name}</TableCell>
                  <TableCell>
                    <Chip
                      label={key.prefix}
                      size="small"
                      variant="outlined"
                      sx={{ fontFamily: "monospace" }}
                    />
                  </TableCell>
                  <TableCell>
                    {formatDistanceToNow(new Date(key.createdAt), {
                      addSuffix: true,
                    })}
                  </TableCell>
                  <TableCell>
                    {key.lastUsedAt
                      ? formatDistanceToNow(new Date(key.lastUsedAt), {
                          addSuffix: true,
                        })
                      : "Never"}
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title="Delete API Key">
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => handleDeleteApiKey(key.id)}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Create API Key Dialog */}
      <Dialog
        open={createDialogOpen}
        onClose={() => !creating && setCreateDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Create API Key</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 2 }}>
            <TextField
              autoFocus
              label="API Key Name"
              fullWidth
              value={newKeyName}
              onChange={e => setNewKeyName(e.target.value)}
              placeholder="e.g., Production App"
              error={!!createError}
              helperText={createError || "Give your API key a descriptive name"}
              disabled={creating}
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setCreateDialogOpen(false)}
            disabled={creating}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreateApiKey}
            variant="contained"
            disabled={!newKeyName.trim() || creating}
          >
            {creating ? "Creating..." : "Create"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* New API Key Display Dialog */}
      <Dialog
        open={!!newApiKey}
        onClose={() => setNewApiKey(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>API Key Created Successfully</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            Store this key securely - it won't be shown again!
          </Alert>
          <Box sx={{ mb: 2 }}>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              API Key Name
            </Typography>
            <Typography variant="body1" sx={{ fontWeight: 500 }}>
              {newApiKey?.name}
            </Typography>
          </Box>
          <Box>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              API Key
            </Typography>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                p: 1.5,
                bgcolor: "grey.100",
                borderRadius: 1,
                fontFamily: "monospace",
                fontSize: "0.875rem",
              }}
            >
              <Box sx={{ flex: 1, overflow: "hidden" }}>
                {showKey ? (
                  <Box component="span" sx={{ wordBreak: "break-all" }}>
                    {newApiKey?.key}
                  </Box>
                ) : (
                  "••••••••••••••••••••••••••••••••"
                )}
              </Box>
              <IconButton
                size="small"
                onClick={() => setShowKey(!showKey)}
                sx={{ flexShrink: 0 }}
              >
                {showKey ? <VisibilityOffIcon /> : <VisibilityIcon />}
              </IconButton>
              <IconButton
                size="small"
                onClick={() => copyToClipboard(newApiKey?.key || "")}
                sx={{ flexShrink: 0 }}
              >
                <CopyIcon />
              </IconButton>
            </Box>
          </Box>
          <Box sx={{ mt: 3 }}>
            <Typography variant="body2" color="text.secondary">
              Use this API key in your requests:
            </Typography>
            <Box
              component="pre"
              sx={{
                mt: 1,
                p: 1.5,
                bgcolor: "grey.100",
                borderRadius: 1,
                fontSize: "0.75rem",
                overflow: "auto",
              }}
            >
              {`Authorization: Bearer ${newApiKey?.key}`}
            </Box>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewApiKey(null)} variant="contained">
            Done
          </Button>
        </DialogActions>
      </Dialog>

      {/* Snackbar for notifications */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        message={snackbar.message}
      />
    </Box>
  );
}
