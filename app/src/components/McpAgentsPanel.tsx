import { useState, useEffect, useCallback } from "react";
import {
  Box,
  Typography,
  Button,
  IconButton,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Tooltip,
  Chip,
  Skeleton,
  Snackbar,
  Stack,
  Tab,
  Tabs,
} from "@mui/material";
import {
  ContentCopy as CopyIcon,
  LinkOff as RevokeIcon,
} from "@mui/icons-material";
import { formatDistanceToNow } from "date-fns";
import { useWorkspace } from "../contexts/workspace-context";
import { useMcpStore } from "../store/mcpStore";
import {
  selectTabBySettingsSection,
  useConsoleStore,
} from "../store/consoleStore";
import { SECTION_LABELS } from "../pages/settings/sections";

const MCP_STARTER_PROMPT =
  "Using the mako tools, explore my data and build an app showing revenue " +
  "by month, then give me a preview link.";

/**
 * OAuth-first agent setup (no API key): give the client the MCP URL and it
 * discovers the sign-in flow itself (RFC 9728). One entry per client tab.
 */
function buildMcpOAuthSetups() {
  const endpoint = `${window.location.origin}/api/mcp`;
  const cursorDeeplink =
    "cursor://anysphere.cursor-deeplink/mcp/install?name=mako&config=" +
    encodeURIComponent(btoa(JSON.stringify({ url: endpoint })));
  // claude.ai deep-link that opens the "Add custom connector" dialog with
  // name + URL prefilled (docs: connectors/building/directory-vs-custom).
  const claudeDeeplink =
    "https://claude.ai/customize/connectors?modal=add-custom-connector" +
    `&connectorName=mako&connectorUrl=${encodeURIComponent(endpoint)}`;
  return {
    endpoint,
    clients: [
      {
        client: "Claude Code",
        instruction:
          "Run this, then type /mcp inside a session to sign in with your browser:",
        snippet: `claude mcp add --transport http mako ${endpoint}`,
      },
      {
        client: "Claude (web)",
        instruction:
          "One click below — claude.ai opens with the connector prefilled. Click Add, then Connect and sign in. Or manually: Settings → Connectors → Add custom connector, paste the URL from step 1.",
        snippet: endpoint,
        deeplink: claudeDeeplink,
        deeplinkLabel: "Add to Claude",
      },
      {
        client: "ChatGPT",
        instruction:
          "In ChatGPT: Settings → Connectors → Create (if you don't see it, enable Developer mode under Advanced settings first). Name it mako, paste the URL, choose OAuth, and sign in. Works in chat and deep research — Mako implements ChatGPT's search / fetch connector contract.",
        snippet: endpoint,
      },
      {
        client: "Cursor",
        instruction:
          "One click below — Cursor opens, installs the server, and prompts you to sign in. Or paste into .cursor/mcp.json:",
        snippet: JSON.stringify(
          { mcpServers: { mako: { url: endpoint } } },
          null,
          2,
        ),
        deeplink: cursorDeeplink,
        deeplinkLabel: "Add to Cursor",
      },
      {
        client: "Codex",
        instruction:
          "Add this to ~/.codex/config.toml — Codex opens your browser to sign in on first use:",
        snippet: `[mcp_servers.mako]\nurl = "${endpoint}"`,
      },
      {
        client: "Other",
        instruction:
          "Any MCP client that supports OAuth discovers the sign-in flow from the URL alone. Key-based clients can send a Bearer API key instead.",
        snippet: endpoint,
      },
    ],
  };
}

/**
 * The primary "connect an AI agent" card: copy URL → add to client → sign
 * in. No API key involved; the OAuth consent page asks which workspace to
 * grant (read-only) access to.
 */
export function McpAgentConnectCard({
  onCopy,
}: {
  onCopy: (text: string) => void;
}) {
  const [tab, setTab] = useState(0);
  const { endpoint, clients } = buildMcpOAuthSetups();
  const active = clients[tab] ?? clients[0];

  return (
    <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        Connect an AI agent (MCP)
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        No API key needed — your agent signs in with your Mako account and you
        pick which workspace it can read.{" "}
        <a
          href="https://docs.mako.ai/mcp-server/"
          target="_blank"
          rel="noreferrer"
        >
          Full guide
        </a>
      </Typography>

      <Tabs
        value={tab}
        onChange={(_e, value: number) => setTab(value)}
        variant="scrollable"
        allowScrollButtonsMobile
        sx={{ minHeight: 36, mb: 2, borderBottom: 1, borderColor: "divider" }}
      >
        {clients.map(setup => (
          <Tab
            key={setup.client}
            label={setup.client}
            sx={{ minHeight: 36, py: 0.5, textTransform: "none" }}
          />
        ))}
      </Tabs>

      <Stack spacing={2}>
        <Box>
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
            1 · Copy the Mako MCP URL
          </Typography>
          <Stack direction="row" alignItems="center" spacing={0.5}>
            <Box
              component="code"
              sx={{
                flex: 1,
                minWidth: 0,
                p: 1,
                borderRadius: 1,
                bgcolor: "action.hover",
                fontFamily: "monospace",
                fontSize: "0.8rem",
                wordBreak: "break-all",
              }}
            >
              {endpoint}
            </Box>
            <Tooltip title="Copy MCP URL">
              <IconButton
                size="small"
                onClick={() => onCopy(endpoint)}
                aria-label="Copy MCP URL"
              >
                <CopyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Box>

        <Box>
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
            2 · Add it to {active.client}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {active.instruction}
          </Typography>
          {active.deeplink && (
            <Button
              variant="contained"
              size="small"
              href={active.deeplink}
              {...(active.deeplink.startsWith("https://")
                ? { target: "_blank", rel: "noreferrer" }
                : {})}
              sx={theme => ({
                mb: 1,
                textTransform: "none",
                // Explicit: rendered as an <a>, so global anchor resets /
                // browser quirks can otherwise swallow the inherited label
                // color and leave an unreadable blue-on-blue button.
                // -webkit-text-fill-color beats any inherited `color`
                // (Safari applies it over `color` when set anywhere up the
                // tree, e.g. by autofill/preflight resets).
                color: "primary.contrastText",
                WebkitTextFillColor: theme.palette.primary.contrastText,
                "&:hover": {
                  color: "primary.contrastText",
                  WebkitTextFillColor: theme.palette.primary.contrastText,
                },
              })}
            >
              {active.deeplinkLabel}
            </Button>
          )}
          <Box sx={{ position: "relative" }}>
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 1.5,
                pr: 6,
                bgcolor: "grey.100",
                borderRadius: 1,
                fontSize: "0.7rem",
                overflow: "auto",
                whiteSpace: "pre",
              }}
            >
              {active.snippet}
            </Box>
            <Tooltip title={`Copy ${active.client} setup`}>
              <IconButton
                size="small"
                onClick={() => onCopy(active.snippet)}
                aria-label={`Copy ${active.client} setup`}
                sx={{ position: "absolute", top: 6, right: 6 }}
              >
                <CopyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>

        <Box>
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
            3 · Sign in and ask it something
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Your browser opens once to approve read-only access for a workspace.
            Then:
          </Typography>
          <Stack direction="row" alignItems="flex-start" spacing={0.5}>
            <Box
              sx={{
                flex: 1,
                p: 1.5,
                bgcolor: "grey.100",
                borderRadius: 1,
                fontStyle: "italic",
                fontSize: "0.8rem",
              }}
            >
              &quot;{MCP_STARTER_PROMPT}&quot;
            </Box>
            <Tooltip title="Copy starter prompt">
              <IconButton
                size="small"
                onClick={() => onCopy(MCP_STARTER_PROMPT)}
                aria-label="Copy starter prompt"
              >
                <CopyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Box>
      </Stack>
    </Paper>
  );
}

interface McpConnection {
  clientId: string;
  clientName: string;
  userId: string;
  userEmail: string;
  isOwn: boolean;
  connectedAt: string;
  lastUsedAt: string | null;
}

interface McpConnectionsResponse {
  success: boolean;
  connections: McpConnection[];
  canSeeAll: boolean;
  error?: string;
}

/**
 * Agents currently holding an OAuth grant on this workspace. Members see
 * their own connections; owners/admins see everyone's and can revoke any.
 */
export function McpConnectedAgents({
  onNotify,
}: {
  onNotify: (message: string, severity: "success" | "error") => void;
}) {
  const { currentWorkspace, loading: workspaceLoading } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const fetchMcpConnections = useMcpStore(s => s.fetchMcpConnections);
  const revokeMcpConnection = useMcpStore(s => s.revokeMcpConnection);
  const [connections, setConnections] = useState<McpConnection[] | null>(null);
  const [canSeeAll, setCanSeeAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchConnections = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const response = (await fetchMcpConnections(
        workspaceId,
      )) as unknown as McpConnectionsResponse;
      setConnections(response.connections ?? []);
      setCanSeeAll(Boolean(response.canSeeAll));
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load connected agents",
      );
    }
  }, [workspaceId, fetchMcpConnections]);

  useEffect(() => {
    if (!workspaceLoading && workspaceId) {
      setConnections(null);
      void fetchConnections();
    }
  }, [workspaceLoading, workspaceId, fetchConnections]);

  const handleRevoke = async (connection: McpConnection) => {
    if (!workspaceId) return;
    if (
      !confirm(
        `Disconnect "${connection.clientName}"? The agent loses access immediately and must sign in again to reconnect.`,
      )
    ) {
      return;
    }
    try {
      await revokeMcpConnection(
        workspaceId,
        connection.clientId,
        connection.userId,
      );
      onNotify("Agent disconnected", "success");
      void fetchConnections();
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : "Failed to disconnect agent",
        "error",
      );
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        Connected agents
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {canSeeAll
          ? "Every agent connected to this workspace via MCP sign-in. Disconnecting revokes its access immediately."
          : "Agents you connected to this workspace via MCP sign-in. Disconnecting revokes their access immediately."}
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {connections === null && !error ? (
        <Stack spacing={1}>
          <Skeleton variant="rounded" height={36} />
          <Skeleton variant="rounded" height={36} />
        </Stack>
      ) : (connections ?? []).length === 0 ? (
        <Alert severity="info">
          No agents connected yet. Use the card above — copy the URL, add it to
          your client, sign in.
        </Alert>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Agent</TableCell>
                {canSeeAll && <TableCell>Connected by</TableCell>}
                <TableCell>Connected</TableCell>
                <TableCell>Last used</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(connections ?? []).map(connection => (
                <TableRow key={`${connection.clientId}:${connection.userId}`}>
                  <TableCell>
                    <Stack direction="row" alignItems="center" spacing={1}>
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>
                        {connection.clientName}
                      </Typography>
                      <Chip label="read-only" size="small" variant="outlined" />
                    </Stack>
                  </TableCell>
                  {canSeeAll && (
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {connection.userEmail || "—"}
                        {connection.isOwn ? " (you)" : ""}
                      </Typography>
                    </TableCell>
                  )}
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">
                      {formatDistanceToNow(new Date(connection.connectedAt), {
                        addSuffix: true,
                      })}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">
                      {connection.lastUsedAt
                        ? formatDistanceToNow(new Date(connection.lastUsedAt), {
                            addSuffix: true,
                          })
                        : "Never"}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title="Disconnect this agent">
                      <IconButton
                        size="small"
                        onClick={() => void handleRevoke(connection)}
                        aria-label={`Disconnect ${connection.clientName}`}
                      >
                        <RevokeIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Paper>
  );
}

/** Full "Connect Agents" settings page body: how to connect + what is. */
export function McpAgentsPanel() {
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: "success" | "error";
  }>({ open: false, message: "", severity: "success" });

  const notify = (message: string, severity: "success" | "error") =>
    setSnackbar({ open: true, message, severity });

  const copyToClipboard = (text: string) => {
    void navigator.clipboard.writeText(text);
    notify("Copied to clipboard", "success");
  };

  const openCodingAgents = () => {
    const state = useConsoleStore.getState();
    const existing = selectTabBySettingsSection("coding-agents")(state);
    if (existing) {
      state.setActiveTab(existing.id);
      return;
    }
    const id = state.openTab({
      title: SECTION_LABELS["coding-agents"],
      content: "",
      kind: "settings",
      settingsSection: "coding-agents",
    });
    state.setActiveTab(id);
  };

  return (
    <Box>
      <Alert severity="info" sx={{ mb: 2 }}>
        This page lets external agents (Claude Code, Cursor, Codex) call{" "}
        <strong>into</strong> Mako over MCP. To run Claude Code or Codex{" "}
        <strong>inside</strong> Mako, pick them under{" "}
        <strong>On this machine</strong> in the Chat model dropdown (setup:{" "}
        <Button size="small" onClick={openCodingAgents} sx={{ ml: 0.5 }}>
          Coding Agents
        </Button>
        ).
      </Alert>
      <McpAgentConnectCard onCopy={copyToClipboard} />
      <McpConnectedAgents onNotify={notify} />
      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar(s => ({ ...s, open: false }))}
        message={snackbar.message}
      />
    </Box>
  );
}
