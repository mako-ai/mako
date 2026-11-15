import { useState } from "react";
import { Box, Button, Chip, Stack, TextField, Typography } from "@mui/material";
import { useWorkspace } from "../../contexts/workspace-context";
import {
  type McpPresetInfo,
  type McpServerInfo,
  useMcpStore,
} from "../../store/mcpStore";
import { notifyMcp } from "./mcp-server-helpers";

/**
 * Admin form for manual-client OAuth presets (Slack): the provider only
 * accepts pre-registered confidential apps, so the workspace admin saves the
 * app's Client ID + Secret before members can connect their accounts.
 */
export function OAuthClientForm({
  server,
  preset,
}: {
  server: McpServerInfo;
  preset: McpPresetInfo;
}) {
  const { currentWorkspace } = useWorkspace();
  const saveOAuthClient = useMcpStore(s => s.saveOAuthClient);
  const oauthCallbackUrl = useMcpStore(s => s.oauthCallbackUrl);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);

  const callbackUrl =
    oauthCallbackUrl ?? `${window.location.origin}/api/mcp/oauth/callback`;

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
      notifyMcp("OAuth app saved — members can now connect", "success");
    } catch (err) {
      notifyMcp(
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
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
        }}
      >
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
              Open the provider&apos;s app settings
            </Box>
          </>
        )}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
        }}
      >
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
