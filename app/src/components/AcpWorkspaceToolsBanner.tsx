/**
 * Helps users activate authenticated Mako workspace tools for local ACP
 * (Claude Code / Codex). No `claude mcp` — one button mints a Bearer and
 * starts a Local Agent session with `mako-workspace` attached.
 */
import { useEffect, useState } from "react";
import { Alert, Button, Stack, Typography } from "@mui/material";
import {
  acpSupportsAdapterEnsure,
  acpSupportsModelWarm,
  acpSupportsWorkspaceMcp,
} from "../lib/acp-capabilities";
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
  const bridgeOk = acpSupportsWorkspaceMcp(acpStatus);
  const canEnsureAdapter = acpSupportsAdapterEnsure(acpStatus);
  const sessions = useAcpStore(s => s.sessions);
  const refreshStatus = useAcpStore(s => s.refreshStatus);
  const refreshSessions = useAcpStore(s => s.refreshSessions);
  const setSelectedProvider = useAcpStore(s => s.setSelectedProvider);
  const createSession = useAcpStore(s => s.createSession);
  const authenticate = useAcpStore(s => s.authenticate);
  const ensureAdapter = useAcpStore(s => s.ensureAdapter);
  const warmProviderModels = useAcpStore(s => s.warmProviderModels);

  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [dismissedReady, setDismissedReady] = useState(false);

  const providerId = modelId ? localAcpModelIdToProviderId(modelId) : null;
  const isLocal = isLocalAcpModelId(modelId);
  const ensureStatus = providerId
    ? acpStatus?.ensureByProvider?.[providerId]
    : undefined;
  const ensureRunning = ensureStatus?.state === "running";

  useEffect(() => {
    if (!isLocal || !providerId) return;
    setDismissedReady(false);
    void (async () => {
      await checkAgent();
      await refreshStatus();
      await refreshSessions();
      // Soft no-op on older agents (store skips when route unsupported).
      if (acpSupportsModelWarm(useAcpStore.getState().status)) {
        void warmProviderModels(providerId);
      }
    })();
  }, [
    isLocal,
    providerId,
    checkAgent,
    refreshStatus,
    refreshSessions,
    warmProviderModels,
  ]);

  // Poll status while npm ensure is running so the banner can show progress.
  useEffect(() => {
    if (!ensureRunning) return;
    const timer = window.setInterval(() => {
      void refreshStatus();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [ensureRunning, refreshStatus]);

  if (!isLocal || !providerId) return null;

  const provider = acpStatus?.providers.find(p => p.id === providerId);
  const attached = sessions.some(
    s => s.providerId === providerId && s.makoMcpAttached,
  );

  const ensureLabel = (() => {
    if (!ensureStatus || ensureStatus.state === "idle") return null;
    if (ensureStatus.state === "running") {
      const started = ensureStatus.startedAt
        ? Date.parse(ensureStatus.startedAt)
        : NaN;
      const secs = Number.isFinite(started)
        ? Math.max(0, Math.round((Date.now() - started) / 1000))
        : 0;
      return (
        ensureStatus.message ||
        `Installing/updating local tools${secs ? ` (${secs}s)` : "…"}`
      );
    }
    if (ensureStatus.state === "error") {
      return ensureStatus.message || "Failed to update local tools";
    }
    return null;
  })();

  const enable = async () => {
    if (!workspaceId) return;
    setBusy(true);
    setBusyLabel("Connecting…");
    try {
      await checkAgent();
      await refreshStatus();
      setSelectedProvider(providerId);
      // Optional on older Local Agents — missing ensure/warm must not block MCP attach.
      if (acpSupportsAdapterEnsure(useAcpStore.getState().status)) {
        setBusyLabel("Updating local tools…");
        await ensureAdapter(providerId, { force: false });
      }
      if (acpSupportsModelWarm(useAcpStore.getState().status)) {
        setBusyLabel("Loading models…");
        await warmProviderModels(providerId);
      }
      setBusyLabel("Connecting…");
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
      setBusyLabel(null);
    }
  };

  const installAdapter = async () => {
    setBusy(true);
    setBusyLabel("Installing…");
    try {
      await checkAgent();
      await ensureAdapter(providerId, { force: true });
      await warmProviderModels(providerId);
      await refreshStatus();
    } finally {
      setBusy(false);
      setBusyLabel(null);
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
          machine, then enable tools below.
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
      <Alert
        severity="warning"
        sx={{ mb: 1 }}
        action={
          <Button
            size="small"
            variant="contained"
            disabled={busy || ensureRunning}
            onClick={() => void installAdapter()}
          >
            {busy || ensureRunning
              ? busyLabel || ensureLabel || "Installing…"
              : canEnsureAdapter
                ? "Install"
                : "Show install command"}
          </Button>
        }
      >
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          Install the {provider.label} adapter
        </Typography>
        <Typography variant="body2">
          {canEnsureAdapter
            ? "Mako can install it on this machine (npm global). One click — no Terminal required."
            : provider.installHint}
        </Typography>
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
          Workspace tools connected (<code>mako-workspace</code>). Ask{" "}
          {provider?.label || "the local agent"} about your data — it should
          call Mako tools directly (no Terminal MCP setup).
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
            disabled={busy || ensureRunning || !workspaceId || !bridgeOk}
            onClick={() => void enable()}
          >
            {busy || ensureRunning
              ? busyLabel || ensureLabel || "Connecting…"
              : "Enable workspace tools"}
          </Button>
        </Stack>
      }
    >
      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
        Activate Mako data tools for this local session
      </Typography>
      <Typography variant="body2">
        Mints a short-lived token and attaches authenticated workspace MCP (SQL,
        connections, consoles) for {provider?.label || "this local agent"}. If
        it asked for Mako auth, click Enable, then send a new message — or start
        a New chat.
      </Typography>
      {ensureRunning || ensureStatus?.state === "error" ? (
        <Typography variant="body2" sx={{ mt: 1 }}>
          {ensureLabel}
        </Typography>
      ) : null}
      {!bridgeOk ? (
        <Typography variant="body2" sx={{ mt: 1 }}>
          Local Agent is outdated for MCP attach — install Desktop 0.3.9+ and
          fully quit/reopen Mako before enabling tools.
        </Typography>
      ) : null}
      {error &&
      !/missing ACP route|outdated for this action|missing this ACP route|Update needs PR Desktop|CODEX_API_KEY|OPENAI_API_KEY/i.test(
        error,
      ) ? (
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
