import { useState, useEffect } from "react";
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
import { useWorkspace } from "../contexts/workspace-context";
import { trackEvent } from "../lib/analytics";
import { useApiKeyStore } from "../store/apiKeyStore";
import type { ApiKeyCreateResponse } from "../lib/api-types";

export function ApiKeyManager() {
  const { currentWorkspace, loading: workspaceLoading } = useWorkspace();
  const { keys, loading, fetchKeys, createKey, deleteKey } = useApiKeyStore();
  const apiKeys = currentWorkspace ? keys[currentWorkspace.id] || [] : [];
  const isLoading = currentWorkspace
    ? !!loading[`fetch:${currentWorkspace.id}`]
    : false;
  const isCreating = currentWorkspace
    ? !!loading[`create:${currentWorkspace.id}`]
    : false;
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [newApiKey, setNewApiKey] = useState<
    (ApiKeyCreateResponse["apiKey"] & { key?: string }) | null
  >(null);
  const [showKey, setShowKey] = useState(false);
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: "success" | "error";
  }>({ open: false, message: "", severity: "success" });

  useEffect(() => {
    if (!workspaceLoading && currentWorkspace) {
      fetchKeys(currentWorkspace.id).catch(() => {
        setSnackbar({
          open: true,
          message: "Failed to fetch API keys",
          severity: "error",
        });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace?.id, workspaceLoading]);

  // Create new API key
  const handleCreateApiKey = async () => {
    if (!currentWorkspace || !newKeyName.trim()) return;

    setCreateError(null);

    try {
      const response = await createKey(currentWorkspace.id, newKeyName.trim());

      if (!response.success || !response.apiKey) {
        setCreateError(response.error || "Failed to create API key");
        return;
      }

      // Track API key creation only after confirming success
      trackEvent("api_key_created", {
        key_name: newKeyName.trim(),
      });

      setNewApiKey({
        ...response.apiKey,
        key: response.key,
      });
      setShowKey(true);
      setCreateDialogOpen(false);
      setNewKeyName("");
    } catch (error: any) {
      setCreateError(error.message || "Failed to create API key");
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
      const response = await deleteKey(currentWorkspace.id, keyId);
      if (!response.success) {
        throw new Error(response.error || "Failed to delete API key");
      }

      setSnackbar({
        open: true,
        message: "API key deleted successfully",
        severity: "success",
      });
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
      <Box sx={{ display: "flex", justifyContent: "flex-end", mb: 3 }}>
        <Button
          variant="contained"
          size="small"
          startIcon={<AddIcon />}
          onClick={() => setCreateDialogOpen(true)}
        >
          Create API Key
        </Button>
      </Box>

      {isLoading ? (
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
        onClose={() => !isCreating && setCreateDialogOpen(false)}
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
              disabled={isCreating}
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setCreateDialogOpen(false)}
            disabled={isCreating}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreateApiKey}
            variant="contained"
            disabled={!newKeyName.trim() || isCreating}
          >
            {isCreating ? "Creating..." : "Create"}
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
            Store this key securely - it won&apos;t be shown again!
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
