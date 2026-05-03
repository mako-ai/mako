import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Typography,
} from "@mui/material";
import { useWorkspace } from "../contexts/workspace-context";
import { useIsWorkspaceAdmin } from "../hooks/useIsWorkspaceAdmin";
import { getApiBasePath } from "../lib/api-base-path";
import { useSlackIntegrationStore } from "../store/slackIntegrationStore";

export default function SlackIntegrationCard() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const isAdmin = useIsWorkspaceAdmin();
  const fetchConnection = useSlackIntegrationStore(s => s.fetchConnection);
  const disconnectSlack = useSlackIntegrationStore(s => s.disconnectSlack);
  const connection = useSlackIntegrationStore(s =>
    workspaceId ? s.connectionByWorkspace[workspaceId] : undefined,
  );

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    try {
      await fetchConnection(workspaceId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Slack status");
    }
  }, [workspaceId, fetchConnection]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleConnect = () => {
    if (!workspaceId) return;
    const base = getApiBasePath(import.meta.env.VITE_API_URL);
    const returnTo = encodeURIComponent("/settings/integrations");
    window.location.href = `${base}/workspaces/${workspaceId}/slack/install?installType=bot&returnTo=${returnTo}`;
  };

  const handleDisconnect = async () => {
    if (!workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      await disconnectSlack(workspaceId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  };

  if (!workspaceId) {
    return null;
  }

  const connected = Boolean(connection);

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Slack
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Connect your Slack workspace once. Flow and scheduled query
          notifications can post to any channel the bot is invited to.
        </Typography>
        {error && (
          <Alert
            severity="error"
            sx={{ mb: 2 }}
            onClose={() => setError(null)}
          >
            {error}
          </Alert>
        )}
        {connected && connection ? (
          <Box>
            <Typography variant="body2">
              Connected: <strong>{connection.teamName}</strong> (
              {connection.teamId})
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              display="block"
            >
              Installed by user {connection.installedByUserId} ·{" "}
              {new Date(connection.installedAt).toLocaleString()}
            </Typography>
            {isAdmin && (
              <Button
                sx={{ mt: 2 }}
                color="error"
                variant="outlined"
                disabled={busy}
                onClick={() => void handleDisconnect()}
              >
                Disconnect Slack
              </Button>
            )}
          </Box>
        ) : (
          isAdmin && (
            <Button variant="contained" onClick={handleConnect}>
              Add to Slack
            </Button>
          )
        )}
        {!isAdmin && !connected && (
          <Typography variant="body2" color="text.secondary">
            Ask a workspace admin to connect Slack.
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}
