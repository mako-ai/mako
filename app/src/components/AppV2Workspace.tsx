/**
 * Apps v2 workspace view — the content of an `app-v2` tab: the app's home.
 *
 * Files are browsed/opened from the Apps v2 explorer (each file gets its own
 * `app-v2-file` tab, v1-style); this view owns everything app-level:
 *
 *   ┌ toolbar: dev session · Publish · History · Discard
 *   ├ preview: token-gated sandboxed iframe of the built app
 *   └ terminal: shell into the app's sandbox session (E2B microVM)
 *
 * Branch status, commit, and merge live in the Apps v2 explorer's "Version
 * control" section (sidebar), not here — same split as Transforms.
 *
 * Every read resolves from git through the durable worktree API, so the view
 * renders identically whether the sandbox is hot, paused, or dead.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import {
  History as HistoryIcon,
  Play as PlayIcon,
  RotateCcw as DiscardIcon,
  TerminalSquare as TerminalIcon,
} from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useWorkspace } from "../contexts/workspace-context";
import { useRealtimeStore } from "../store/realtimeStore";
import { useAppsV2Store } from "../store/appsV2Store";

// ---------------------------------------------------------------------------
// Terminal panel
// ---------------------------------------------------------------------------

function TerminalPanel({
  appId,
  workspaceId,
}: {
  appId: string;
  workspaceId: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "reconnecting">(
    "connecting",
  );
  const theme = useTheme();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", monospace',
      fontSize: 12,
      cursorBlink: true,
      // Match the app's theme so the terminal does not look bolted on.
      theme:
        theme.palette.mode === "dark"
          ? { background: "#0b0b0d", foreground: "#e6e6e6" }
          : { background: "#ffffff", foreground: "#1a1a1a", cursor: "#1a1a1a" },
      // Enough history to scroll back through a build.
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let ws: WebSocket | null = null;
    let attempt = 0;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const send = (data: string) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    };

    // macOS line editing. xterm sends a bare backspace for these, so
    // ⌘⌫ and ⌥⌫ silently deleted one character — the shell already
    // understands the readline codes, they just never reached it.
    term.attachCustomKeyEventHandler(event => {
      if (event.type !== "keydown") return true;
      if (event.key === "Backspace" && (event.metaKey || event.altKey)) {
        // ⌘⌫ kills the line, ⌥⌫ kills the previous word.
        send(event.metaKey ? "\x15" : "\x17");
        return false;
      }
      return true;
    });

    const sendResize = () => {
      fit.fit();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
        );
      }
    };

    const connect = () => {
      if (disposed) return;
      const url = new URL(
        `/api/workspaces/${workspaceId}/apps-v2/${appId}/terminal`,
        window.location.origin,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      ws = socket;
      setStatus(attempt === 0 ? "connecting" : "reconnecting");

      socket.onopen = () => {
        attempt = 0;
        setStatus("open");
        sendResize();
      };
      socket.onmessage = event => {
        term.write(
          typeof event.data === "string"
            ? event.data
            : new Uint8Array(event.data as ArrayBuffer),
        );
      };
      socket.onclose = () => {
        if (disposed) return;
        // The shell keeps running server-side, so reconnecting picks the
        // session back up — including the output missed while away. Back off
        // so a server that is down does not get hammered.
        setStatus("reconnecting");
        const delay = Math.min(1000 * 2 ** attempt, 15000);
        attempt += 1;
        retry = setTimeout(connect, delay);
      };
      socket.onerror = () => socket.close();
    };
    connect();

    const typed = term.onData(send);
    const observer = new ResizeObserver(() => sendResize());
    observer.observe(host);

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      observer.disconnect();
      typed.dispose();
      ws?.close();
      term.dispose();
    };
  }, [appId, workspaceId, theme.palette.mode]);

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        bgcolor: theme.palette.mode === "dark" ? "#0b0b0d" : "#ffffff",
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
          flexShrink: 0,
        }}
      >
        <TerminalIcon size={14} />
        <Typography variant="caption" sx={{ flex: 1 }}>
          Terminal — a real shell in the app&apos;s sandbox
        </Typography>
        <Typography
          variant="caption"
          color={
            status === "open"
              ? "success.main"
              : status === "connecting"
                ? "text.secondary"
                : "warning.main"
          }
        >
          {status}
        </Typography>
      </Box>
      <Box ref={hostRef} sx={{ flex: 1, minHeight: 0, p: 0.5 }} />
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
  /** A live `vite dev` session is running for this app right now. */
  const devSessionLive = preview?.mode === "dev" && Boolean(preview?.url);
  const publishedSha = app?.publishedSha;
  const publishApp = useAppsV2Store(s => s.publishApp);

  // Resizable terminal. Persisted per browser so the pane you sized stays
  // sized — a terminal you have to re-drag every visit is one you stop using.
  const [terminalHeight, setTerminalHeight] = useState(() => {
    const saved = Number(localStorage.getItem("apps-v2:terminal-height"));
    return Number.isFinite(saved) && saved >= 80 ? saved : 200;
  });
  const [resizing, setResizing] = useState(false);
  const resizeRef = useRef<{ y: number; h: number } | null>(null);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizeRef.current = { y: e.clientY, h: terminalHeight };
      setResizing(true);
    },
    [terminalHeight],
  );

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const start = resizeRef.current;
      if (!start) return;
      // Dragging up grows the terminal, so the delta is inverted. Clamped so
      // it can never swallow the preview or vanish entirely.
      const next = Math.min(
        Math.max(start.h + (start.y - e.clientY), 80),
        Math.max(160, window.innerHeight - 260),
      );
      setTerminalHeight(next);
    };
    const onUp = () => {
      setResizing(false);
      localStorage.setItem("apps-v2:terminal-height", String(terminalHeight));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizing, terminalHeight]);

  const fetchApps = useAppsV2Store(s => s.fetchApps);
  const fetchFiles = useAppsV2Store(s => s.fetchFiles);
  const fetchStatus = useAppsV2Store(s => s.fetchStatus);
  const fetchHistory = useAppsV2Store(s => s.fetchHistory);
  const fetchBranches = useAppsV2Store(s => s.fetchBranches);
  const discard = useAppsV2Store(s => s.discard);
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
  // already committed work on this app, Preview build should build THAT
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
        <Tooltip
          title={
            publishedSha
              ? `Deployed from commit ${publishedSha.slice(0, 7)} — this is what everyone else sees.`
              : "Nobody can see this app yet. Publish deploys it from main."
          }
        >
          <Chip
            label={
              publishedSha
                ? `published · ${publishedSha.slice(0, 7)}`
                : "not published"
            }
            size="small"
            color={publishedSha ? "default" : "warning"}
            variant="outlined"
          />
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        <Tooltip
          title={
            devSessionLive
              ? "A dev session is already running — restart it if the sandbox got into a bad state."
              : "Live preview: keeps the app running in its sandbox so your edits show up instantly, with no rebuild step."
          }
        >
          <span>
            <Button
              size="small"
              variant="outlined"
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
              {/* The label has to render STATE, not a fixed verb. It
                  previously read "Start dev session" while a session was
                  already running, changing only its variant — which is how a
                  running session looked identical to a stopped one. */}
              {preview?.building
                ? "Starting..."
                : devSessionLive
                  ? "Restart dev session"
                  : activeChatBranch
                    ? "Start dev session (active chat)"
                    : "Start dev session"}
            </Button>
          </span>
        </Tooltip>
        <Tooltip
          title={
            activeChatBranch
              ? `Publish: merge ${activeChatBranch.name} into main, build from main, and deploy. Everyone sees the result; rolling back is instant.`
              : "Publish: build from main and deploy. Everyone sees the result; rolling back is instant."
          }
        >
          <span>
            <Button
              size="small"
              variant="contained"
              color="primary"
              disabled={preview?.building}
              onClick={() =>
                void publishApp(
                  workspaceId,
                  appId,
                  activeChatBranch ? (activeChatId ?? undefined) : undefined,
                )
              }
            >
              {preview?.building ? "Working..." : "Publish"}
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
              <strong>Start dev session</strong> runs the app live, so edits
              show up as you make them. <strong>Publish</strong> builds it and
              deploys — that is the version everyone else sees. A failed build
              publishes nothing and leaves the current version untouched.
            </Typography>
          </Box>
        )}
      </Box>

      <Divider />

      {/* Terminal */}
      <Box
        onMouseDown={startResize}
        sx={{
          height: 5,
          flexShrink: 0,
          cursor: "row-resize",
          bgcolor: resizing ? "primary.main" : "divider",
          transition: resizing ? "none" : "background-color 0.15s",
          "&:hover": { bgcolor: "primary.light" },
        }}
      />
      <Box sx={{ height: terminalHeight, flexShrink: 0, minHeight: 0 }}>
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
