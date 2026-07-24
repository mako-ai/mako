/**
 * Helps users activate authenticated Mako workspace tools for local ACP
 * (Claude Code / Codex). No `claude mcp` — mints a Bearer and starts a Local
 * Agent session with `mako-workspace` attached (auto when signed in).
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
import { sanitizeAcpUserError } from "../lib/acp-user-errors";
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
  /** Success toast — auto-hides; null until first attach for this provider. */
  const [showConnectedToast, setShowConnectedToast] = useState(false);
  /** Auto-enable tried and failed — keep Retry visible (don't go quiet). */
  const [autoAttachNeedsRetry, setAutoAttachNeedsRetry] = useState(false);
  // One auto-attempt per provider+workspace until attached (or user retries).
  const autoEnableKeyRef = useRef<string | null>(null);
  const sawAttachedRef = useRef(false);

  const providerId = modelId ? localAcpModelIdToProviderId(modelId) : null;
  const isLocal = isLocalAcpModelId(modelId);
  const ensureStatus = providerId
    ? acpStatus?.ensureByProvider?.[providerId]
    : undefined;
  const ensureRunning = ensureStatus?.state === "running";
  const provider = providerId
    ? acpStatus?.providers.find(p => p.id === providerId)
    : undefined;
  const attached = Boolean(
    providerId &&
      sessions.some(s => s.providerId === providerId && s.makoMcpAttached),
  );
  const needsCliLogin = (() => {
    if (!provider || !providerId) return false;
    if (providerId === "codex") {
      if (typeof provider.cliLoggedIn === "boolean") {
        return !provider.cliLoggedIn;
      }
      return Boolean(provider.authRequired) && !provider.connected;
    }
    return Boolean(provider.authRequired) && !provider.connected;
  })();

  useEffect(() => {
    if (!isLocal || !providerId) return;
    sawAttachedRef.current = false;
    setShowConnectedToast(false);
    setAutoAttachNeedsRetry(false);
    autoEnableKeyRef.current = null;
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

  // Flash a short “connected” indicator once, then hide — not a sticky banner.
  useEffect(() => {
    if (!attached) {
      sawAttachedRef.current = false;
      return;
    }
    if (sawAttachedRef.current) return;
    sawAttachedRef.current = true;
    setShowConnectedToast(true);
    const timer = window.setTimeout(() => setShowConnectedToast(false), 3200);
    return () => window.clearTimeout(timer);
  }, [attached]);

  // Poll status while npm ensure is running so the banner can show progress.
  useEffect(() => {
    if (!ensureRunning) return;
    const timer = window.setInterval(() => {
      void refreshStatus();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [ensureRunning, refreshStatus]);

  const enable = useCallback(async () => {
    if (!workspaceId || !providerId) return;
    setBusy(true);
    setBusyLabel("Connecting…");
    try {
      await checkAgent();
      await refreshStatus();
      setSelectedProvider(providerId);
      // Only install when the adapter is missing — never block Enable on a
      // slow/hung `npm i -g` when Codex/Claude is already on PATH.
      const adapterMissing = !useAcpStore
        .getState()
        .status?.providers.find(p => p.id === providerId)?.adapterFound;
      if (
        adapterMissing &&
        acpSupportsAdapterEnsure(useAcpStore.getState().status)
      ) {
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
      await refreshSessions();
      const ok = Boolean(session?.makoMcpAttached);
      setAutoAttachNeedsRetry(!ok);
    } catch {
      setAutoAttachNeedsRetry(true);
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }, [
    workspaceId,
    providerId,
    checkAgent,
    refreshStatus,
    setSelectedProvider,
    ensureAdapter,
    warmProviderModels,
    createSession,
    refreshSessions,
  ]);

  // Auto-attach workspace MCP when the user picks a local model and is ready
  // (signed in, adapter present, workspace selected). Avoids the extra click;
  // still gated so we don't mint tokens / spawn adapters while Sign in is needed.
  useEffect(() => {
    if (!isLocal || !providerId || !workspaceId) return;
    if (attached) {
      // Latch success so a later session drop (model change) can auto again.
      autoEnableKeyRef.current = `done:${providerId}:${workspaceId}`;
      return;
    }
    if (!bridgeOk || agentStatus === "offline" || statusError) return;
    if (!provider?.adapterFound || needsCliLogin || busy) return;
    const key = `try:${providerId}:${workspaceId}`;
    // Skip if we already tried this pair and failed (manual Retry still works).
    if (autoEnableKeyRef.current === key) return;
    autoEnableKeyRef.current = key;
    void enable();
  }, [
    isLocal,
    providerId,
    workspaceId,
    bridgeOk,
    agentStatus,
    statusError,
    provider?.adapterFound,
    needsCliLogin,
    attached,
    busy,
    enable,
  ]);

  if (!isLocal || !providerId) return null;

  // Background `npm i -g` while adapter is already on PATH must not freeze Enable.
  const ensureBlocksUi = ensureRunning && !provider?.adapterFound;

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
            disabled={busy || ensureBlocksUi}
            onClick={() => void installAdapter()}
          >
            {busy || ensureBlocksUi
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

  if (needsCliLogin && provider) {
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
              // After Sign in completes, clear the auto latch so tools attach.
              autoEnableKeyRef.current = null;
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
          Then Mako attaches workspace tools (BigQuery, SQL, connections)
          automatically — no terminal MCP setup.
        </Typography>
      </Alert>
    );
  }

  const displayError = sanitizeAcpUserError(error, { providerId });
  const showError =
    Boolean(displayError) &&
    !/missing ACP route|outdated for this action|missing this ACP route|Update needs PR Desktop|CODEX_API_KEY|OPENAI_API_KEY/i.test(
      displayError || "",
    );

  // Quiet success path: brief toast, then nothing. Connecting is the same —
  // a compact temporary line, not a sticky call-to-action.
  if (attached && !showError) {
    if (!showConnectedToast) return null;
    return (
      <Alert
        severity="success"
        sx={{ mb: 1, py: 0.5 }}
        onClose={() => setShowConnectedToast(false)}
      >
        <Typography variant="body2">
          Workspace tools connected for {provider?.label || "local agent"}
        </Typography>
      </Alert>
    );
  }

  if (busy || ensureBlocksUi) {
    return (
      <Alert severity="info" sx={{ mb: 1, py: 0.5 }}>
        <Typography variant="body2">
          {busyLabel || ensureLabel || "Connecting workspace tools…"}
        </Typography>
      </Alert>
    );
  }

  // Quiet when healthy; stick around for retry / missing workspace / failed auto.
  if (!showError && !autoAttachNeedsRetry && workspaceId && bridgeOk) {
    return null;
  }

  return (
    <Alert
      severity={showError ? "error" : "info"}
      sx={{ mb: 1 }}
      action={
        <Stack direction="row" spacing={1}>
          <Button
            size="small"
            variant="contained"
            disabled={!workspaceId || !bridgeOk}
            onClick={() => {
              autoEnableKeyRef.current = null;
              void enable();
            }}
          >
            Enable workspace tools
          </Button>
        </Stack>
      }
    >
      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
        Workspace tools need a retry
      </Typography>
      <Typography variant="body2">
        {showError
          ? displayError
          : !workspaceId
            ? "Select a workspace first."
            : !bridgeOk
              ? "Local Agent is outdated for MCP attach — install Desktop 0.3.9+ and fully quit/reopen Mako."
              : `Could not auto-connect tools for ${
                  provider?.label || "this local agent"
                }.`}
      </Typography>
      {ensureStatus?.state === "error" && ensureLabel ? (
        <Typography variant="body2" sx={{ mt: 1 }}>
          {ensureLabel}
        </Typography>
      ) : null}
    </Alert>
  );
}
