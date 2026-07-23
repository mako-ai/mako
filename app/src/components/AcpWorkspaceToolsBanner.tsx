/**
 * Helps users activate authenticated Mako workspace tools for local ACP
 * (Claude Code / Codex). No `claude mcp` — one button mints a Bearer and
 * starts a Local Agent session with `mako-workspace` attached.
 */
import { useEffect, useState } from "react";
import { Alert, Button, Stack, Typography } from "@mui/material";
import {
  isLocalAcpModelId,
  localAcpModelIdToProviderId,
} from "../lib/local-acp-models";
import { useAcpStore } from "../store/acpStore";
import { useLocalAgentStore } from "../store/localAgentStore";

export function AcpWorkspaceToolsBanner(props: {
  modelId: string | null | undefined;
  workspaceId: string | undefined;
}) {
  const { modelId, workspaceId } = props;
  const agentStatus = useLocalAgentStore(s => s.status);
  const checkAgent = useLocalAgentStore(s => s.checkAgent);
  const acpStatus = useAcpStore(s => s.status);
  const statusError = useAcpStore(s => s.statusError);
  const error = useAcpStore(s => s.error);
  const bridgeOk = Boolean(
    acpStatus?.acpBridge?.version && acpStatus.acpBridge.version >= 2,
  );
  const sessions = useAcpStore(s => s.sessions);
  const refreshStatus = useAcpStore(s => s.refreshStatus);
  const refreshSessions = useAcpStore(s => s.refreshSessions);
  const setSelectedProvider = useAcpStore(s => s.setSelectedProvider);
  const createSession = useAcpStore(s => s.createSession);
  const authenticate = useAcpStore(s => s.authenticate);

  const [busy, setBusy] = useState(false);
  const [dismissedReady, setDismissedReady] = useState(false);

  const providerId = modelId ? localAcpModelIdToProviderId(modelId) : null;
  const isLocal = isLocalAcpModelId(modelId);

  useEffect(() => {
    if (!isLocal) return;
    setDismissedReady(false);
    void (async () => {
      await checkAgent();
      await refreshStatus();
      await refreshSessions();
    })();
  }, [isLocal, providerId, checkAgent, refreshStatus, refreshSessions]);

  if (!isLocal || !providerId) return null;

  const provider = acpStatus?.providers.find(p => p.id === providerId);
  const attached = sessions.some(
    s => s.providerId === providerId && s.makoMcpAttached,
  );

  const enable = async () => {
    if (!workspaceId) return;
    setBusy(true);
    try {
      await checkAgent();
      await refreshStatus();
      setSelectedProvider(providerId);
      const session = await createSession({
        workspaceId,
        requireMakoMcp: true,
      });
      if (session?.makoMcpAttached) {
        setDismissedReady(false);
      }
      await refreshSessions();
    } finally {
      setBusy(false);
    }
  };

  if (agentStatus === "offline" || statusError) {
    return (
      <Alert severity="warning" sx={{ mb: 1 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          Local Agent required for workspace tools
        </Typography>
        <Typography variant="body2" sx={{ mb: 1 }}>
          Start Mako Desktop or run <code>pnpm agent:start</code> on this
          machine, then enable tools below. You do not need{" "}
          <code>claude mcp</code>.
        </Typography>
        {statusError ? (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {statusError}
          </Typography>
        ) : null}
        <Button
          size="small"
          variant="outlined"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void checkAgent()
              .then(() => refreshStatus())
              .finally(() => setBusy(false));
          }}
        >
          Retry
        </Button>
      </Alert>
    );
  }

  if (provider && !provider.adapterFound) {
    return (
      <Alert severity="warning" sx={{ mb: 1 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          Install the {provider.label} adapter
        </Typography>
        <Typography variant="body2">{provider.installHint}</Typography>
      </Alert>
    );
  }

  if (provider?.authRequired && !provider.connected) {
    return (
      <Alert
        severity="info"
        sx={{ mb: 1 }}
        action={
          <Button
            size="small"
            variant="contained"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void authenticate(providerId).finally(() => setBusy(false));
            }}
          >
            Sign in
          </Button>
        }
      >
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          Sign in to {provider.authProduct}
        </Typography>
        <Typography variant="body2">
          Then enable Mako workspace tools (BigQuery, SQL, connections) in one
          click — no terminal MCP setup.
        </Typography>
      </Alert>
    );
  }

  if (attached && !error) {
    if (dismissedReady) return null;
    return (
      <Alert
        severity="success"
        sx={{ mb: 1 }}
        onClose={() => setDismissedReady(true)}
      >
        <Typography variant="body2">
          Workspace tools connected (<code>mako-workspace</code>). Ask about
          your data — Claude should call Mako tools, not ask for{" "}
          <code>claude mcp</code>.
        </Typography>
      </Alert>
    );
  }

  return (
    <Alert
      severity={error ? "error" : "info"}
      sx={{ mb: 1 }}
      action={
        <Stack direction="row" spacing={1}>
          <Button
            size="small"
            variant="contained"
            disabled={busy || !workspaceId || !bridgeOk}
            onClick={() => void enable()}
          >
            {busy ? "Connecting…" : "Enable workspace tools"}
          </Button>
        </Stack>
      }
    >
      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
        Activate Mako data tools for this local session
      </Typography>
      <Typography variant="body2">
        Mints a short-lived token and attaches authenticated workspace MCP (SQL,
        connections, consoles). If Claude already said Mako needs auth, click
        Enable, then send a new message — or start a New chat.
      </Typography>
      {!bridgeOk ? (
        <Typography variant="body2" sx={{ mt: 1 }}>
          Local Agent is outdated — install desktop-canary and fully quit/reopen
          Mako before enabling tools. Raw &quot;ACP connection closed&quot;
          means the old agent is still on port 41720.
        </Typography>
      ) : null}
      {error ? (
        <Typography variant="body2" sx={{ mt: 1 }}>
          {error}
        </Typography>
      ) : null}
      {!workspaceId ? (
        <Typography variant="body2" sx={{ mt: 1 }}>
          Select a workspace first.
        </Typography>
      ) : null}
    </Alert>
  );
}
