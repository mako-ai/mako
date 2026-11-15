import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  useMediaQuery,
  useTheme,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useWorkspace } from "../../contexts/workspace-context";
import {
  type McpPresetInfo,
  type McpWriteScope,
  useMcpStore,
} from "../../store/mcpStore";

export function AddServerDialog({
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
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
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
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                }}
              >
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
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
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
