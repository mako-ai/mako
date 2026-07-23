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

function ProviderSetupCard() {
  const status = useAcpStore(s => s.status);
  const selectedProviderId = useAcpStore(s => s.selectedProviderId);
  const setSelectedProvider = useAcpStore(s => s.setSelectedProvider);
  const authenticate = useAcpStore(s => s.authenticate);
  const cwdDraft = useAcpStore(s => s.cwdDraft);
  const setCwdDraft = useAcpStore(s => s.setCwdDraft);
  const createSession = useAcpStore(s => s.createSession);
  const loadingStatus = useAcpStore(s => s.loadingStatus);

  const providers = status?.providers ?? [];
  const provider = providers.find(p => p.id === selectedProviderId);
  // Only bind a value that exists as a MenuItem — empty list + value crashes MUI.
  const selectValue = provider ? selectedProviderId : "";

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
        New session
      </Typography>
      <Stack spacing={2}>
        <FormControl fullWidth size="small">
          <InputLabel id="acp-provider-label">Provider</InputLabel>
          <Select
            labelId="acp-provider-label"
            label="Provider"
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
                {provider.installHint}
              </Alert>
            )}
          </Box>
        )}

        <TextField
          size="small"
          label="Working directory"
          value={cwdDraft}
          onChange={e => setCwdDraft(e.target.value)}
          helperText="Absolute path on this machine. Claude/Codex tools run here."
          fullWidth
        />

        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined"
            onClick={() => void authenticate()}
            disabled={!provider?.adapterFound || loadingStatus}
          >
            Sign in with {provider?.authProduct || "provider"}
          </Button>
          <Button
            variant="contained"
            onClick={() => void createSession()}
            disabled={!provider?.adapterFound || loadingStatus}
          >
            Start session
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}

function PermissionCard() {
  const activeSessionId = useAcpStore(s => s.activeSessionId);
  const prompt = useAcpStore(s =>
    activeSessionId ? s.permissionsBySession[activeSessionId] : null,
  );
  const respondPermission = useAcpStore(s => s.respondPermission);

  if (!prompt) return null;

  const tool = prompt.toolCall as { title?: string; kind?: string } | null;

  return (
    <Alert
      severity="warning"
      sx={{ mb: 1 }}
      action={
        <Stack direction="row" spacing={1}>
          {prompt.options.map(opt => (
            <Button
              key={opt.optionId}
              size="small"
              color={
                opt.kind?.startsWith("reject") || opt.kind?.includes("deny")
                  ? "inherit"
                  : "warning"
              }
              variant={opt.kind?.startsWith("allow") ? "contained" : "outlined"}
              onClick={() =>
                void respondPermission(
                  opt.kind?.startsWith("reject") ? "cancelled" : "selected",
                  opt.kind?.startsWith("reject") ? undefined : opt.optionId,
                )
              }
            >
              {opt.name}
            </Button>
          ))}
          <Button
            size="small"
            onClick={() => void respondPermission("cancelled")}
          >
            Deny
          </Button>
        </Stack>
      }
    >
      Permission required
      {tool?.title ? `: ${tool.title}` : ""}
      {tool?.kind ? ` (${tool.kind})` : ""}
    </Alert>
  );
}

/** Stable empty array — `|| []` inside a zustand selector is a new reference
 * every render and triggers React #185 (max update depth). */
const EMPTY_MESSAGES: import("../lib/acp-types").AcpChatMessage[] = [];

function Transcript() {
  const activeSessionId = useAcpStore(s => s.activeSessionId);
  const messages = useAcpStore(s => {
    if (!activeSessionId) return EMPTY_MESSAGES;
    return s.messagesBySession[activeSessionId] ?? EMPTY_MESSAGES;
  });

  if (!activeSessionId) {
    return (
      <Typography variant="body2" color="text.secondary">
        Start a session to chat with Claude Code or Codex on this machine.
      </Typography>
    );
  }

  if (messages.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No messages yet. Send a prompt below.
      </Typography>
    );
  }

  return (
    <Stack spacing={1.5}>
      {messages.map(m => (
        <Box
          key={m.id}
          sx={{
            alignSelf: m.role === "user" ? "flex-end" : "flex-start",
            maxWidth: "90%",
            px: 1.5,
            py: 1,
            borderRadius: 1,
            bgcolor:
              m.role === "user"
                ? "action.selected"
                : m.role === "tool"
                  ? "action.hover"
                  : "background.default",
            border: "1px solid",
            borderColor: "divider",
            whiteSpace: "pre-wrap",
            fontFamily: m.role === "tool" ? "monospace" : "inherit",
            fontSize: m.role === "tool" ? 13 : 14,
          }}
        >
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", mb: 0.5 }}
          >
            {m.role}
          </Typography>
          {m.text}
        </Box>
      ))}
    </Stack>
  );
}

async function bootCodingAgents(): Promise<void> {
  const agentStatus = await useLocalAgentStore.getState().checkAgent();
  if (agentStatus !== "online") return;
  await useAcpStore.getState().refreshStatus();
  await useAcpStore.getState().refreshSessions();
}

export function CodingAgentsPanel() {
  const agentStatus = useLocalAgentStore(s => s.status);
  const acpStatus = useAcpStore(s => s.status);
  const statusError = useAcpStore(s => s.statusError);
  const sessions = useAcpStore(s => s.sessions);
  const activeSessionId = useAcpStore(s => s.activeSessionId);
  const setActiveSession = useAcpStore(s => s.setActiveSession);
  const sendPrompt = useAcpStore(s => s.sendPrompt);
  const cancelActive = useAcpStore(s => s.cancelActive);
  const closeActive = useAcpStore(s => s.closeActive);
  const sending = useAcpStore(s => s.sending);
  const error = useAcpStore(s => s.error);

  const [draft, setDraft] = useState("");
  // Local boot flag — do NOT key a useEffect off zustand action identities
  // (immer updates can churn them and re-fire the effect → React #185).
  const [booting, setBooting] = useState(true);

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

  return (
    <Box>
      <Alert severity="info" sx={{ mb: 2 }}>
        Tokens bill to your Claude Pro/Max or ChatGPT subscription — not Mako.
        File and shell tools run locally through the ACP adapter. Mako Cloud
        never proxies the ACP stdio pipe.
      </Alert>

      <ProviderSetupCard />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "220px 1fr" },
          gap: 2,
          minHeight: 420,
        }}
      >
        <Paper variant="outlined" sx={{ p: 1.5 }}>
          <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
            Sessions
          </Typography>
          <Stack spacing={0.5}>
            {sessions.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                No open sessions
              </Typography>
            )}
            {sessions.map(session => (
              <Button
                key={session.id}
                size="small"
                variant={session.id === activeSessionId ? "contained" : "text"}
                onClick={() => setActiveSession(session.id)}
                sx={{
                  justifyContent: "flex-start",
                  textTransform: "none",
                }}
              >
                <Box sx={{ textAlign: "left", overflow: "hidden" }}>
                  <Typography variant="body2" noWrap>
                    {session.title}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {session.providerId}
                    {session.busy ? " · busy" : ""}
                  </Typography>
                </Box>
              </Button>
            ))}
          </Stack>
        </Paper>

        <Paper
          variant="outlined"
          sx={{
            p: 2,
            display: "flex",
            flexDirection: "column",
            minHeight: 420,
          }}
        >
          <PermissionCard />
          <Box sx={{ flex: 1, overflow: "auto", mb: 2 }}>
            <Transcript />
          </Box>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              fullWidth
              placeholder="Message the coding agent…"
              value={draft}
              disabled={!activeSessionId || sending}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  const text = draft;
                  setDraft("");
                  void sendPrompt(text);
                }
              }}
            />
            <Button
              variant="contained"
              disabled={!activeSessionId || sending || !draft.trim()}
              onClick={() => {
                const text = draft;
                setDraft("");
                void sendPrompt(text);
              }}
            >
              {sending ? "…" : "Send"}
            </Button>
            <Button
              variant="outlined"
              disabled={!activeSessionId || !sending}
              onClick={() => void cancelActive()}
            >
              Stop
            </Button>
            <Button
              variant="text"
              disabled={!activeSessionId}
              onClick={() => void closeActive()}
            >
              End
            </Button>
          </Stack>
        </Paper>
      </Box>
    </Box>
  );
}
