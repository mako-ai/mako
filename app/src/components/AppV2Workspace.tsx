/**
 * Apps v2 workspace view — the content of an `app-v2` tab: the app's home.
 *
 * Files are browsed/opened from the Apps v2 explorer (each file gets its own
 * `app-v2-file` tab, v1-style); this view owns everything app-level:
 *
 *   ┌ toolbar: Build & preview · History · Discard
 *   ├ preview: token-gated sandboxed iframe of the built app
 *   └ terminal: shell into the app's sandbox session (E2B microVM)
 *
 * Branch status, commit, and merge live in the Apps v2 explorer's "Version
 * control" section (sidebar), not here — same split as Transforms.
 *
 * Every read resolves from git through the durable worktree API, so the view
 * renders identically whether the sandbox is hot, paused, or dead.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  InputBase,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  Eraser as ClearIcon,
  History as HistoryIcon,
  Play as PlayIcon,
  RotateCcw as DiscardIcon,
  TerminalSquare as TerminalIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useRealtimeStore } from "../store/realtimeStore";
import { useAppsV2Store, type AppV2TerminalEntry } from "../store/appsV2Store";

// ---------------------------------------------------------------------------
// Terminal panel
// ---------------------------------------------------------------------------

const EMPTY_TERMINAL: AppV2TerminalEntry[] = [];

function TerminalEntryView({ entry }: { entry: AppV2TerminalEntry }) {
  return (
    <Box sx={{ mb: 0.75 }}>
      <Typography
        variant="caption"
        sx={{ fontFamily: "monospace", fontWeight: 600 }}
      >
        $ {entry.command}
      </Typography>
      {entry.running ? (
        <Typography variant="caption" display="block" color="text.secondary">
          running...
        </Typography>
      ) : (
        <>
          {entry.stdout && (
            <Typography
              variant="caption"
              component="pre"
              sx={{ m: 0, fontFamily: "monospace", whiteSpace: "pre-wrap" }}
            >
              {entry.stdout}
            </Typography>
          )}
          {entry.stderr && (
            <Typography
              variant="caption"
              component="pre"
              color="warning.main"
              sx={{ m: 0, fontFamily: "monospace", whiteSpace: "pre-wrap" }}
            >
              {entry.stderr}
            </Typography>
          )}
          {entry.exitCode !== 0 && (
            <Typography variant="caption" color="error.main" display="block">
              exit {entry.exitCode}
              {entry.timedOut ? " (timed out)" : ""}
            </Typography>
          )}
        </>
      )}
    </Box>
  );
}

function TerminalPanel({
  appId,
  workspaceId,
}: {
  appId: string;
  workspaceId: string;
}) {
  const entries = useAppsV2Store(s => s.terminalByApp[appId] ?? EMPTY_TERMINAL);
  const running = useAppsV2Store(s => Boolean(s.execRunning[appId]));
  const runCommand = useAppsV2Store(s => s.runCommand);
  const clearTerminal = useAppsV2Store(s => s.clearTerminal);
  const [command, setCommand] = useState("");
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollEl?.scrollTo({ top: scrollEl.scrollHeight });
  }, [entries, scrollEl]);

  const submit = useCallback(() => {
    const trimmed = command.trim();
    if (!trimmed || running) return;
    setCommand("");
    void runCommand(workspaceId, appId, trimmed);
  }, [command, running, runCommand, workspaceId, appId]);

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        fontFamily: "monospace",
        bgcolor: "background.default",
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1,
          py: 0.25,
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <TerminalIcon size={14} />
        <Typography variant="caption" sx={{ flex: 1 }}>
          {
            "Terminal — runs in the app's sandbox session (E2B microVM; resumes if paused, rebuilds if dead)"
          }
        </Typography>
        <Tooltip title="Clear">
          <IconButton size="small" onClick={() => clearTerminal(appId)}>
            <ClearIcon size={14} />
          </IconButton>
        </Tooltip>
      </Box>
      <Box ref={setScrollEl} sx={{ flex: 1, overflow: "auto", px: 1, py: 0.5 }}>
        {entries.length === 0 && (
          <Typography variant="caption" color="text.secondary">
            Try: ls · git status · git log --oneline · npm install · npm run
            build
          </Typography>
        )}
        {entries.map(entry => (
          <TerminalEntryView key={entry.id} entry={entry} />
        ))}
      </Box>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1,
          py: 0.5,
          borderTop: "1px solid",
          borderColor: "divider",
        }}
      >
        <Typography
          variant="caption"
          color="success.main"
          sx={{ fontFamily: "monospace" }}
        >
          $
        </Typography>
        <InputBase
          fullWidth
          placeholder={
            running ? "Running..." : "Type a command and press Enter"
          }
          value={command}
          disabled={running}
          onChange={e => setCommand(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") submit();
          }}
          sx={{ fontFamily: "monospace", fontSize: 13 }}
          inputProps={{ "aria-label": "terminal command" }}
        />
        {running && <CircularProgress size={14} />}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export default function AppV2Workspace({
  tabId: _tabId,
  appId,
}: {
  tabId: string;
  appId: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const app = useAppsV2Store(s => s.apps.find(a => a.id === appId));
  const status = useAppsV2Store(s => s.statusByApp[appId]);
  const history = useAppsV2Store(s => s.historyByApp[appId]);
  const branches = useAppsV2Store(s => s.branchesByApp[appId]);
  const preview = useAppsV2Store(s => s.previewByApp[appId]);

  const fetchApps = useAppsV2Store(s => s.fetchApps);
  const fetchFiles = useAppsV2Store(s => s.fetchFiles);
  const fetchStatus = useAppsV2Store(s => s.fetchStatus);
  const fetchHistory = useAppsV2Store(s => s.fetchHistory);
  const fetchBranches = useAppsV2Store(s => s.fetchBranches);
  const discard = useAppsV2Store(s => s.discard);
  const buildPreview = useAppsV2Store(s => s.buildPreview);
  const startDevPreview = useAppsV2Store(s => s.startDevPreview);

  const [historyAnchor, setHistoryAnchor] = useState<null | HTMLElement>(null);

  useEffect(() => {
    if (!workspaceId) return;
    if (!app) void fetchApps(workspaceId);
    void fetchFiles(workspaceId, appId);
    void fetchStatus(workspaceId, appId);
    void fetchBranches(workspaceId, appId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, appId]);

  const changeCount = status?.changes.length ?? 0;

  // Same "prefer the active chat's branch" logic as the sidebar's Version
  // control section: if the conversation you're currently chatting in has
  // already committed work on this app, Build & preview should build THAT
  // branch — your own separate worktree always starts on main, so building
  // it while a chat is actively working here silently renders stale content.
  const activeChatId = useRealtimeStore(s => s.activeChatId);
  const activeChatBranch = (branches ?? []).find(
    b => b.name === `chat/${activeChatId}`,
  );

  const handleDiscard = useCallback(() => {
    if (!workspaceId) return;
    if (!window.confirm("Discard ALL uncommitted changes in this app?")) return;
    void discard(workspaceId, appId);
  }, [workspaceId, appId, discard]);

  if (!workspaceId) return null;

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Toolbar */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1,
          py: 0.5,
          borderBottom: "1px solid",
          borderColor: "divider",
          flexWrap: "wrap",
        }}
      >
        <Typography variant="subtitle2" noWrap sx={{ maxWidth: 240 }}>
          {app?.title ?? "App"}
        </Typography>
        {preview?.mode === "dev" && preview.url && (
          <Chip
            label="live · HMR"
            size="small"
            color="success"
            variant="outlined"
          />
        )}
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Live preview: keeps the app running in its sandbox so your edits show up instantly, with no rebuild step.">
          <span>
            <Button
              size="small"
              variant={preview?.mode === "dev" ? "outlined" : "contained"}
              startIcon={
                preview?.building ? (
                  <CircularProgress size={14} color="inherit" />
                ) : (
                  <PlayIcon size={14} />
                )
              }
              disabled={preview?.building}
              onClick={() =>
                void startDevPreview(
                  workspaceId,
                  appId,
                  activeChatBranch ? (activeChatId ?? undefined) : undefined,
                )
              }
            >
              {preview?.building
                ? "Starting..."
                : activeChatBranch
                  ? "Start dev session (active chat)"
                  : "Start dev session"}
            </Button>
          </span>
        </Tooltip>
        <Tooltip
          title={
            activeChatBranch
              ? `One-shot npm install + npm run build in the sandbox — builds ${activeChatBranch.name} (your active chat's branch), then previews the static output`
              : "One-shot npm install + npm run build in the sandbox, then preview the built app"
          }
        >
          <span>
            <Button
              size="small"
              variant={preview?.mode === "dev" ? "text" : "outlined"}
              disabled={preview?.building}
              onClick={() =>
                void buildPreview(
                  workspaceId,
                  appId,
                  activeChatBranch ? (activeChatId ?? undefined) : undefined,
                )
              }
            >
              Build & preview
            </Button>
          </span>
        </Tooltip>
        <Tooltip title="History (main)">
          <IconButton
            size="small"
            onClick={e => {
              setHistoryAnchor(e.currentTarget);
              void fetchHistory(workspaceId, appId);
            }}
          >
            <HistoryIcon size={16} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Discard all uncommitted changes">
          <span>
            <IconButton
              size="small"
              disabled={changeCount === 0}
              onClick={handleDiscard}
            >
              <DiscardIcon size={16} />
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      {preview?.error && (
        <Alert
          severity="error"
          onClose={() => {
            useAppsV2Store.setState(s => {
              const p = s.previewByApp[appId];
              if (p) p.error = null;
            });
          }}
          sx={{
            borderRadius: 0,
            whiteSpace: "pre-wrap",
            maxHeight: 160,
            overflow: "auto",
          }}
        >
          {preview.error}
        </Alert>
      )}

      {/* Preview / getting started */}
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {preview?.url ? (
          <iframe
            title="App preview"
            src={preview.url}
            // The two preview tiers need DIFFERENT sandboxes.
            //
            // Static builds are served by Mako from Mako's own origin, so
            // `allow-same-origin` would hand app code our origin and let it
            // escape the sandbox entirely — it stays off, and the opaque
            // origin is why those assets are served with `Access-Control-
            // Allow-Origin: *`.
            //
            // The live dev server (§12.4) is a genuinely foreign origin
            // (`<port>-<sandbox>.e2b.app`), so `allow-same-origin` grants it
            // only ITS OWN origin, never ours. It is required there: with an
            // opaque origin, Vite's HMR socket and its cross-origin module
            // scripts do not work.
            sandbox={
              preview.mode === "dev"
                ? "allow-scripts allow-forms allow-same-origin"
                : "allow-scripts allow-forms"
            }
            style={{ border: 0, width: "100%", height: "100%" }}
          />
        ) : (
          <Box sx={{ p: 3, maxWidth: 560 }}>
            <Typography variant="subtitle1" gutterBottom>
              {app?.title ?? "App"}
            </Typography>
            <Typography variant="body2" color="text.secondary" paragraph>
              Browse and edit this app&apos;s files from the Apps v2 explorer on
              the left — every file opens in its own tab. Ask the agent in chat
              to build features (each conversation works on its own git branch
              and commits every turn), or use the terminal below.
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Click <strong>Build &amp; preview</strong> to compile the app in
              its sandbox and render it here.
            </Typography>
          </Box>
        )}
      </Box>

      <Divider />

      {/* Terminal */}
      <Box sx={{ height: 200, flexShrink: 0 }}>
        <TerminalPanel appId={appId} workspaceId={workspaceId} />
      </Box>

      {/* History menu */}
      <Menu
        anchorEl={historyAnchor}
        open={Boolean(historyAnchor)}
        onClose={() => setHistoryAnchor(null)}
      >
        {(history ?? []).length === 0 && (
          <MenuItem disabled>No commits yet</MenuItem>
        )}
        {(history ?? []).map(c => (
          <MenuItem key={c.oid} disabled sx={{ opacity: 1 }}>
            <ListItemText
              primary={c.subject}
              secondary={`${c.oid.slice(0, 8)} · ${c.author} · ${new Date(c.timestamp).toLocaleString()}`}
            />
          </MenuItem>
        ))}
      </Menu>
    </Box>
  );
}
