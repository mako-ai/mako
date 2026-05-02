import { useEffect, useState } from "react";
import { Box, CircularProgress, Typography } from "@mui/material";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useSlackIntegrationStore } from "../store/slackIntegrationStore";

const STORAGE_KEY = "slack_webhook_oauth_pending";

export default function SlackWebhookCompletePage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const exchangeWebhookToken = useSlackIntegrationStore(
    s => s.exchangeWebhookToken,
  );
  const [message, setMessage] = useState("Completing Slack connection…");
  const [working, setWorking] = useState(true);

  useEffect(() => {
    const token = searchParams.get("token");
    if (!workspaceId || !token) {
      setMessage("Missing workspace or token.");
      setWorking(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const { slackWebhookUrl, displayLabel } = await exchangeWebhookToken(
          workspaceId,
          token,
        );
        if (cancelled) return;
        localStorage.setItem("activeWorkspaceId", workspaceId);
        sessionStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            workspaceId,
            slackWebhookUrl,
            displayLabel,
          }),
        );
        navigate("/", { replace: true });
      } catch (e) {
        if (!cancelled) {
          setMessage(e instanceof Error ? e.message : "Could not complete Slack setup");
          setWorking(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, searchParams, exchangeWebhookToken, navigate]);

  return (
    <Box
      display="flex"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      minHeight="100vh"
      gap={2}
      p={3}
    >
      {working && <CircularProgress size={40} />}
      <Typography variant="body1">{message}</Typography>
    </Box>
  );
}
