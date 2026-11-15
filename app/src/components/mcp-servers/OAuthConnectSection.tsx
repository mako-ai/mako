import { useState } from "react";
import {
  Button,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import { useWorkspace } from "../../contexts/workspace-context";
import {
  type McpPresetInfo,
  type McpServerInfo,
  useMcpStore,
} from "../../store/mcpStore";
import { notifyMcp } from "./mcp-server-helpers";

export function OAuthConnectSection({
  server,
  preset,
  onAlreadyAuthorized,
}: {
  server: McpServerInfo;
  preset: McpPresetInfo | undefined;
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
        notifyMcp("Account already connected", "success");
        setConnecting(false);
        onAlreadyAuthorized?.();
        return;
      }
      // Hand the browser to the provider's consent screen; it redirects
      // back to /api/mcp/oauth/callback → /settings/mcp.
      window.location.href = authorizationUrl;
    } catch (err) {
      setConnecting(false);
      notifyMcp(
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
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
        }}
      >
        {server.authPerformer === "user"
          ? "Each member logs in with their own account. The agent acts as you when using these tools."
          : "One shared login for the whole workspace (admin-managed)."}
      </Typography>
      {needsOAuthClient && (
        <Typography
          variant="caption"
          sx={{
            color: "warning.main",
          }}
        >
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
