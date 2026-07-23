import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useAcpStore } from "../store/acpStore";
import { useLocalAgentStore } from "../store/localAgentStore";
import type { AcpProviderId } from "../lib/acp-types";

/**
 * Settings setup for Local Agent ACP providers.
 *
 * Chatting happens in the main Chat view — pick Claude Code (local) or
 * Codex (local) from the model dropdown. This page only configures adapter
 * status, sign-in, and the default working directory.
 */
async function bootCodingAgents(): Promise<void> {
  const agentStatus = await useLocalAgentStore.getState().checkAgent();
  if (agentStatus !== "online") return;
  await useAcpStore.getState().refreshStatus();
}

export function CodingAgentsPanel() {
  const agentStatus = useLocalAgentStore(s => s.status);
  const acpStatus = useAcpStore(s => s.status);
  const statusError = useAcpStore(s => s.statusError);
  const error = useAcpStore(s => s.error);
  const authGuidance = useAcpStore(s => s.authGuidance);
  const selectedProviderId = useAcpStore(s => s.selectedProviderId);
  const setSelectedProvider = useAcpStore(s => s.setSelectedProvider);
  const authenticate = useAcpStore(s => s.authenticate);
  const ensureAdapter = useAcpStore(s => s.ensureAdapter);
  const cwdDraft = useAcpStore(s => s.cwdDraft);
  const setCwdDraft = useAcpStore(s => s.setCwdDraft);
  const loadingStatus = useAcpStore(s => s.loadingStatus);

  const [booting, setBooting] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBooting(true);
    void bootCodingAgents().finally(() => {
      if (!cancelled) setBooting(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const retry = () => {
    setBooting(true);
    void bootCodingAgents().finally(() => setBooting(false));
  };

  if (booting || agentStatus === "unknown") {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 4 }}>
        <CircularProgress size={20} />
        <Typography variant="body2">Checking Local Agent…</Typography>
      </Box>
    );
  }

  if (agentStatus === "offline" || statusError || !acpStatus) {
    const hint =
      statusError?.includes("404") || statusError?.includes("Not Found")
        ? "Your Local Agent build does not include ACP yet. From the PR branch run: pnpm agent:start"
        : null;

    return (
      <Alert severity="warning">
        Coding agents run on your machine via the Mako Local Agent (loopback ACP
        bridge). Start <strong>Mako Desktop</strong> (PR build) or run{" "}
        <code>pnpm agent:start</code> from the ACP branch, then retry.
        {statusError ? (
          <Typography variant="body2" sx={{ mt: 1 }}>
            {statusError}
          </Typography>
        ) : null}
        {hint ? (
          <Typography variant="body2" sx={{ mt: 1 }}>
            {hint}
          </Typography>
        ) : null}
        <Box sx={{ mt: 2 }}>
          <Button size="small" variant="outlined" onClick={retry}>
            Retry
          </Button>
        </Box>
      </Alert>
    );
  }

  const providers = acpStatus.providers ?? [];
  const provider = providers.find(p => p.id === selectedProviderId);
  const selectValue = provider ? selectedProviderId : "";
  const readyProviders = providers.filter(p => p.adapterFound);
  const bridgeOk = Boolean(
    acpStatus.acpBridge?.version && acpStatus.acpBridge.version >= 2,
  );
  const lastAdapterError = acpStatus.lastAdapterError;

  return (
    <Box>
      {!bridgeOk ? (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            Local Agent is outdated for Coding Agents
          </Typography>
          <Typography variant="body2" sx={{ mb: 1 }}>
            You&apos;re still running an older Desktop-bundled agent (it reports
            raw &quot;ACP connection closed&quot;). Install the latest{" "}
            <strong>desktop-canary</strong>, fully quit Mako (Cmd+Q), and reopen
            — or for developers: quit Desktop and run{" "}
            <code>pnpm agent:start</code> from this PR branch.
          </Typography>
          <Typography variant="caption" component="div">
            Canary:{" "}
            <a
              href="https://github.com/mako-ai/mako/releases/tag/desktop-canary"
              target="_blank"
              rel="noreferrer"
            >
              github.com/mako-ai/mako/releases/tag/desktop-canary
            </a>
          </Typography>
        </Alert>
      ) : null}

      <Alert severity="info" sx={{ mb: 2 }}>
        Chat with Claude Code or Codex from the <strong>main Chat</strong> model
        dropdown under <strong>On this machine</strong>. Tokens bill to your
        Claude Pro/Max or ChatGPT subscription. If workspace tools are not
        active, Chat shows <strong>Enable workspace tools</strong> — one click,
        no <code>claude mcp</code>. File and shell tools still run locally.
      </Alert>

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
          Local setup
        </Typography>
        <Stack spacing={2}>
          <FormControl fullWidth size="small">
            <InputLabel id="acp-provider-label">Default provider</InputLabel>
            <Select
              labelId="acp-provider-label"
              label="Default provider"
              value={selectValue}
              displayEmpty
              disabled={providers.length === 0}
              onChange={e => {
                const next = e.target.value;
                if (next) setSelectedProvider(next as AcpProviderId);
              }}
            >
              {providers.length === 0 ? (
                <MenuItem value="">
                  <em>Loading providers…</em>
                </MenuItem>
              ) : (
                providers.map(p => (
                  <MenuItem key={p.id} value={p.id}>
                    {p.label}
                    {!p.adapterFound ? " (adapter missing)" : ""}
                  </MenuItem>
                ))
              )}
            </Select>
          </FormControl>

          {provider && (
            <Box>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                {provider.description}
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Chip
                  size="small"
                  label={
                    provider.adapterFound ? "Adapter found" : "Adapter missing"
                  }
                  color={provider.adapterFound ? "success" : "warning"}
                  variant="outlined"
                />
                <Chip
                  size="small"
                  label={`Auth: ${provider.authProduct}`}
                  variant="outlined"
                />
                {provider.connected && (
                  <Chip size="small" label="Connected" color="info" />
                )}
              </Stack>
              {!provider.adapterFound && (
                <Alert severity="info" sx={{ mt: 1 }}>
                  Adapter missing — use <strong>Install / update</strong> below
                  (Mako runs npm on this machine).
                </Alert>
              )}
            </Box>
          )}

          <TextField
            size="small"
            label="Default working directory"
            value={cwdDraft}
            onChange={e => setCwdDraft(e.target.value)}
            helperText="Used when Chat starts a local Claude/Codex turn. Absolute path on this machine."
            fullWidth
          />

          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            flexWrap="wrap"
          >
            <Button
              variant="contained"
              onClick={() => {
                setUpdating(true);
                void ensureAdapter(selectedProviderId, { force: true }).finally(
                  () => setUpdating(false),
                );
              }}
              disabled={
                loadingStatus ||
                updating ||
                signingIn ||
                !(
                  acpStatus.acpBridge?.adapterEnsure ||
                  (acpStatus.acpBridge?.version &&
                    acpStatus.acpBridge.version >= 6)
                )
              }
            >
              {updating
                ? "Updating…"
                : provider?.adapterFound
                  ? `Update ${provider.label}`
                  : `Install ${provider?.label || "adapter"}`}
            </Button>
            <Button
              variant="outlined"
              onClick={() => {
                setSigningIn(true);
                void authenticate().finally(() => setSigningIn(false));
              }}
              disabled={!provider?.adapterFound || loadingStatus || signingIn}
            >
              {signingIn
                ? "Opening Terminal…"
                : `Sign in with ${provider?.authProduct || "provider"}`}
            </Button>
            <Typography variant="body2" color="text.secondary">
              {!(
                acpStatus.acpBridge?.adapterEnsure ||
                (acpStatus.acpBridge?.version &&
                  acpStatus.acpBridge.version >= 6)
              )
                ? "Local Agent is outdated for one-click Update — install Desktop 0.3.9+ and fully quit/reopen Mako."
                : readyProviders.length > 0
                  ? `Update keeps ${provider?.label || "the adapter"} current. Sign in opens Terminal for CLI login.`
                  : "Install the adapter here — no Terminal npm required."}
            </Typography>
          </Stack>

          <Typography variant="caption" color="text.secondary" component="div">
            {selectedProviderId === "codex" ? (
              <>
                Prefer the CLI? Run <code>codex</code> login (ChatGPT), or{" "}
                <code>
                  npm i -g @openai/codex @agentclientprotocol/codex-acp
                </code>
                , then return here and use Chat → Enable workspace tools.
              </>
            ) : (
              <>
                Prefer the CLI? Run <code>claude auth login</code> (or{" "}
                <code>
                  npx --yes @agentclientprotocol/claude-agent-acp --cli auth
                  login --claudeai
                </code>
                ), then return here and use Chat → Enable workspace tools.
              </>
            )}
          </Typography>
        </Stack>
      </Paper>

      {authGuidance && (
        <Alert severity="info" sx={{ mb: 2, whiteSpace: "pre-wrap" }}>
          {authGuidance}
        </Alert>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
          {/ACP connection closed|outdated for this action|missing ACP route/i.test(
            error,
          ) ? (
            <Typography variant="body2" sx={{ mt: 1 }}>
              Local Agent is stale on port 41720. Fully quit Desktop (Cmd+Q /
              Quit), confirm with <code>lsof -i :41720</code>, reopen Desktop
              0.3.9+, then retry Update / Enable workspace tools.
            </Typography>
          ) : null}
          {/ENOTEMPTY|_npx/i.test(`${error}\n${lastAdapterError || ""}`) ? (
            <Typography variant="body2" sx={{ mt: 1 }}>
              Broken npm/npx cache. In Terminal run:
              <br />
              <code>rm -rf ~/.npm/_npx</code>
              <br />
              <code>
                {selectedProviderId === "codex"
                  ? "npm i -g @openai/codex @agentclientprotocol/codex-acp"
                  : "npm i -g @agentclientprotocol/claude-agent-acp"}
              </code>
              <br />
              then retry Enable workspace tools (global install avoids npx).
            </Typography>
          ) : null}
          {lastAdapterError ? (
            <Typography
              variant="caption"
              component="pre"
              sx={{ mt: 1, whiteSpace: "pre-wrap", opacity: 0.9 }}
            >
              {lastAdapterError}
            </Typography>
          ) : null}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
          Providers on this machine
        </Typography>
        <Stack spacing={1}>
          {providers.map(p => (
            <Box
              key={p.id}
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 1,
              }}
            >
              <Box>
                <Typography variant="body2">{p.label}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {p.adapterFound
                    ? p.adapterCommand || "adapter on PATH"
                    : p.installHint}
                </Typography>
              </Box>
              <Chip
                size="small"
                label={p.adapterFound ? "Available in Chat" : "Not installed"}
                color={p.adapterFound ? "success" : "default"}
                variant="outlined"
              />
            </Box>
          ))}
        </Stack>
      </Paper>
    </Box>
  );
}
