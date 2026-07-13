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
  Stack,
  Tab,
  Tabs,
  Link,
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
import {
  selectTabBySettingsSection,
  useConsoleStore,
} from "../store/consoleStore";
import { SECTION_LABELS } from "../pages/settings/sections";
import { trackEvent } from "../lib/analytics";
import { useApiKeyStore } from "../store/apiKeyStore";
import type { ApiKeyCreateResponse } from "../lib/api-types";

const MCP_STARTER_PROMPT =
  "Using the mako tools, explore my data and build an app showing revenue " +
  "by month, then give me a preview link.";

/**
 * Pointer to the dedicated "Connect Agents" settings page, where the
 * OAuth-first connect flow and the connected-agents list live.
 */
function ConnectAgentsPointer() {
  const openAgentsSettings = () => {
    const state = useConsoleStore.getState();
    const existing = selectTabBySettingsSection("agents")(state);
    if (existing) {
      state.setActiveTab(existing.id);
      return;
    }
    const id = state.openTab({
      title: SECTION_LABELS.agents,
      content: "",
      kind: "settings",
      settingsSection: "agents",
    });
    state.setActiveTab(id);
  };

  return (
    <Alert severity="info" sx={{ mb: 3 }}>
      Connecting Claude, Cursor, or Codex? No API key needed — agents sign in
      with your Mako account. Set up and manage them in{" "}
      <Link
        component="button"
        type="button"
        onClick={openAgentsSettings}
        sx={{ verticalAlign: "baseline" }}
      >
        Settings → Connect Agents
      </Link>
      . API keys below are for the REST API and headless MCP (CI / servers).
    </Alert>
  );
}

/**
 * Per-client MCP setup shown the one time the full key is visible: pick your
 * client, see only your path. Base URL is this deployment's origin (the Vite
 * dev server proxies /api). Cursor additionally gets a one-click install
 * deeplink (cursor.com/docs/mcp/install-links).
 */
function buildMcpClientSetups(key: string) {
  const endpoint = `${window.location.origin}/api/mcp`;
  const cursorConfig = {
    url: endpoint,
    headers: { Authorization: `Bearer ${key}` },
  };
  const cursorDeeplink =
    "cursor://anysphere.cursor-deeplink/mcp/install?name=mako&config=" +
    encodeURIComponent(btoa(JSON.stringify(cursorConfig)));
  return [
    {
      client: "Claude Code",
      instruction:
        "Run this in your terminal, then verify with `claude mcp list`:",
      snippet: `claude mcp add --transport http mako ${endpoint} \\\n  --header "Authorization: Bearer ${key}"`,
    },
    {
      client: "Cursor",
      instruction:
        "One click below — Cursor opens and asks to install. Or paste the JSON into .cursor/mcp.json:",
      snippet: JSON.stringify({ mcpServers: { mako: cursorConfig } }, null, 2),
      deeplink: cursorDeeplink,
    },
    {
      client: "Codex",
      instruction: `Add this to ~/.codex/config.toml, then export MAKO_API_KEY="${key.slice(0, 14)}..." in your shell:`,
      snippet: `[mcp_servers.mako]\nurl = "${endpoint}"\nbearer_token_env_var = "MAKO_API_KEY"\n\n# then: export MAKO_API_KEY="${key}"`,
    },
    {
      client: "Other",
      instruction:
        "Any MCP client that speaks Streamable HTTP works — one endpoint, one Bearer header:",
      snippet: `URL     ${endpoint}\nHeader  Authorization: Bearer ${key}`,
    },
  ];
}

function McpConnectSection({
  apiKey,
  onCopy,
}: {
  apiKey: string;
  onCopy: (text: string) => void;
}) {
  const [tab, setTab] = useState(0);
  const setups = buildMcpClientSetups(apiKey);
  const active = setups[tab] ?? setups[0];

  return (
    <Box sx={{ mt: 3 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
        Use this key with MCP (headless / CI)
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Interactive agents can connect without a key — see &quot;Connect an AI
        agent&quot; on the API Keys page (they sign in instead). Use these
        key-based setups where a browser sign-in isn&apos;t possible. The key is
        already filled in.{" "}
        <a
          href="https://docs.mako.ai/mcp-server/"
          target="_blank"
          rel="noreferrer"
        >
          Full guide
        </a>
      </Typography>
      <Tabs
        value={tab}
        onChange={(_e, value: number) => setTab(value)}
        variant="scrollable"
        allowScrollButtonsMobile
        sx={{ minHeight: 36, mb: 1.5, borderBottom: 1, borderColor: "divider" }}
      >
        {setups.map(setup => (
          <Tab
            key={setup.client}
            label={setup.client}
            sx={{ minHeight: 36, py: 0.5, textTransform: "none" }}
          />
        ))}
      </Tabs>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {active.instruction}
      </Typography>
      {active.deeplink && (
        <Button
          variant="contained"
          size="small"
          href={active.deeplink}
          sx={theme => ({
            mb: 1.5,
            textTransform: "none",
            // Rendered as an <a>: keep the label readable even under global
            // anchor color resets (see McpAgentsPanel).
            color: "primary.contrastText",
            WebkitTextFillColor: theme.palette.primary.contrastText,
            "&:hover": {
              color: "primary.contrastText",
              WebkitTextFillColor: theme.palette.primary.contrastText,
            },
          })}
        >
          Add to Cursor
        </Button>
      )}
      <Box sx={{ position: "relative" }}>
        <Box
          component="pre"
          sx={{
            m: 0,
            p: 1.5,
            pr: 6,
            bgcolor: "grey.100",
            borderRadius: 1,
            fontSize: "0.7rem",
            overflow: "auto",
            whiteSpace: "pre",
          }}
        >
          {active.snippet}
        </Box>
        <Tooltip title={`Copy ${active.client} setup`}>
          <IconButton
            size="small"
            onClick={() => onCopy(active.snippet)}
            aria-label={`Copy ${active.client} setup`}
            sx={{ position: "absolute", top: 6, right: 6 }}
          >
            <CopyIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ mt: 2, mb: 0.5 }}
      >
        Then ask it something:
      </Typography>
      <Stack direction="row" alignItems="flex-start" spacing={0.5}>
        <Box
          sx={{
            flex: 1,
            p: 1.5,
            bgcolor: "grey.100",
            borderRadius: 1,
            fontStyle: "italic",
            fontSize: "0.8rem",
          }}
        >
          &quot;{MCP_STARTER_PROMPT}&quot;
        </Box>
        <Tooltip title="Copy starter prompt">
          <IconButton
            size="small"
            onClick={() => onCopy(MCP_STARTER_PROMPT)}
            aria-label="Copy starter prompt"
          >
            <CopyIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
    </Box>
  );
}

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

  const workspaceId = currentWorkspace?.id;

  return (
    <Box>
      <ConnectAgentsPointer />

      {workspaceId && (
        <Alert severity="info" sx={{ mb: 3 }}>
          <Typography variant="subtitle2" gutterBottom sx={{ fontWeight: 600 }}>
            Workspace ID
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Use this value as{" "}
            <Box component="span" sx={{ fontFamily: "monospace" }}>
              :workspaceId
            </Box>{" "}
            in API paths (for example{" "}
            <Box
              component="span"
              sx={{ fontFamily: "monospace", fontSize: "0.8rem" }}
            >
              /api/workspaces/{workspaceId}/execute
            </Box>
            ).
          </Typography>
          <Stack
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{ flexWrap: "wrap" }}
          >
            <Box
              component="code"
              sx={{
                flex: 1,
                minWidth: 0,
                p: 1,
                pr: 0.5,
                borderRadius: 1,
                bgcolor: "action.hover",
                fontFamily: "monospace",
                fontSize: "0.8rem",
                wordBreak: "break-all",
              }}
            >
              {workspaceId}
            </Box>
            <Tooltip title="Copy workspace ID">
              <IconButton
                size="small"
                onClick={() => copyToClipboard(workspaceId)}
                aria-label="Copy workspace ID"
              >
                <CopyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Alert>
      )}

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
          No API keys yet. AI agents connect via MCP without one (see above) —
          create a key for the REST API or headless MCP use (CI, servers).
        </Alert>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Key Prefix</TableCell>
                <TableCell>Access</TableCell>
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
                    {key.scopes && key.scopes.length > 0 ? (
                      <Stack direction="row" spacing={0.5}>
                        {key.scopes.map(scope => (
                          <Chip key={scope} label={scope} size="small" />
                        ))}
                      </Stack>
                    ) : (
                      <Tooltip title="Created before scopes existed. Works for the REST API but cannot connect MCP clients (Claude Code, Cursor, Codex) — create a new key for that.">
                        <Chip label="legacy" size="small" color="warning" />
                      </Tooltip>
                    )}
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
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>API Key Created Successfully</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            Store this key securely - it won&apos;t be shown again!
          </Alert>
          {workspaceId && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="body2" color="text.secondary" gutterBottom>
                Workspace ID
              </Typography>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Box
                  component="code"
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    p: 1,
                    borderRadius: 1,
                    bgcolor: "grey.100",
                    fontFamily: "monospace",
                    fontSize: "0.8rem",
                    wordBreak: "break-all",
                  }}
                >
                  {workspaceId}
                </Box>
                <Tooltip title="Copy workspace ID">
                  <IconButton
                    size="small"
                    onClick={() => copyToClipboard(workspaceId)}
                    aria-label="Copy workspace ID"
                  >
                    <CopyIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            </Box>
          )}
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
          {newApiKey?.key && (
            <McpConnectSection
              apiKey={newApiKey.key}
              onCopy={copyToClipboard}
            />
          )}
          <Box sx={{ mt: 3 }}>
            <Typography variant="body2" color="text.secondary">
              Or use it against the REST API directly:
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
            {workspaceId && (
              <>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ mt: 2 }}
                >
                  Example endpoint (replace BASE_URL with your API host):
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
                  {`POST BASE_URL/api/workspaces/${workspaceId}/execute`}
                </Box>
              </>
            )}
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
