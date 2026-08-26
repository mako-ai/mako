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
  IconButton,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
  styled,
  useTheme,
} from "@mui/material";
import {
  History as HistoryIcon,
  Play as PlayIcon,
  RotateCcw as DiscardIcon,
  Plus as PlusIcon,
  TerminalSquare as TerminalIcon,
} from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useWorkspace } from "../contexts/workspace-context";
import { useRealtimeStore } from "../store/realtimeStore";
import { useAppsV2Store } from "../store/appsV2Store";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { setIframeDragGuard } from "../lib/iframe-drag-guard";
import { TerminalTypeAhead } from "../lib/terminal-type-ahead";

// ---------------------------------------------------------------------------
// Terminal panel
// ---------------------------------------------------------------------------

/**
 * The divider between the preview and the terminal.
 *
 * Same 4px as the side handles in App.tsx rather than a hand-picked height, so
 * the three dividers on screen are actually the same thickness — they were not
 * before, and it showed.
 */
const TerminalResizeHandle = styled(PanelResizeHandle)(({ theme }) => ({
  flex: "0 0 4px",
  height: "4px",
  alignSelf: "stretch",
  background: theme.palette.divider,
  touchAction: "none",
  transition: "background-color 0.2s ease",
  // The library reports hover/drag through this attribute; its hit area is
  // larger than the visible strip, so the highlight has to key off it rather
  // than off CSS :hover.
  "&[data-resize-handle-state='hover'], &[data-resize-handle-state='drag']": {
    backgroundColor: theme.palette.primary.main,
  },
}));

function TerminalPanel({
  appId,
  workspaceId,
  termId,
}: {
  appId: string;
  workspaceId: string;
  /** Which shell tab this is — each id is its own PTY in the same sandbox. */
  termId: string;
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
      // Holds the tmux history prefill (TMUX_HISTORY_LINES server-side)
      // plus a session's worth of new output — xterm.js is the ONLY
      // scrolling layer now; tmux just keeps the session alive.
      scrollback: 8000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Predictive local echo (Mosh / VS Code "local echo"): typed characters
    // render immediately instead of after the ~175ms sandbox round trip;
    // the real echo is matched and consumed, mismatches roll back. See
    // lib/terminal-type-ahead.ts for the safety rules.
    const typeAhead = termId.startsWith("dev-")
      ? null
      : new TerminalTypeAhead(term);
    term.open(host);
    // Debug handle: lets devtools reach the live instance (buffer state,
    // options) — xterm exposes nothing on its DOM nodes.
    (host as HTMLElement & { __term?: Terminal }).__term = term;
    if (host.clientWidth && host.clientHeight) fit.fit();

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

      // Copy. xterm paints its own selection rather than making a DOM one, so
      // the browser sees nothing selected and ⌘C copies an empty string —
      // you can highlight text and still come away with nothing. The
      // selection has to be handed to the clipboard explicitly.
      //
      // ⌘C on macOS, ctrl-shift-C elsewhere. Plain ctrl-C is deliberately not
      // caught: in a terminal that is SIGINT, and taking it away to mean copy
      // would break the one keystroke people rely on most.
      const copyChord =
        event.key.toLowerCase() === "c" &&
        (event.metaKey || (event.ctrlKey && event.shiftKey));
      if (copyChord && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection());
        return false;
      }

      if (event.key === "Backspace" && (event.metaKey || event.altKey)) {
        // ⌘⌫ kills the line, ⌥⌫ kills the previous word.
        send(event.metaKey ? "\x15" : "\x17");
        return false;
      }
      return true;
    });

    let resizeRaf = 0;
    const sendResize = () => {
      // Coalesce to one refit per frame, and never fit a zero-size host: a
      // hidden pane (display:none session) measures 0x0, and fitting to it
      // corrupts cols/rows in a way the next real fit does not always fully
      // repair — which is how a terminal ended up drawing 24 rows in a
      // 700px pane after a drawer resize.
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        if (!host.clientWidth || !host.clientHeight) return;
        fit.fit();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: term.cols,
              rows: term.rows,
            }),
          );
        }
      });
    };

    const connect = () => {
      if (disposed) return;
      const url = new URL(
        `/api/workspaces/${workspaceId}/apps-v2/${appId}/terminal?term=${encodeURIComponent(termId)}`,
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
      const chunkDecoder = new TextDecoder();
      socket.onmessage = event => {
        if (typeof event.data === "string") {
          term.write(
            typeAhead ? typeAhead.onServerData(event.data) : event.data,
          );
          return;
        }
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        // Byte chunks only need decoding while predictions are pending —
        // the common case writes them through untouched.
        term.write(
          typeAhead?.hasPending()
            ? typeAhead.onServerData(
                chunkDecoder.decode(bytes, { stream: true }),
              )
            : bytes,
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

    const typed = term.onData(data => {
      typeAhead?.onUserData(data);
      send(data);
    });
    const observer = new ResizeObserver(() => sendResize());
    observer.observe(host);
    window.addEventListener("resize", sendResize);

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      window.removeEventListener("resize", sendResize);
      observer.disconnect();
      typed.dispose();
      typeAhead?.dispose();
      ws?.close();
      term.dispose();
    };
  }, [appId, workspaceId, termId, theme.palette.mode]);

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

/**
 * VS Code-shaped terminal area: a tab bar over N shells plus one read-only
 * "Dev server" tab that owns the vite output for good — it does not vanish
 * when the preview goes live, so "what did the dev server say" always has an
 * answer. Every shell tab is a real PTY of its own in the same sandbox;
 * closed tabs detach and the server reaps the idle shell.
 */
function TerminalTabs({
  appId,
  workspaceId,
}: {
  appId: string;
  workspaceId: string;
}) {
  // Shell tabs survive reloads: each tab is a PTY keyed by its id on the
  // server, and those sessions outlive the page — restoring the same ids
  // reattaches to the same running shells (scrollback and all), VS Code
  // style. Only the tab LIST is persisted; which tab is active is not worth
  // remembering.
  const [shells, setShells] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(`apps-v2-shells:${appId}`) ?? "[]",
      ) as unknown;
      if (
        Array.isArray(saved) &&
        saved.length > 0 &&
        saved.every(x => typeof x === "string" && /^[0-9]{1,6}$/.test(x))
      ) {
        return saved;
      }
    } catch {
      // Corrupt or unavailable storage — fall through to the default.
    }
    return ["1"];
  });
  const [active, setActive] = useState<string>("dev");
  const nextId = useRef(Math.max(0, ...shells.map(Number)) + 1);
  useEffect(() => {
    try {
      localStorage.setItem(`apps-v2-shells:${appId}`, JSON.stringify(shells));
    } catch {
      // Best effort.
    }
  }, [appId, shells]);

  const slug = useAppsV2Store(
    st => st.apps.find(a => a.id === appId)?.slug ?? null,
  );

  return (
    // VS Code's panel anatomy: the active session fills the area, and the
    // SESSION LIST is a slim vertical column on the right — the dev server
    // is simply the first session in it (server-side it runs in a tmux
    // session named mako-dev-<slug>, attachable from any shell), not a
    // special surface.
    <Box sx={{ height: "100%", display: "flex", minHeight: 0 }}>
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Every pane STAYS MOUNTED — an unmounted xterm is a dropped
            session and a re-scroll; hiding keeps the socket, the scrollback
            and the dev-log offset alive across switches. */}
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: active === "dev" ? "block" : "none",
          }}
        >
          {slug ? (
            // The dev server runs in a dtach session named like any other
            // (mako-term-dev-<slug>) — this is a normal terminal attached
            // to it: colors, native scrollback, prefit history, and Ctrl-C
            // reaches vite. When the session is down, the server side
            // shows a waiting notice, tails the boot recording live (npm
            // install progress), and attaches the moment it starts.
            <TerminalPanel
              appId={appId}
              workspaceId={workspaceId}
              termId={`dev-${slug}`}
            />
          ) : null}
        </Box>
        {shells.map(id => (
          <Box
            key={id}
            sx={{
              flex: 1,
              minHeight: 0,
              display: active === id ? "block" : "none",
            }}
          >
            <TerminalPanel
              appId={appId}
              workspaceId={workspaceId}
              termId={id}
            />
          </Box>
        ))}
      </Box>
      <Box
        sx={{
          width: 168,
          flexShrink: 0,
          borderLeft: "1px solid",
          borderColor: "divider",
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            pl: 1.25,
            pr: 0.25,
            py: 0.25,
          }}
        >
          <Typography
            variant="caption"
            sx={{
              flex: 1,
              fontSize: "0.66rem",
              fontWeight: 700,
              letterSpacing: 0.4,
              color: "text.secondary",
            }}
          >
            SESSIONS
          </Typography>
          <Tooltip title="New terminal — another real shell in the same sandbox">
            <IconButton
              size="small"
              onClick={() => {
                const id = String(nextId.current++);
                setShells(prev => [...prev, id]);
                setActive(id);
              }}
            >
              <PlusIcon size={13} strokeWidth={2} />
            </IconButton>
          </Tooltip>
        </Box>
        <SessionRow
          label={slug ? `dev: ${slug}` : "dev server"}
          selected={active === "dev"}
          onSelect={() => setActive("dev")}
        />
        {shells.map((id, index) => (
          <SessionRow
            key={id}
            label={`bash ${index + 1}`}
            selected={active === id}
            onSelect={() => setActive(id)}
            onClose={
              shells.length > 1
                ? () => {
                    setShells(prev => {
                      const next = prev.filter(x => x !== id);
                      if (active === id) setActive(next[0] ?? "dev");
                      return next;
                    });
                  }
                : undefined
            }
          />
        ))}
      </Box>
    </Box>
  );
}

/** One row of the VS Code-style session list beside the terminal. */
function SessionRow({
  label,
  selected,
  onSelect,
  onClose,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  onClose?: () => void;
}) {
  return (
    <Box
      onClick={onSelect}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 0.75,
        pl: 1.25,
        pr: 0.5,
        py: 0.4,
        cursor: "pointer",
        bgcolor: selected ? "action.selected" : "transparent",
        "&:hover": { bgcolor: selected ? "action.selected" : "action.hover" },
        "&:hover .a2-session-close": { opacity: 0.7 },
      }}
    >
      <TerminalIcon size={13} strokeWidth={1.75} />
      <Typography
        variant="caption"
        sx={{
          flex: 1,
          fontSize: 11.5,
          fontWeight: selected ? 650 : 400,
          color: selected ? "text.primary" : "text.secondary",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </Typography>
      {onClose && (
        <Box
          component="span"
          className="a2-session-close"
          onClick={e => {
            e.stopPropagation();
            onClose();
          }}
          sx={{ fontSize: 12, opacity: 0, "&:hover": { opacity: 1 } }}
        >
          ×
        </Box>
      )}
    </Box>
  );
}

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

  // The terminal split is a PanelGroup, like every other pane in the app.
  //
  // It used to be a hand-rolled mousemove drag, which froze the moment the
  // cursor crossed the preview iframe: a cross-origin frame swallows
  // pointermove, so the parent window stops hearing about the drag. Drag
  // slowly and you stay on the handle and it works; drag fast and it hangs.
  // `setIframeDragGuard` is the fix the rest of the app already uses — it
  // makes every iframe transparent to pointer events for the duration — and
  // using the same library also means this handle is the same size as the
  // others rather than a hand-picked 5px.
  const editing = useAppsV2Store(s => s.editingByApp[appId] ?? false);
  const setEditing = useAppsV2Store(s => s.setEditing);
  const viewUrl = useAppsV2Store(s => s.viewUrlByApp[appId]);
  const fetchViewUrl = useAppsV2Store(s => s.fetchViewUrl);

  // Dev mode survives reloads: the flag is client-side but the sandbox and
  // dev server outlive the page, so re-enter the workbench instead of
  // dumping the user back to the viewing pane. startDevPreview reattaches
  // to the running server (or restarts it) rather than double-starting.
  useEffect(() => {
    let persisted = false;
    try {
      persisted = localStorage.getItem(`apps-v2-editing:${appId}`) === "1";
    } catch {
      // Storage unavailable — nothing to restore.
    }
    if (persisted && !editing && workspaceId) {
      setEditing(workspaceId, appId, true);
      void useAppsV2Store.getState().startDevPreview(workspaceId, appId);
    }
    // Run once per app open; `editing` is deliberately not a dependency —
    // exiting dev mode clears the flag, and re-entering here would fight it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, workspaceId]);

  // The consumer view's token is short-lived, so it is fetched when this app
  // is opened for viewing and again whenever a publish moves the app on.
  useEffect(() => {
    if (!editing && app?.publishedSha && workspaceId) {
      void fetchViewUrl(workspaceId, appId);
    }
  }, [editing, app?.publishedSha, workspaceId, appId, fetchViewUrl]);
  const [terminalDragging, setTerminalDragging] = useState(false);
  useEffect(() => {
    if (!terminalDragging) return;
    setIframeDragGuard(true);
    return () => setIframeDragGuard(false);
  }, [terminalDragging]);

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

  // Repo-wide, deliberately: one worktree serves every app in the monorepo, so
  // Discard throws away the repo-wide set and a branch switch has to get past
  // it. Gating this on the app's own slice disabled the only escape hatch
  // exactly when the blocking file belonged to a different app.
  const changeCount = status?.repoChanges.length ?? 0;

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
    const names = (status?.repoChanges ?? []).map(c => c.path);
    const confirmed = window.confirm(
      `Discard ALL uncommitted changes in this repository?\n\n${names.join("\n")}`,
    );
    if (!confirmed) return;
    void discard(workspaceId, appId);
  }, [workspaceId, appId, discard, status]);

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
        {editing && (
          <Tooltip title="Back to viewing — the sandbox keeps running; the terminal and preview just leave the screen.">
            <Button
              size="small"
              variant="text"
              onClick={() => setEditing(workspaceId, appId, false)}
            >
              Exit dev mode
            </Button>
          </Tooltip>
        )}
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
              onClick={() => {
                // A dev session IS dev mode: without entering it, the live
                // preview would run behind the published view, invisible.
                setEditing(workspaceId, appId, true);
                void startDevPreview(workspaceId, appId);
              }}
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
              onClick={() => void publishApp(workspaceId, appId)}
            >
              {preview?.building ? "Working..." : "Publish"}
            </Button>
          </span>
        </Tooltip>
        <Tooltip title={`History (${status?.branch ?? "main"})`}>
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
        <Tooltip title="Discard all uncommitted changes in the repository">
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

      {/* Preview / getting started, over the terminal */}
      {/* Two modes, two layouts. VIEWING is for consuming: the published
          build (or an honest "never deployed" disclaimer) fills the pane and
          there is NO terminal — a shell is a workbench tool, and mounting one
          under an app you are merely looking at both wastes the space and
          suggests the machine is part of viewing. DEV MODE is the workbench:
          preview on top, terminal below. */}
      {!editing ? (
        <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
          {viewUrl ? (
            // Consumer view: the PUBLISHED app, which is what everyone who is
            // not working on it should see. It comes from the deployment
            // store, so opening someone's app costs a static file read and
            // starts no machine — the same reason a hundred viewers can open
            // one app without a hundred microVMs.
            //
            // No allow-same-origin: this is served from Mako's own origin, so
            // granting it would hand app code our origin and let it out of
            // the sandbox entirely.
            <iframe
              title={`${app?.title ?? "App"} (published)`}
              src={viewUrl}
              sandbox="allow-scripts allow-forms"
              style={{ border: 0, width: "100%", height: "100%" }}
            />
          ) : (
            // Never deployed: say so plainly, and make the one meaningful
            // next action the obvious thing on the page.
            <Box
              sx={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 2,
                p: 4,
                textAlign: "center",
              }}
            >
              <Typography variant="h6">{app?.title ?? "App"}</Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ maxWidth: 440 }}
              >
                This app has never been built and deployed, so there is nothing
                to view yet. Launch dev mode to work on it — a real sandbox with
                a live preview and a terminal — then publish when it is ready
                for everyone else.
              </Typography>
              <Button
                variant="contained"
                size="large"
                startIcon={<TerminalIcon size={18} />}
                onClick={() => {
                  setEditing(workspaceId, appId, true);
                  void startDevPreview(workspaceId, appId);
                }}
              >
                Launch dev mode
              </Button>
            </Box>
          )}
        </Box>
      ) : (
        <PanelGroup
          direction="vertical"
          // Remembers the split per browser, so a terminal you sized stays
          // sized — one you have to re-drag every visit is one you stop
          // using.
          autoSaveId="apps-v2:workspace-vertical"
          style={{ flex: 1, minHeight: 0 }}
        >
          <Panel defaultSize={70} minSize={20}>
            {preview?.building ? (
              <Box
                sx={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 1.5,
                  color: "text.secondary",
                }}
              >
                <CircularProgress size={22} />
                <Typography variant="body2">
                  Dev server starting — its output is live in the{" "}
                  <strong>Dev server</strong> terminal tab below.
                </Typography>
              </Box>
            ) : preview?.url ? (
              <iframe
                title="App preview"
                src={preview.url}
                // The two preview tiers need DIFFERENT sandboxes.
                //
                // Static builds are served by Mako from Mako's own origin, so
                // `allow-same-origin` would hand app code our origin and let
                // it escape the sandbox entirely — it stays off, and the
                // opaque origin is why those assets are served with
                // `Access-Control-Allow-Origin: *`.
                //
                // The live dev server (§12.4) is a genuinely foreign origin
                // (`<port>-<sandbox>.e2b.app`), so `allow-same-origin` grants
                // it only ITS OWN origin, never ours. It is required there:
                // with an opaque origin, Vite's HMR socket and its
                // cross-origin module scripts do not work.
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
                  Browse and edit this app&apos;s files from the Apps v2
                  explorer on the left — every file opens in its own tab. Ask
                  the agent in chat to build features (it works on your branch
                  and commits every turn), or use the terminal below — it is a
                  real machine with a real git checkout.
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  <strong>Start dev session</strong> runs the app live, so edits
                  show up as you make them. <strong>Publish</strong> builds it
                  and deploys — that is the version everyone else sees. A failed
                  build publishes nothing and leaves the current version
                  untouched.
                </Typography>
              </Box>
            )}
          </Panel>

          <TerminalResizeHandle onDragging={setTerminalDragging} />

          <Panel defaultSize={30} minSize={8} collapsible collapsedSize={0}>
            <TerminalTabs appId={appId} workspaceId={workspaceId} />
          </Panel>
        </PanelGroup>
      )}

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
