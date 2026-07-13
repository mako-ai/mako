/**
 * Settings → MCP Servers management: add/edit MCP servers (Close preset or
 * any custom Streamable-HTTP server), save credentials, test the connection,
 * curate the exposed tool list, and review per-user approval grants.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  useMediaQuery,
  useTheme,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  Ban,
  CircleCheck,
  Hand,
  Plug,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import {
  type McpPresetInfo,
  type McpServerInfo,
  type McpToolRestriction,
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

/** Favicon for a custom MCP server, derived from its URL's host. */
function faviconForUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  } catch {
    return null;
  }
}

/** Square connection logo with a plug fallback when the image fails. */
function ConnectionIcon({
  src,
  size = 36,
}: {
  src?: string | null;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <Box
        sx={{
          width: size,
          height: size,
          borderRadius: 1.5,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          bgcolor: "action.hover",
          color: "text.secondary",
          flexShrink: 0,
        }}
      >
        <Plug size={size * 0.55} />
      </Box>
    );
  }
  return (
    <Box
      component="img"
      src={src}
      alt=""
      onError={() => setFailed(true)}
      sx={{
        width: size,
        height: size,
        borderRadius: 1.5,
        objectFit: "contain",
        flexShrink: 0,
      }}
    />
  );
}

function AddServerDialog({
  open,
  onClose,
  presets,
  initialPreset,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  presets: McpPresetInfo[];
  initialPreset?: string;
  onCreated: (serverId: string) => void;
}) {
  const { currentWorkspace } = useWorkspace();
  const createServer = useMcpStore(s => s.createServer);
  const startOAuth = useMcpStore(s => s.startOAuth);
  const muiTheme = useTheme();
  const fullScreenDialog = useMediaQuery(muiTheme.breakpoints.down("sm"));
  const [presetType, setPresetType] = useState("close");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authType, setAuthType] = useState<"none" | "api_key" | "oauth">(
    "oauth",
  );
  const [writeScope, setWriteScope] = useState<McpWriteScope>("read");
  const [submitting, setSubmitting] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset = presets.find(p => p.type === presetType);
  const authOptions = preset?.authOptions ?? ["api_key"];
  // Claude-style one-click connect: after adding an OAuth server whose
  // client is already available (DCR, or a deployment-wide app), go straight
  // to the provider's consent screen. Manual-client presets without a shared
  // app still need the admin form first.
  const canConnectImmediately =
    authType === "oauth" &&
    (preset?.oauth
      ? preset.oauth.clientMode !== "manual" ||
        Boolean(preset.oauth.envClientConfigured)
      : true);

  useEffect(() => {
    if (open && initialPreset) setPresetType(initialPreset);
  }, [open, initialPreset]);

  useEffect(() => {
    if (open) {
      setError(null);
      setName(preset?.type === "custom" ? "" : (preset?.label ?? ""));
      setUrl("");
      setAuthType(preset?.authType ?? "api_key");
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
        writeScope,
      });
      if (canConnectImmediately) {
        try {
          const { authorizationUrl, alreadyAuthorized } = await startOAuth(
            currentWorkspace.id,
            server.id,
          );
          if (!alreadyAuthorized && authorizationUrl) {
            setRedirecting(true);
            // Provider consent screen; it redirects back to
            // /api/mcp/oauth/callback → /settings/mcp with auto-discovery.
            window.location.href = authorizationUrl;
            return;
          }
        } catch {
          // OAuth couldn't start (e.g. DCR unsupported) — fall back to the
          // detail dialog where the error surfaces on manual connect.
        }
      }
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
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      fullScreen={fullScreenDialog}
    >
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
            // Fixed-URL presets: a disabled input reads like an empty
            // required field, so show the endpoint as plain info instead.
            preset?.url && (
              <Typography variant="caption" color="text.secondary">
                Connects to{" "}
                <Box component="code" sx={{ fontFamily: "monospace" }}>
                  {preset.url}
                </Box>{" "}
                — the official {preset.label} MCP endpoint (not editable).
              </Typography>
            )
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
          <Typography variant="caption" color="text.secondary">
            Every member authenticates individually — enabling a connector never
            grants shared data access. The agent only sees what the signed-in
            user can see.
          </Typography>
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
          disabled={!canSubmit || submitting || redirecting}
          onClick={handleCreate}
          data-testid="mcp-add-server"
        >
          {redirecting
            ? "Redirecting…"
            : submitting
              ? canConnectImmediately
                ? "Connecting…"
                : "Adding…"
              : canConnectImmediately
                ? `Connect ${preset && preset.type !== "custom" ? preset.label : ""}`.trim()
                : "Add server"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Claude-style three-state restriction control: Always-allowable (check),
 * Ask (hand), Block (ban). The admin picks a ceiling; members can always
 * choose a stricter setting for themselves.
 */
function RestrictionControl({
  value,
  usesDefault,
  disabled,
  onChange,
}: {
  value: McpToolRestriction;
  usesDefault: boolean;
  disabled?: boolean;
  onChange: (value: McpToolRestriction) => void;
}) {
  const options: Array<{
    key: McpToolRestriction;
    label: string;
    icon: React.ReactNode;
  }> = [
    {
      key: "always",
      label: "Users can choose Always allow, Ask, or Block",
      icon: <CircleCheck size={14} />,
    },
    {
      key: "ask",
      label: "Users can choose Ask or Block — never Always allow",
      icon: <Hand size={14} />,
    },
    {
      key: "block",
      label: "Block this tool for everyone",
      icon: <Ban size={14} />,
    },
  ];
  return (
    <Stack direction="row" spacing={0.5}>
      {options.map(opt => {
        const selected = value === opt.key;
        return (
          <Tooltip key={opt.key} title={opt.label}>
            <span>
              <IconButton
                size="small"
                disabled={disabled}
                onClick={() => onChange(opt.key)}
                sx={{
                  border: 1,
                  borderColor: selected ? "text.primary" : "divider",
                  borderRadius: "50%",
                  width: 26,
                  height: 26,
                  color: selected ? "text.primary" : "text.disabled",
                  opacity: selected && usesDefault ? 0.75 : 1,
                  bgcolor: selected ? "action.selected" : "transparent",
                }}
              >
                {opt.icon}
              </IconButton>
            </span>
          </Tooltip>
        );
      })}
    </Stack>
  );
}

/**
 * Admin form for manual-client OAuth presets (Slack): the provider only
 * accepts pre-registered confidential apps, so the workspace admin saves the
 * app's Client ID + Secret before members can connect their accounts.
 */
function OAuthClientForm({
  server,
  preset,
  onNotify,
}: {
  server: McpServerInfo;
  preset: McpPresetInfo;
  onNotify: (message: string, severity: "success" | "error") => void;
}) {
  const { currentWorkspace } = useWorkspace();
  const saveOAuthClient = useMcpStore(s => s.saveOAuthClient);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);

  const callbackUrl = `${window.location.origin}/api/mcp/oauth/callback`;

  const handleSave = async () => {
    if (!currentWorkspace) return;
    setSaving(true);
    try {
      await saveOAuthClient(
        currentWorkspace.id,
        server.id,
        clientId.trim(),
        clientSecret.trim() || undefined,
      );
      setClientId("");
      setClientSecret("");
      onNotify("OAuth app saved — members can now connect", "success");
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : "Failed to save OAuth app",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle2">
        {preset.label} OAuth app
        {server.hasOAuthClient && (
          <Chip
            label="Configured"
            size="small"
            color="success"
            variant="outlined"
            sx={{ ml: 1 }}
          />
        )}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {preset.oauth?.helperText ??
          "This provider requires a pre-registered OAuth app. Save its Client ID and Client Secret to enable member sign-in."}
        {preset.oauth?.docsUrl && (
          <>
            {" "}
            <Box
              component="a"
              href={preset.oauth.docsUrl}
              target="_blank"
              rel="noreferrer"
              sx={{ color: "primary.main" }}
            >
              Open the provider&apos;s app dashboard
            </Box>
          </>
        )}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        Redirect URL for the app:{" "}
        <Box component="code" sx={{ fontFamily: "monospace" }}>
          {callbackUrl}
        </Box>
      </Typography>
      <TextField
        label="Client ID"
        size="small"
        fullWidth
        value={clientId}
        onChange={e => setClientId(e.target.value)}
        placeholder={server.oauthClientId ?? undefined}
        helperText={
          server.oauthClientId
            ? `Saved app: ${server.oauthClientId}`
            : undefined
        }
        data-testid="mcp-oauth-client-id"
      />
      <TextField
        label="Client Secret"
        size="small"
        fullWidth
        type="password"
        value={clientSecret}
        onChange={e => setClientSecret(e.target.value)}
        placeholder={server.hasOAuthClient ? "•••••••• (saved)" : undefined}
        data-testid="mcp-oauth-client-secret"
      />
      <Button
        variant="outlined"
        size="small"
        disabled={clientId.trim().length === 0 || saving}
        onClick={() => void handleSave()}
        sx={{ alignSelf: "flex-start" }}
        data-testid="mcp-save-oauth-client"
      >
        {saving ? "Saving…" : "Save OAuth app"}
      </Button>
    </Stack>
  );
}

function OAuthConnectSection({
  server,
  preset,
  onNotify,
  onAlreadyAuthorized,
}: {
  server: McpServerInfo;
  preset: McpPresetInfo | undefined;
  onNotify: (message: string, severity: "success" | "error") => void;
  /** Called when no redirect is needed (valid tokens already stored). */
  onAlreadyAuthorized?: () => void;
}) {
  const { currentWorkspace } = useWorkspace();
  const startOAuth = useMcpStore(s => s.startOAuth);
  const [connecting, setConnecting] = useState(false);

  const hasCredential =
    server.authPerformer === "workspace"
      ? server.hasWorkspaceCredential
      : server.hasUserCredential;
  // Manual-client presets can't start the flow until the app is saved.
  const needsOAuthClient =
    preset?.oauth?.clientMode === "manual" && !server.hasOAuthClient;

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
        onAlreadyAuthorized?.();
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
      {needsOAuthClient && (
        <Typography variant="caption" color="warning.main">
          A workspace admin must save the {preset?.label ?? "provider"} OAuth
          app (Client ID + Secret) before accounts can be connected.
        </Typography>
      )}
      <Button
        variant={hasCredential ? "outlined" : "contained"}
        size="small"
        disabled={connecting || needsOAuthClient}
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
            : `Connect ${
                preset && preset.type !== "custom" ? preset.label : "your"
              } account`}
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

/**
 * Admin-only rename + description editor. Renaming is safe: credentials,
 * grants, and tool policies are keyed by server ID — only the agent-facing
 * tool prefix (derived from the name) changes.
 */
function ServerDetailsForm({
  server,
  onNotify,
}: {
  server: McpServerInfo;
  onNotify: (message: string, severity: "success" | "error") => void;
}) {
  const { currentWorkspace } = useWorkspace();
  const updateServer = useMcpStore(s => s.updateServer);
  const [name, setName] = useState(server.name);
  const [description, setDescription] = useState(server.description ?? "");
  const [saving, setSaving] = useState(false);

  // Re-sync when switching to a different server in the same dialog.
  useEffect(() => {
    setName(server.name);
    setDescription(server.description ?? "");
  }, [server.id, server.name, server.description]);

  const dirty =
    name.trim() !== server.name ||
    description.trim() !== (server.description ?? "");

  const handleSave = async () => {
    if (!currentWorkspace) return;
    setSaving(true);
    try {
      await updateServer(currentWorkspace.id, server.id, {
        name: name.trim(),
        description: description.trim() || undefined,
      });
      onNotify("Connection details saved", "success");
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : "Failed to save details",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle2">Connection details</Typography>
      <TextField
        label="Name"
        size="small"
        fullWidth
        value={name}
        onChange={e => setName(e.target.value)}
        helperText="Shown in tool names, e.g. mcp_close_crm_lead_search — renaming changes the tool prefix the agent sees"
      />
      <TextField
        label="Description"
        size="small"
        fullWidth
        multiline
        minRows={2}
        value={description}
        onChange={e => setDescription(e.target.value)}
        helperText="Optional — shown on the connection card"
      />
      <Button
        variant="outlined"
        size="small"
        disabled={!dirty || name.trim().length === 0 || saving}
        onClick={() => void handleSave()}
        sx={{ alignSelf: "flex-start" }}
        data-testid="mcp-save-details"
      >
        {saving ? "Saving…" : "Save details"}
      </Button>
    </Stack>
  );
}

function ServerDetail({
  server,
  preset,
  isAdmin,
  autoDiscover,
  onAutoDiscoverConsumed,
  onNotify,
}: {
  server: McpServerInfo;
  preset: McpPresetInfo | undefined;
  isAdmin: boolean;
  /** Run discovery automatically on mount (set after an OAuth return). */
  autoDiscover?: boolean;
  onAutoDiscoverConsumed?: () => void;
  onNotify: (message: string, severity: "success" | "error") => void;
}) {
  const { currentWorkspace } = useWorkspace();
  const {
    testServer,
    updateServer,
    deleteServer,
    fetchGrants,
    revokeGrant,
    saveGrant,
    grants,
  } = useMcpStore();
  const [testing, setTesting] = useState(false);
  const myGrants = grants[server.id] ?? [];
  const readTools = useMemo(
    () => server.cachedTools.filter(t => t.riskTier === "read"),
    [server.cachedTools],
  );
  const writeTools = useMemo(
    () => server.cachedTools.filter(t => t.riskTier !== "read"),
    [server.cachedTools],
  );

  useEffect(() => {
    if (currentWorkspace) {
      void fetchGrants(currentWorkspace.id, server.id);
    }
  }, [currentWorkspace, server.id, fetchGrants]);

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

  // After an OAuth return, kick off discovery without the extra click. The
  // ref guards StrictMode double-invocation; the parent clears the flag so
  // reopening the modal later doesn't re-trigger.
  const autoDiscoverRan = useRef(false);
  useEffect(() => {
    if (!autoDiscover || autoDiscoverRan.current || !currentWorkspace) return;
    autoDiscoverRan.current = true;
    onAutoDiscoverConsumed?.();
    void handleTest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDiscover, currentWorkspace]);

  const handleSetRestriction = async (
    toolName: string,
    value: McpToolRestriction,
  ) => {
    if (!currentWorkspace) return;
    await updateServer(currentWorkspace.id, server.id, {
      toolPolicy: {
        restrictions: {
          ...server.toolPolicy.restrictions,
          [toolName]: value,
        },
      },
    });
  };

  const handleSetDefaultRestriction = async (value: McpToolRestriction) => {
    if (!currentWorkspace) return;
    await updateServer(currentWorkspace.id, server.id, {
      toolPolicy: { defaultRestriction: value },
    });
  };

  /**
   * The user's own per-tool permission (Claude-style): Always allow / Ask /
   * Block, stored as a grant ("Ask" simply clears it — the tool prompts on
   * next use). Capped by the admin ceiling via disabled options.
   */
  const handleSetUserPermission = async (
    toolName: string,
    value: "always_allow" | "ask" | "block",
    grantId?: string,
  ) => {
    if (!currentWorkspace) return;
    if (value === "ask") {
      if (grantId) {
        await revokeGrant(currentWorkspace.id, server.id, grantId);
      }
      return;
    }
    await saveGrant(
      currentWorkspace.id,
      server.id,
      toolName,
      value === "always_allow" ? "always_allow" : "always_deny",
    );
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

      {isAdmin && (
        <>
          <ServerDetailsForm server={server} onNotify={onNotify} />
          <Divider />
        </>
      )}

      {server.authType === "oauth" ? (
        <>
          {/* The OAuth app form only appears when there's no deployment-wide
              client — with a shared app configured, connect is one click. */}
          {isAdmin &&
            preset?.oauth?.clientMode === "manual" &&
            server.oauthClientSource !== "environment" && (
              <>
                <OAuthClientForm
                  server={server}
                  preset={preset}
                  onNotify={onNotify}
                />
                <Divider />
              </>
            )}
          <OAuthConnectSection
            server={server}
            preset={preset}
            onNotify={onNotify}
            onAlreadyAuthorized={() => void handleTest()}
          />
        </>
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
              Tool permission restrictions ({server.cachedTools.length})
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", mb: 1.5 }}
            >
              Restrict which permission levels members can choose for each tool.
              Restrictions set a ceiling — users can always choose a stricter
              setting.
            </Typography>

            {isAdmin && (
              <Stack
                direction="row"
                alignItems="center"
                spacing={1}
                useFlexGap
                sx={{ mb: 1.5, px: 1, flexWrap: "wrap", rowGap: 0.5 }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2">
                    Default restriction for unconfigured tools
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Applies to tools without a specific restriction below,
                    including tools this server adds later.
                  </Typography>
                </Box>
                <RestrictionControl
                  value={server.toolPolicy.defaultRestriction}
                  usesDefault={false}
                  disabled={!isAdmin}
                  onChange={value => void handleSetDefaultRestriction(value)}
                />
              </Stack>
            )}

            {(
              [
                ["Read-only tools", readTools],
                ["Write/delete tools", writeTools],
              ] as const
            ).map(([groupLabel, tools]) =>
              tools.length === 0 ? null : (
                <Box key={groupLabel} sx={{ mb: 1.5 }}>
                  <Typography
                    variant="caption"
                    fontWeight={600}
                    color="text.secondary"
                    sx={{ display: "block", mb: 0.5, px: 1 }}
                  >
                    {groupLabel} ({tools.length})
                  </Typography>
                  <Stack spacing={0.25}>
                    {tools.map(tool => {
                      const explicit =
                        server.toolPolicy.restrictions[tool.name];
                      return (
                        <Stack
                          key={tool.name}
                          direction="row"
                          alignItems="center"
                          spacing={1}
                          useFlexGap
                          sx={{
                            py: 0.5,
                            px: 1,
                            borderRadius: 1,
                            flexWrap: "wrap",
                            rowGap: 0.5,
                            "&:hover": { bgcolor: "action.hover" },
                          }}
                        >
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            <Stack
                              direction="row"
                              spacing={1}
                              alignItems="center"
                            >
                              <Typography
                                variant="body2"
                                sx={{ fontFamily: "monospace" }}
                                noWrap
                              >
                                {tool.name}
                              </Typography>
                              {tool.riskTier === "destructive" && (
                                <Chip
                                  label="Destructive"
                                  size="small"
                                  variant="outlined"
                                  color="error"
                                  sx={{ height: 16, fontSize: 10 }}
                                />
                              )}
                            </Stack>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              noWrap
                              sx={{ display: "block" }}
                            >
                              {tool.description ?? ""} Users can choose:{" "}
                              {tool.restriction === "always"
                                ? "Always allow, Ask, or Block"
                                : tool.restriction === "ask"
                                  ? "Ask or Block"
                                  : "Blocked"}
                            </Typography>
                          </Box>
                          {!explicit && (
                            <Typography
                              variant="caption"
                              color="text.disabled"
                              sx={{ whiteSpace: "nowrap" }}
                            >
                              Uses default
                            </Typography>
                          )}
                          <RestrictionControl
                            value={tool.restriction}
                            usesDefault={!explicit}
                            disabled={!isAdmin}
                            onChange={value =>
                              void handleSetRestriction(tool.name, value)
                            }
                          />
                        </Stack>
                      );
                    })}
                  </Stack>
                </Box>
              ),
            )}
          </Box>
        </>
      )}

      {server.cachedTools.length > 0 && (
        <>
          <Divider />
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Your tool permissions
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", mb: 1 }}
            >
              These choices apply only to you. Tools ask on first use until you
              decide — pick a permission here or from the approval prompt in
              chat.
            </Typography>
            <Stack spacing={0.25}>
              {server.cachedTools.map(tool => {
                const grant = myGrants.find(g => g.toolName === tool.name);
                const value =
                  grant?.decision === "always_allow"
                    ? "always_allow"
                    : grant?.decision === "always_deny"
                      ? "block"
                      : "ask";
                const blockedByAdmin = tool.restriction === "block";
                return (
                  <Stack
                    key={tool.name}
                    direction="row"
                    alignItems="center"
                    spacing={1}
                    useFlexGap
                    sx={{
                      py: 0.5,
                      px: 1,
                      borderRadius: 1,
                      flexWrap: "wrap",
                      rowGap: 0.5,
                      "&:hover": { bgcolor: "action.hover" },
                    }}
                  >
                    <Typography
                      variant="body2"
                      sx={{ fontFamily: "monospace", flex: 1, minWidth: 0 }}
                      noWrap
                    >
                      {tool.name}
                    </Typography>
                    {blockedByAdmin ? (
                      <Typography variant="caption" color="text.disabled">
                        Blocked by admin
                      </Typography>
                    ) : (
                      <FormControl size="small" sx={{ minWidth: 140 }}>
                        <Select
                          value={value}
                          disabled={!currentWorkspace}
                          onChange={e =>
                            void handleSetUserPermission(
                              tool.name,
                              e.target.value as
                                | "always_allow"
                                | "ask"
                                | "block",
                              grant?.id,
                            )
                          }
                          sx={{ fontSize: 13 }}
                        >
                          <MenuItem
                            value="always_allow"
                            disabled={tool.restriction !== "always"}
                          >
                            Always allow
                          </MenuItem>
                          <MenuItem value="ask">Ask</MenuItem>
                          <MenuItem value="block">Block</MenuItem>
                        </Select>
                      </FormControl>
                    )}
                  </Stack>
                );
              })}
            </Stack>
          </Box>
        </>
      )}
    </Stack>
  );
}

/** Gallery card for a configured server or an available preset. */
function ConnectionCard({
  icon,
  title,
  description,
  connected,
  statusChip,
  actionLabel,
  actionVariant = "contained",
  onAction,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  connected?: boolean;
  statusChip?: React.ReactNode;
  actionLabel: string;
  actionVariant?: "contained" | "outlined";
  onAction: () => void;
  disabled?: boolean;
}) {
  return (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 2.5,
        p: 2,
        display: "flex",
        flexDirection: "column",
        gap: 1,
        bgcolor: "background.paper",
        transition: "box-shadow 120ms ease, border-color 120ms ease",
        "&:hover": {
          borderColor: "text.disabled",
          boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
        },
      }}
    >
      <Stack direction="row" alignItems="flex-start" spacing={1}>
        {icon}
        <Box sx={{ flex: 1 }} />
        {connected && (
          <Chip
            label="CONNECTED"
            size="small"
            sx={{
              height: 20,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.4,
              color: "success.main",
              bgcolor: "transparent",
              border: 1,
              borderColor: "success.light",
              "& .MuiChip-label": { px: 1 },
            }}
            icon={
              <Box
                sx={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  bgcolor: "success.main",
                  ml: 0.75,
                }}
              />
            }
          />
        )}
        {statusChip}
      </Stack>
      <Typography variant="subtitle2" fontWeight={600} sx={{ mt: 0.5 }}>
        {title}
      </Typography>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          minHeight: 48,
        }}
      >
        {description}
      </Typography>
      <Button
        variant={actionVariant}
        size="small"
        fullWidth
        disabled={disabled}
        onClick={onAction}
        sx={{ mt: "auto" }}
      >
        {actionLabel}
      </Button>
    </Box>
  );
}

export function McpServersSection() {
  const { currentWorkspace, loading: workspaceLoading } = useWorkspace();
  const muiTheme = useTheme();
  const fullScreenDialog = useMediaQuery(muiTheme.breakpoints.down("sm"));
  const {
    servers,
    presets,
    loading,
    error,
    fetchServers,
    fetchPresets,
    oauthReturn,
    clearOAuthReturn,
  } = useMcpStore();
  const [addOpen, setAddOpen] = useState(false);
  const [addPreset, setAddPreset] = useState<string | undefined>(undefined);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [autoDiscoverId, setAutoDiscoverId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
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

  // Fallback capture for entry paths that skip UrlSync hydration — normally
  // UrlSync already moved the query flags into the store on page load.
  useEffect(() => {
    useMcpStore.getState().captureOAuthReturn();
  }, []);

  // Surface the OAuth callback outcome: reopen the server's modal and, on
  // success, auto-run discovery so tools load without another click.
  useEffect(() => {
    if (!oauthReturn) return;
    clearOAuthReturn();
    const { connected, error: oauthError, serverId } = oauthReturn;
    if (serverId) setDetailId(serverId);
    if (oauthError) {
      notify(`OAuth connection failed: ${oauthError}`, "error");
      return;
    }
    if (!connected) return;
    if (serverId) {
      setAutoDiscoverId(serverId);
      notify("Account connected — loading tools…", "success");
    } else {
      notify(
        "Account connected — test the connection to load tools",
        "success",
      );
    }
  }, [oauthReturn, clearOAuthReturn]);

  const effectivePresets: McpPresetInfo[] =
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
        ];

  const presetByType = (type: string) =>
    effectivePresets.find(p => p.type === type);

  /** Icon for a configured server: preset logo, else the URL's favicon. */
  const serverIcon = (server: McpServerInfo) =>
    presetByType(server.connectorType)?.icon ??
    faviconForUrl(server.transport.url);

  const query = search.trim().toLowerCase();
  const matches = (...texts: Array<string | null | undefined>) =>
    !query || texts.some(t => t?.toLowerCase().includes(query));

  const visibleServers = servers.filter(s =>
    matches(s.name, s.description, s.transport.url),
  );
  // Preset cards: hide single-instance presets that are already configured
  // (custom stays — you can add any number of custom servers).
  const availablePresets = effectivePresets.filter(
    p =>
      matches(p.label, p.description) &&
      (p.type === "custom" || !servers.some(s => s.connectorType === p.type)),
  );

  const detailServer = servers.find(s => s.id === detailId) ?? null;

  return (
    <Box>
      <TextField
        size="small"
        fullWidth
        placeholder="Search connections and tools…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        sx={{ mb: 2.5 }}
        InputProps={{
          startAdornment: (
            <Box
              sx={{
                mr: 1,
                display: "flex",
                alignItems: "center",
                color: "text.disabled",
              }}
            >
              <Search size={15} />
            </Box>
          ),
        }}
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading && servers.length === 0 ? (
        <CircularProgress size={22} />
      ) : (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 1.5,
          }}
        >
          {visibleServers.map(server => {
            const needsAttention =
              server.status === "error" || server.status === "awaiting_auth";
            return (
              <ConnectionCard
                key={server.id}
                icon={<ConnectionIcon src={serverIcon(server)} />}
                title={server.name}
                description={
                  server.description ??
                  (server.connectorType !== "custom"
                    ? (presetByType(server.connectorType)?.description ??
                      server.transport.url)
                    : server.transport.url)
                }
                connected={server.status === "connected"}
                statusChip={
                  needsAttention ? (
                    <Chip
                      label={STATUS_LABELS[server.status]}
                      size="small"
                      color={STATUS_COLORS[server.status]}
                      variant="outlined"
                      sx={{ height: 20, fontSize: 10 }}
                    />
                  ) : undefined
                }
                actionLabel={
                  server.status === "connected" ? "Manage" : "Finish setup"
                }
                actionVariant={
                  server.status === "connected" ? "outlined" : "contained"
                }
                onAction={() => setDetailId(server.id)}
              />
            );
          })}
          {availablePresets.map(preset => (
            <ConnectionCard
              key={`preset-${preset.type}`}
              icon={<ConnectionIcon src={preset.icon} />}
              title={preset.label}
              description={preset.description}
              actionLabel="Connect"
              onAction={() => {
                setAddPreset(preset.type);
                setAddOpen(true);
              }}
              disabled={!isAdmin}
            />
          ))}
        </Box>
      )}
      {!isAdmin && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", mt: 1.5 }}
        >
          Only workspace admins can add connections. You can connect your own
          account on per-user connections via Manage.
        </Typography>
      )}

      <AddServerDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        presets={effectivePresets}
        initialPreset={addPreset}
        onCreated={serverId => {
          setDetailId(serverId);
          notify(
            "Connection added — finish setup to load its tools",
            "success",
          );
        }}
      />

      <Dialog
        open={detailServer !== null}
        onClose={() => setDetailId(null)}
        maxWidth="md"
        fullWidth
        fullScreen={fullScreenDialog}
      >
        {detailServer && (
          <>
            <DialogTitle>
              <Stack
                direction="row"
                spacing={1.5}
                alignItems="center"
                useFlexGap
                sx={{ flexWrap: "wrap", rowGap: 0.5 }}
              >
                <ConnectionIcon src={serverIcon(detailServer)} size={28} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="subtitle1" fontWeight={600} noWrap>
                    {detailServer.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {detailServer.transport.url}
                  </Typography>
                </Box>
                <Chip
                  label={STATUS_LABELS[detailServer.status]}
                  size="small"
                  color={STATUS_COLORS[detailServer.status]}
                  variant="outlined"
                  sx={{ height: 20 }}
                />
                <Chip
                  label={WRITE_SCOPE_LABELS[detailServer.writeScope]}
                  size="small"
                  variant="outlined"
                  sx={{ height: 20 }}
                />
              </Stack>
            </DialogTitle>
            <DialogContent dividers>
              <ServerDetail
                server={detailServer}
                preset={presetByType(detailServer.connectorType)}
                isAdmin={isAdmin}
                autoDiscover={autoDiscoverId === detailServer.id}
                onAutoDiscoverConsumed={() => setAutoDiscoverId(null)}
                onNotify={notify}
              />
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setDetailId(null)}>Close</Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar(s => ({ ...s, open: false }))}
        message={snackbar.message}
      />
    </Box>
  );
}
