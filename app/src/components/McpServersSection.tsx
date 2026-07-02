/**
 * Settings → MCP Servers management: add/edit MCP servers (Close preset or
 * any custom Streamable-HTTP server), save credentials, test the connection,
 * curate the exposed tool list, and review per-user approval grants.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  ChevronDown,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  Trash2,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import {
  type McpPresetInfo,
  type McpServerInfo,
  type McpWriteScope,
  useMcpStore,
} from "../store/mcpStore";

const WRITE_SCOPE_LABELS: Record<McpWriteScope, string> = {
  read: "Read only",
  write_safe: "Safe writes",
  write_destructive: "Destructive writes",
};

const STATUS_COLORS: Record<
  McpServerInfo["status"],
  "default" | "success" | "warning" | "error"
> = {
  created: "default",
  awaiting_auth: "warning",
  connected: "success",
  error: "error",
};

const STATUS_LABELS: Record<McpServerInfo["status"], string> = {
  created: "Not configured",
  awaiting_auth: "Awaiting credentials",
  connected: "Connected",
  error: "Error",
};

const RISK_TIER_LABELS = {
  read: "Read",
  write: "Write",
  destructive: "Destructive",
} as const;

function AddServerDialog({
  open,
  onClose,
  presets,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  presets: McpPresetInfo[];
  onCreated: (serverId: string) => void;
}) {
  const { currentWorkspace } = useWorkspace();
  const createServer = useMcpStore(s => s.createServer);
  const [presetType, setPresetType] = useState("close");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authType, setAuthType] = useState<"none" | "api_key" | "oauth">(
    "oauth",
  );
  const [authPerformer, setAuthPerformer] = useState<"workspace" | "user">(
    "workspace",
  );
  const [writeScope, setWriteScope] = useState<McpWriteScope>("read");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset = presets.find(p => p.type === presetType);
  const authOptions = preset?.authOptions ?? ["api_key"];

  useEffect(() => {
    if (open) {
      setError(null);
      setName(preset?.type === "custom" ? "" : (preset?.label ?? ""));
      setUrl("");
      setAuthType(preset?.authType ?? "api_key");
      // OAuth's sweet spot is per-user login; default accordingly.
      setAuthPerformer(preset?.authType === "oauth" ? "user" : "workspace");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, presetType]);

  const handleCreate = async () => {
    if (!currentWorkspace) return;
    setSubmitting(true);
    setError(null);
    try {
      const server = await createServer(currentWorkspace.id, {
        name: name.trim(),
        connectorType: presetType,
        url: preset?.urlEditable ? url.trim() : undefined,
        authType,
        authPerformer,
        writeScope,
      });
      onCreated(server.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create server");
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit =
    name.trim().length > 0 &&
    (!preset?.urlEditable || url.trim().startsWith("http"));

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add MCP server</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <FormControl fullWidth size="small">
            <InputLabel id="mcp-preset-label">Connector</InputLabel>
            <Select
              labelId="mcp-preset-label"
              label="Connector"
              value={presetType}
              onChange={e => setPresetType(e.target.value)}
            >
              {presets.map(p => (
                <MenuItem key={p.type} value={p.type}>
                  {p.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          {preset && (
            <Typography variant="body2" color="text.secondary">
              {preset.description}
            </Typography>
          )}
          <TextField
            label="Name"
            size="small"
            fullWidth
            value={name}
            onChange={e => setName(e.target.value)}
            helperText="Shown in tool names, e.g. mcp_close_crm_lead_search"
          />
          {preset?.urlEditable ? (
            <TextField
              label="Server URL"
              size="small"
              fullWidth
              placeholder="https://mcp.example.com/mcp"
              value={url}
              onChange={e => setUrl(e.target.value)}
              helperText="Streamable HTTP endpoint of the MCP server"
            />
          ) : (
            <TextField
              label="Server URL"
              size="small"
              fullWidth
              value={preset?.url ?? ""}
              disabled
            />
          )}
          {authOptions.length > 1 && (
            <FormControl fullWidth size="small">
              <InputLabel id="mcp-auth-label">Authentication</InputLabel>
              <Select
                labelId="mcp-auth-label"
                label="Authentication"
                value={authType}
                onChange={e =>
                  setAuthType(e.target.value as "none" | "api_key" | "oauth")
                }
              >
                {authOptions.includes("oauth") && (
                  <MenuItem value="oauth">
                    Log in with your account (OAuth)
                  </MenuItem>
                )}
                {authOptions.includes("api_key") && (
                  <MenuItem value="api_key">API key / headers</MenuItem>
                )}
                {authOptions.includes("none") && (
                  <MenuItem value="none">No authentication</MenuItem>
                )}
              </Select>
            </FormControl>
          )}
          <FormControl fullWidth size="small">
            <InputLabel id="mcp-performer-label">Credentials</InputLabel>
            <Select
              labelId="mcp-performer-label"
              label="Credentials"
              value={authPerformer}
              onChange={e =>
                setAuthPerformer(e.target.value as "workspace" | "user")
              }
            >
              <MenuItem value="workspace">
                Shared workspace credential (admin-managed)
              </MenuItem>
              <MenuItem value="user">Each user connects their own</MenuItem>
            </Select>
          </FormControl>
          <FormControl fullWidth size="small">
            <InputLabel id="mcp-scope-label">Write access</InputLabel>
            <Select
              labelId="mcp-scope-label"
              label="Write access"
              value={writeScope}
              onChange={e => setWriteScope(e.target.value as McpWriteScope)}
            >
              <MenuItem value="read">Read only</MenuItem>
              <MenuItem value="write_safe">
                Safe writes (create / update)
              </MenuItem>
              <MenuItem value="write_destructive">
                Destructive writes (incl. delete)
              </MenuItem>
            </Select>
          </FormControl>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!canSubmit || submitting}
          onClick={handleCreate}
        >
          {submitting ? "Adding…" : "Add server"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function OAuthConnectSection({
  server,
  onNotify,
}: {
  server: McpServerInfo;
  onNotify: (message: string, severity: "success" | "error") => void;
}) {
  const { currentWorkspace } = useWorkspace();
  const startOAuth = useMcpStore(s => s.startOAuth);
  const [connecting, setConnecting] = useState(false);

  const hasCredential =
    server.authPerformer === "workspace"
      ? server.hasWorkspaceCredential
      : server.hasUserCredential;

  const handleConnect = async () => {
    if (!currentWorkspace) return;
    setConnecting(true);
    try {
      const { authorizationUrl, alreadyAuthorized } = await startOAuth(
        currentWorkspace.id,
        server.id,
      );
      if (alreadyAuthorized) {
        onNotify("Account already connected", "success");
        setConnecting(false);
        return;
      }
      // Hand the browser to the provider's consent screen; it redirects
      // back to /api/mcp/oauth/callback → /settings/mcp.
      window.location.href = authorizationUrl;
    } catch (err) {
      setConnecting(false);
      onNotify(
        err instanceof Error ? err.message : "Failed to start OAuth flow",
        "error",
      );
    }
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle2">
        {server.authPerformer === "workspace"
          ? "Workspace account"
          : "Your account"}
        {hasCredential && (
          <Chip
            label="Connected"
            size="small"
            color="success"
            variant="outlined"
            sx={{ ml: 1 }}
          />
        )}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {server.authPerformer === "user"
          ? "Each member logs in with their own account. The agent acts as you when using these tools."
          : "One shared login for the whole workspace (admin-managed)."}
      </Typography>
      <Button
        variant={hasCredential ? "outlined" : "contained"}
        size="small"
        disabled={connecting}
        startIcon={
          connecting ? (
            <CircularProgress size={14} color="inherit" />
          ) : undefined
        }
        onClick={() => void handleConnect()}
        sx={{ alignSelf: "flex-start" }}
        data-testid="mcp-oauth-connect"
      >
        {connecting
          ? "Redirecting…"
          : hasCredential
            ? "Reconnect account"
            : `Connect ${server.connectorType === "close" ? "Close" : "your"} account`}
      </Button>
    </Stack>
  );
}

function CredentialsForm({
  server,
  preset,
  onSaved,
}: {
  server: McpServerInfo;
  preset: McpPresetInfo | undefined;
  onSaved: () => void;
}) {
  const { currentWorkspace } = useWorkspace();
  const saveCredentials = useMcpStore(s => s.saveCredentials);
  const fields = preset?.headerFields ?? [];
  const isCustom = fields.length === 0;
  const [values, setValues] = useState<Record<string, string>>({});
  const [customHeaders, setCustomHeaders] = useState<
    Array<{ key: string; value: string }>
  >([{ key: "", value: "" }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasCredential =
    server.authPerformer === "workspace"
      ? server.hasWorkspaceCredential
      : server.hasUserCredential;

  const handleSave = async () => {
    if (!currentWorkspace) return;
    setSaving(true);
    setError(null);
    try {
      const headers = isCustom
        ? Object.fromEntries(
            customHeaders
              .filter(h => h.key.trim() && h.value.trim())
              .map(h => [h.key.trim(), h.value.trim()]),
          )
        : Object.fromEntries(
            Object.entries(values).filter(([, v]) => v.trim().length > 0),
          );
      await saveCredentials(currentWorkspace.id, server.id, headers);
      setValues({});
      setCustomHeaders([{ key: "", value: "" }]);
      onSaved();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save credentials",
      );
    } finally {
      setSaving(false);
    }
  };

  const filled = isCustom
    ? customHeaders.some(h => h.key.trim() && h.value.trim())
    : fields.every(
        f => !f.required || (values[f.name] ?? "").trim().length > 0,
      );

  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle2">
        {server.authPerformer === "workspace"
          ? "Workspace credential"
          : "Your credential"}
        {hasCredential && (
          <Chip
            label="Saved"
            size="small"
            color="success"
            variant="outlined"
            sx={{ ml: 1 }}
          />
        )}
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {isCustom ? (
        <>
          {customHeaders.map((h, i) => (
            <Stack key={i} direction="row" spacing={1}>
              <TextField
                label="Header name"
                size="small"
                value={h.key}
                onChange={e =>
                  setCustomHeaders(prev =>
                    prev.map((p, j) =>
                      j === i ? { ...p, key: e.target.value } : p,
                    ),
                  )
                }
                placeholder="Authorization"
                sx={{ flex: 1 }}
              />
              <TextField
                label="Value"
                size="small"
                type="password"
                value={h.value}
                onChange={e =>
                  setCustomHeaders(prev =>
                    prev.map((p, j) =>
                      j === i ? { ...p, value: e.target.value } : p,
                    ),
                  )
                }
                placeholder="Bearer …"
                sx={{ flex: 2 }}
              />
            </Stack>
          ))}
          <Button
            size="small"
            onClick={() =>
              setCustomHeaders(prev => [...prev, { key: "", value: "" }])
            }
            sx={{ alignSelf: "flex-start" }}
          >
            Add header
          </Button>
        </>
      ) : (
        fields.map(field => (
          <TextField
            key={field.name}
            label={field.label}
            size="small"
            fullWidth
            type={field.type === "password" ? "password" : "text"}
            required={field.required}
            helperText={field.helperText}
            value={values[field.name] ?? ""}
            onChange={e =>
              setValues(prev => ({ ...prev, [field.name]: e.target.value }))
            }
            placeholder={hasCredential ? "•••••••• (saved)" : undefined}
          />
        ))
      )}
      <Button
        variant="outlined"
        size="small"
        disabled={!filled || saving}
        onClick={handleSave}
        sx={{ alignSelf: "flex-start" }}
      >
        {saving ? "Saving…" : "Save credentials"}
      </Button>
    </Stack>
  );
}

function ServerDetail({
  server,
  preset,
  isAdmin,
  onNotify,
}: {
  server: McpServerInfo;
  preset: McpPresetInfo | undefined;
  isAdmin: boolean;
  onNotify: (message: string, severity: "success" | "error") => void;
}) {
  const { currentWorkspace } = useWorkspace();
  const {
    testServer,
    updateServer,
    deleteServer,
    fetchGrants,
    revokeGrant,
    grants,
  } = useMcpStore();
  const [testing, setTesting] = useState(false);
  const myGrants = grants[server.id] ?? [];

  useEffect(() => {
    if (currentWorkspace) {
      void fetchGrants(currentWorkspace.id, server.id);
    }
  }, [currentWorkspace, server.id, fetchGrants]);

  const allowedSet = useMemo(
    () =>
      server.toolPolicy.mode === "all"
        ? new Set(server.cachedTools.map(t => t.name))
        : new Set(server.toolPolicy.allowedTools),
    [server],
  );

  const handleTest = async () => {
    if (!currentWorkspace) return;
    setTesting(true);
    const result = await testServer(currentWorkspace.id, server.id);
    setTesting(false);
    onNotify(
      result.ok
        ? "Connected — tool list refreshed"
        : (result.error ?? "Connection failed"),
      result.ok ? "success" : "error",
    );
  };

  const handleToggleTool = async (toolName: string, enabled: boolean) => {
    if (!currentWorkspace) return;
    const next = new Set(allowedSet);
    if (enabled) next.add(toolName);
    else next.delete(toolName);
    const allNames = server.cachedTools.map(t => t.name);
    const coversAll = allNames.every(n => next.has(n));
    await updateServer(currentWorkspace.id, server.id, {
      toolPolicy: coversAll
        ? { mode: "all", allowedTools: [] }
        : { mode: "allowlist", allowedTools: Array.from(next) },
    });
  };

  const handleDelete = async () => {
    if (!currentWorkspace) return;
    if (
      !window.confirm(
        `Remove "${server.name}"? Stored credentials and grants are deleted too.`,
      )
    ) {
      return;
    }
    await deleteServer(currentWorkspace.id, server.id);
    onNotify("Server removed", "success");
  };

  return (
    <Stack spacing={2.5}>
      {server.status === "error" && server.lastError && (
        <Alert severity="error">{server.lastError}</Alert>
      )}

      {server.authType === "oauth" ? (
        <OAuthConnectSection server={server} onNotify={onNotify} />
      ) : server.authType === "api_key" ? (
        <CredentialsForm
          server={server}
          preset={preset}
          onSaved={() => onNotify("Credentials saved", "success")}
        />
      ) : null}

      <Stack direction="row" spacing={1} alignItems="center">
        <Button
          variant="contained"
          size="small"
          startIcon={
            testing ? (
              <CircularProgress size={14} color="inherit" />
            ) : (
              <RefreshCw size={14} />
            )
          }
          disabled={testing}
          onClick={handleTest}
        >
          {server.status === "connected" ? "Refresh tools" : "Test connection"}
        </Button>
        {isAdmin && (
          <Button
            size="small"
            color="error"
            startIcon={<Trash2 size={14} />}
            onClick={handleDelete}
          >
            Remove
          </Button>
        )}
      </Stack>

      {server.cachedTools.length > 0 && (
        <>
          <Divider />
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Tools ({server.cachedTools.length})
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", mb: 1 }}
            >
              Disabled tools are never shown to the agent. Write tools ask for
              approval in chat; read tools run automatically.
            </Typography>
            <Stack spacing={0.25}>
              {server.cachedTools.map(tool => (
                <Stack
                  key={tool.name}
                  direction="row"
                  alignItems="center"
                  spacing={1}
                  sx={{
                    py: 0.25,
                    px: 1,
                    borderRadius: 1,
                    "&:hover": { bgcolor: "action.hover" },
                  }}
                >
                  <Switch
                    size="small"
                    checked={allowedSet.has(tool.name)}
                    disabled={!isAdmin}
                    onChange={e =>
                      void handleToggleTool(tool.name, e.target.checked)
                    }
                  />
                  <Typography
                    variant="body2"
                    sx={{
                      fontFamily: "monospace",
                      minWidth: 0,
                      flex: "0 1 auto",
                    }}
                    noWrap
                  >
                    {tool.name}
                  </Typography>
                  <Chip
                    label={RISK_TIER_LABELS[tool.riskTier]}
                    size="small"
                    variant="outlined"
                    color={
                      tool.riskTier === "read"
                        ? "success"
                        : tool.riskTier === "destructive"
                          ? "error"
                          : "warning"
                    }
                    sx={{ height: 18, fontSize: 11 }}
                  />
                  {tool.description && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      noWrap
                      sx={{ flex: 1, minWidth: 0 }}
                    >
                      {tool.description}
                    </Typography>
                  )}
                </Stack>
              ))}
            </Stack>
          </Box>
          {isAdmin &&
            server.cachedTools.some(t => t.riskTier === "destructive") && (
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={server.toolPolicy.allowDestructiveGrants}
                    onChange={e =>
                      currentWorkspace &&
                      void updateServer(currentWorkspace.id, server.id, {
                        toolPolicy: {
                          allowDestructiveGrants: e.target.checked,
                        },
                      })
                    }
                  />
                }
                label={
                  <Typography variant="body2">
                    Allow members to “Always allow” destructive tools
                  </Typography>
                }
              />
            )}
        </>
      )}

      {myGrants.length > 0 && (
        <>
          <Divider />
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Your approvals
            </Typography>
            <Stack spacing={0.5}>
              {myGrants.map(grant => (
                <Stack
                  key={grant.id}
                  direction="row"
                  alignItems="center"
                  spacing={1}
                >
                  {grant.decision === "always_allow" ? (
                    <ShieldCheck
                      size={14}
                      color="var(--mui-palette-success-main, #2e7d32)"
                    />
                  ) : (
                    <ShieldX
                      size={14}
                      color="var(--mui-palette-error-main, #d32f2f)"
                    />
                  )}
                  <Typography
                    variant="body2"
                    sx={{ fontFamily: "monospace", flex: 1 }}
                  >
                    {grant.toolName}
                  </Typography>
                  <Chip
                    label={
                      grant.decision === "always_allow"
                        ? "Always allowed"
                        : "Always denied"
                    }
                    size="small"
                    variant="outlined"
                    color={
                      grant.decision === "always_allow" ? "success" : "error"
                    }
                    sx={{ height: 18, fontSize: 11 }}
                  />
                  <Tooltip title="Revoke — the agent will ask again next time">
                    <IconButton
                      size="small"
                      onClick={() =>
                        currentWorkspace &&
                        void revokeGrant(
                          currentWorkspace.id,
                          server.id,
                          grant.id,
                        )
                      }
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </Tooltip>
                </Stack>
              ))}
            </Stack>
          </Box>
        </>
      )}
    </Stack>
  );
}

export function McpServersSection() {
  const { currentWorkspace, loading: workspaceLoading } = useWorkspace();
  const { servers, presets, loading, error, fetchServers, fetchPresets } =
    useMcpStore();
  const [addOpen, setAddOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: "success" | "error";
  }>({ open: false, message: "", severity: "success" });

  const isAdmin =
    currentWorkspace?.role === "owner" || currentWorkspace?.role === "admin";

  useEffect(() => {
    if (!workspaceLoading && currentWorkspace) {
      void fetchServers(currentWorkspace.id);
      void fetchPresets();
    }
  }, [workspaceLoading, currentWorkspace, fetchServers, fetchPresets]);

  const notify = (message: string, severity: "success" | "error") =>
    setSnackbar({ open: true, message, severity });

  // Surface the OAuth callback outcome (we land back here with a query flag).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get("oauth_error");
    const oauthConnected = params.get("oauth_connected");
    if (!oauthError && !oauthConnected) return;
    setSnackbar({
      open: true,
      message: oauthError
        ? `OAuth connection failed: ${oauthError}`
        : "Account connected — test the connection to load tools",
      severity: oauthError ? "error" : "success",
    });
    params.delete("oauth_error");
    params.delete("oauth_connected");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (query ? `?${query}` : ""),
    );
  }, []);

  return (
    <Box>
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        sx={{ mb: 2 }}
      >
        <Typography variant="body2" color="text.secondary">
          {servers.length === 0
            ? "No MCP servers connected yet."
            : `${servers.length} server${servers.length === 1 ? "" : "s"} configured.`}
        </Typography>
        {isAdmin && (
          <Button
            variant="contained"
            size="small"
            startIcon={<Plus size={14} />}
            onClick={() => setAddOpen(true)}
          >
            Add server
          </Button>
        )}
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading && servers.length === 0 ? (
        <CircularProgress size={22} />
      ) : (
        servers.map(server => (
          <Accordion
            key={server.id}
            expanded={expandedId === server.id}
            onChange={(_, expanded) =>
              setExpandedId(expanded ? server.id : null)
            }
            variant="outlined"
            disableGutters
          >
            <AccordionSummary expandIcon={<ChevronDown size={16} />}>
              <Stack
                direction="row"
                spacing={1.5}
                alignItems="center"
                sx={{ flex: 1, minWidth: 0 }}
              >
                <Plug size={16} />
                <Typography variant="subtitle2" noWrap>
                  {server.name}
                </Typography>
                <Chip
                  label={STATUS_LABELS[server.status]}
                  size="small"
                  color={STATUS_COLORS[server.status]}
                  variant="outlined"
                  sx={{ height: 20 }}
                />
                <Chip
                  label={WRITE_SCOPE_LABELS[server.writeScope]}
                  size="small"
                  variant="outlined"
                  sx={{ height: 20 }}
                />
                <Chip
                  label={
                    server.authPerformer === "workspace"
                      ? "Workspace credential"
                      : "Per-user credential"
                  }
                  size="small"
                  variant="outlined"
                  sx={{ height: 20 }}
                />
                <Typography
                  variant="caption"
                  color="text.secondary"
                  noWrap
                  sx={{ flex: 1, minWidth: 0, textAlign: "right", pr: 1 }}
                >
                  {server.transport.url}
                </Typography>
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <ServerDetail
                server={server}
                preset={presets.find(p => p.type === server.connectorType)}
                isAdmin={isAdmin}
                onNotify={notify}
              />
            </AccordionDetails>
          </Accordion>
        ))
      )}

      <AddServerDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        presets={
          presets.length > 0
            ? presets
            : [
                {
                  type: "custom",
                  label: "Custom MCP server",
                  description: "Connect any MCP server over Streamable HTTP.",
                  url: "",
                  urlEditable: true,
                  authType: "api_key",
                  authOptions: ["api_key", "oauth", "none"],
                  headerFields: [],
                },
              ]
        }
        onCreated={serverId => {
          setExpandedId(serverId);
          notify(
            "Server added — save credentials and test the connection",
            "success",
          );
        }}
      />

      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar(s => ({ ...s, open: false }))}
        message={snackbar.message}
      />
    </Box>
  );
}
