/**
 * Apps workspace view — the content of an `app` tab: the app's home.
 *
 * Files are browsed/opened from the Apps explorer (each file gets its own
 * `app-file` tab, v1-style); this view owns everything app-level:
 *
 *   ┌ toolbar: dev session · Publish · History · Discard
 *   ├ preview: token-gated sandboxed iframe of the built app
 *   └ terminal: shell into the app's sandbox session (E2B microVM)
 *
 * Branch status, commit, and merge live in the Apps explorer's "Version
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
  ExternalLink as ExternalLinkIcon,
  History as HistoryIcon,
  Play as PlayIcon,
  Plus as PlusIcon,
  RefreshCw as RefreshIcon,
  Square as StopIcon,
  TerminalSquare as TerminalIcon,
} from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useWorkspace } from "../contexts/workspace-context";
import { useRealtimeStore } from "../store/realtimeStore";
import { useAppsStore } from "../store/appsStore";
import { useConsoleStore } from "../store/consoleStore";
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
/** Vertical divider between the terminal panes and the sessions list. */
const SessionsResizeHandle = styled(PanelResizeHandle)(({ theme }) => ({
  flex: "0 0 4px",
  width: "4px",
  alignSelf: "stretch",
  background: theme.palette.divider,
  touchAction: "none",
  transition: "background-color 0.2s ease",
  "&[data-resize-handle-state='hover'], &[data-resize-handle-state='drag']": {
    backgroundColor: theme.palette.primary.main,
  },
}));

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

const HIDDEN_PAUSE_MS = 10 * 60 * 1000;

/**
 * True once this document has been hidden for HIDDEN_PAUSE_MS straight.
 * A tab left in the background holds its HMR iframe and pty websockets
 * open indefinitely; those sockets read as "someone is watching" to the
 * box's idle reaper AND as activity to E2B's 10-minute auto-pause — which
 * is how a dev box billed hours of idle time. Pausing unmounts the dev
 * preview and terminals (dtach keeps the sessions; they replay on return).
 */
function useHiddenPause(): boolean {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChange = () => {
      if (document.visibilityState === "hidden") {
        timer ??= setTimeout(() => setPaused(true), HIDDEN_PAUSE_MS);
      } else {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        setPaused(false);
      }
    };
    onChange();
    document.addEventListener("visibilitychange", onChange);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onChange);
    };
  }, []);
  return paused;
}

function TerminalPanel({
  appId,
  workspaceId,
  termId,
  label,
  fresh = false,
  onSessionEnd,
}: {
  appId: string;
  workspaceId: string;
  /** Which shell tab this is — each id is its own PTY in the same sandbox. */
  termId: string;
  /** Session name echoed in the header (e.g. "dev: my-app", "bash 2"). */
  label?: string;
  /** Tab created this pageview — no history exists, skip the replay probe. */
  fresh?: boolean;
  /** The session ended for good (`exit`, kill): close the tab, do not respawn. */
  onSessionEnd?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<
    "connecting" | "open" | "reconnecting" | "off"
  >("connecting");
  // Lets the "off" overlay's click FORCE a connect — the user action that is
  // allowed to boot a machine. Assigned inside the socket effect.
  const connectRef = useRef<((force?: boolean) => void) | null>(null);
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
    // Plain fit. The terminal is bottom-anchored (see the host's sx), so the
    // sub-row remainder lands at the top as a little blank space — exactly
    // what VS Code does. An earlier trick fitted one extra row and let it
    // overflow the top edge, which clipped real scrollback in half.
    const fitFlush = () => fit.fit();
    if (host.clientWidth && host.clientHeight) fitFlush();

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
        fitFlush();
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

    const connect = (force = false) => {
      if (disposed) return;
      // §13.9: the client never heals. ANY non-forced connect while box
      // truth says the machine is gone would run ensureBox server-side and
      // boot a fresh microVM nobody asked for — a recycle undone by a
      // background socket, or by the replacement tab a dead session spawns.
      // Render the honest "off" state instead; clicking it is the user
      // action that boots. A fresh page load has no boxStatus yet, so the
      // open-a-terminal-boots-the-box flow is unchanged.
      if (!force && useAppsStore.getState().boxStatus === "offline") {
        setStatus("off");
        return;
      }
      const url = new URL(
        `/api/workspaces/${workspaceId}/apps/${appId}/terminal?term=${encodeURIComponent(termId)}`,
        window.location.origin,
      );
      // The pty is born at this size instead of 80x24, so the first paint
      // (prompt, replayed history) is already at the real width.
      url.searchParams.set("cols", String(term.cols));
      url.searchParams.set("rows", String(term.rows));
      if (fresh) url.searchParams.set("fresh", "1");
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
      socket.onclose = event => {
        if (disposed) return;
        if (event.code === 4000) {
          // The session is OVER — the user typed `exit`, or the tab was
          // killed elsewhere. A real terminal closes; respawning a shell
          // nobody asked for was how `exit` produced a zombie reconnect.
          setStatus("connecting");
          onSessionEnd?.();
          return;
        }
        // The box is gone by BOX TRUTH (a recycle broadcast offline): do not
        // reconnect and do NOT end the session — a replacement tab's mount
        // would connect and re-create a sandbox. Show "off"; a click boots.
        if (useAppsStore.getState().boxStatus === "offline") {
          setStatus("off");
          return;
        }
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
    connectRef.current = connect;
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
    // onSessionEnd deliberately not a dependency: it is stable in practice
    // and reconnecting the pty because a parent re-rendered would be worse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, workspaceId, termId, fresh, theme.palette.mode]);

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        position: "relative",
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
          Terminal — {label ?? "a real shell in the app's sandbox"}
        </Typography>
        <Typography
          variant="caption"
          color={
            status === "open"
              ? "success.main"
              : status === "connecting" || status === "off"
                ? "text.secondary"
                : "warning.main"
          }
        >
          {status}
        </Typography>
      </Box>
      <Box
        ref={hostRef}
        // Padding goes on .xterm, NOT on this host: FitAddon subtracts the
        // terminal element's own padding when computing rows, and (with
        // border-box sizing) counts host padding zero times — padding here
        // pushed the last row and the scrollbar's end past the pane edge.
        sx={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          // Rows are whole cells (floor(height / cellHeight)), so up to one
          // cell of the pane is always left over. Anchor the terminal to the
          // BOTTOM like VS Code does: the remainder lands at the top, where
          // scrollback fills it, instead of reading as a fat bottom margin
          // under the prompt.
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          "& .xterm": { padding: "4px 4px 4px 6px" },
          // Stock xterm.css paints the (xterm 6: vestigial) viewport BLACK
          // and stretches it across the whole .xterm box — padding included —
          // while the themed screen sits inset by that padding. The result
          // was a black ring around the terminal. Transparent lets the host's
          // theme background (set above) show through everywhere the screen
          // does not cover, so padding and leftover space read as one
          // continuous surface.
          "& .xterm .xterm-viewport": {
            backgroundColor: "transparent !important",
          },
        }}
      />
      {status === "off" && (
        // The machine died under this shell (recycle, expiry). §13.9 forbids
        // silently booting another; this overlay is the explicit user action
        // that may.
        <Box
          onClick={() => {
            setStatus("connecting");
            connectRef.current?.(true);
          }}
          sx={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 0.5,
            cursor: "pointer",
            bgcolor: theme.palette.mode === "dark" ? "#0b0b0d" : "#ffffff",
          }}
        >
          <Typography variant="body2" color="text.secondary">
            The machine is off.
          </Typography>
          <Typography variant="caption" color="primary.main">
            Click to start it and open this shell
          </Typography>
        </Box>
      )}
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
  const hiddenPaused = useHiddenPause();
  const [shells, setShells] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(`apps-shells:${appId}`) ??
          // Pre-rename key, so open shells survive the upgrade.
          localStorage.getItem(`apps-v2-shells:${appId}`) ??
          "[]",
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
    // No free shell by default: starting dev opens exactly ONE terminal —
    // the dev process. Extra shells are a deliberate click on +.
    return [];
  });
  // The active session survives reloads like everything else about the
  // terminal area: sessions and their scrollback live server-side, so the
  // page coming back on a different tab than you were working in reads as
  // state loss even though nothing was lost.
  const [active, setActiveState] = useState<string>(() => {
    try {
      // Never auto-select the dev terminal: selecting it ATTACHES to (and
      // waits for) a dev server, which must not happen on mount just because
      // it was focused last time. Restore a saved BASH tab only; the dev tab
      // is entered by an explicit click (apps.md §13.11).
      const saved =
        localStorage.getItem(`apps-term-active:${appId}`) ??
        localStorage.getItem(`apps-v2-term-active:${appId}`);
      if (saved && /^[0-9]{1,6}$/.test(saved)) return saved;
    } catch {
      // Storage unavailable — default below.
    }
    return "1";
  });
  const setActive = useCallback(
    (id: string) => {
      setActiveState(id);
      try {
        localStorage.setItem(`apps-term-active:${appId}`, id);
      } catch {
        // Best effort.
      }
    },
    [appId],
  );
  // A persisted shell id whose tab was closed in another session falls back
  // to the dev window instead of pointing at nothing.
  useEffect(() => {
    if (active !== "dev" && !shells.includes(active)) {
      setActiveState(shells[0] ?? "dev");
    }
  }, [active, shells]);
  const nextId = useRef(Math.max(0, ...shells.map(Number)) + 1);
  // Ids born in this pageview — their sessions have no history to replay,
  // and telling the server so skips a probe round-trip on open.
  const freshIds = useRef<Set<string>>(new Set());
  const killTerminalSession = useAppsStore(st => st.killTerminalSession);
  const stopDev = useAppsStore(st => st.stopDev);
  // Box truth: sessions that exist server-side (pushed by the agent).
  const boxTerminals = useAppsStore(st => st.boxTerminals);
  // One path for both ways a shell dies: the x on its row (killRemote —
  // closing the tab kills the pty, the dtach session and the recording) and
  // the session ending on its own (`exit` — already dead, just drop the tab).
  const closeShell = useCallback(
    (id: string, opts: { killRemote: boolean }) => {
      if (opts.killRemote) {
        void killTerminalSession(workspaceId, appId, id);
      }
      // An empty shell list is fine now — the dev terminal is the floor.
      // (No id reuse either: a reused id kept the dead TerminalPanel's
      // React key, leaving a corpse stuck on "connecting".)
      setShells(prev => prev.filter(x => x !== id));
      setActiveState(current => (current === id ? "dev" : current));
    },
    [appId, workspaceId, killTerminalSession],
  );
  useEffect(() => {
    try {
      localStorage.setItem(`apps-shells:${appId}`, JSON.stringify(shells));
    } catch {
      // Best effort.
    }
  }, [appId, shells]);

  const slug = useAppsStore(
    st => st.apps.find(a => a.id === appId)?.slug ?? null,
  );
  // Box truth: is a dev server actually serving this app? The dev terminal
  // attaches to it only when it IS running or the user explicitly selects it —
  // never on mount for a stopped app, which used to spawn a "[waiting for the
  // dev server]" attach with nothing behind it (apps.md §13.11).
  const runningDevApps = useAppsStore(st => st.runningDevApps);
  const devRunning = slug ? runningDevApps.includes(slug) : false;

  return (
    // VS Code's panel anatomy: the active session fills the area, and the
    // SESSION LIST is a slim vertical column on the right — the dev server
    // is simply the first session in it (server-side it runs in a tmux
    // session named mako-dev-<slug>, attachable from any shell), not a
    // special surface.
    <PanelGroup
      direction="horizontal"
      autoSaveId="apps-terminal-sessions"
      style={{ height: "100%" }}
    >
      <Panel minSize={40}>
        <Box
          sx={{
            height: "100%",
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
            {!hiddenPaused && slug && (devRunning || active === "dev") ? (
              // The dev server runs in a dtach session named like any other
              // (mako-term-dev-<slug>) — this is a normal terminal attached
              // to it: colors, native scrollback, prefit history, and Ctrl-C
              // reaches vite. Mounted only when a server is actually running
              // (box truth) or the user selected this tab — never on mount for
              // a stopped app, which would attach a waiter to nothing.
              <TerminalPanel
                appId={appId}
                workspaceId={workspaceId}
                termId={`dev-${slug}`}
                label={`dev: ${slug}`}
              />
            ) : null}
          </Box>
          {!hiddenPaused &&
            shells.map((id, index) => (
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
                  label={`bash ${index + 1}`}
                  fresh={freshIds.current.has(id)}
                  onSessionEnd={() => closeShell(id, { killRemote: false })}
                />
              </Box>
            ))}
        </Box>
      </Panel>
      <SessionsResizeHandle />
      <Panel defaultSize={14} minSize={7} maxSize={40}>
        <Box
          sx={{
            height: "100%",
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
                  // Never mint an id the BOX already has a session for:
                  // with a detached ghost "1" on screen, + used to create
                  // id 1 — silently adopting the old shell (cwd, state)
                  // while presenting it as fresh. Skip every id in use,
                  // client-side or box-side.
                  const used = new Set([
                    ...shells,
                    ...boxTerminals.filter(t => /^[0-9]+$/.test(t)),
                  ]);
                  let n = nextId.current;
                  while (used.has(String(n))) n += 1;
                  nextId.current = n + 1;
                  const id = String(n);
                  freshIds.current.add(id);
                  setShells(prev => [...prev, id]);
                  setActive(id);
                }}
              >
                <PlusIcon size={13} strokeWidth={2} />
              </IconButton>
            </Tooltip>
          </Box>
          <SessionRow
            label={
              slug
                ? `dev: ${slug}${devRunning ? "" : " · stopped"}`
                : "dev server"
            }
            selected={active === "dev"}
            onSelect={() => setActive("dev")}
            // Closing the dev session IS stopping dev mode — one mental
            // model, same as the toolbar's Stop dev.
            onClose={
              devRunning ? () => void stopDev(workspaceId, appId) : undefined
            }
          />
          {shells.map((id, index) => (
            <SessionRow
              key={id}
              label={`bash ${index + 1}`}
              selected={active === id}
              onSelect={() => setActive(id)}
              onClose={() => closeShell(id, { killRemote: true })}
            />
          ))}
          {/* GHOST sessions: shells that exist in the box (pushed truth)
              but have no tab here — opened by the agent, another browser,
              or a previous pageview. One click attaches, history and all;
              invisible sessions were how people collided with them. */}
          {boxTerminals
            .filter(id => /^[0-9]+$/.test(id) && !shells.includes(id))
            .map(id => (
              <SessionRow
                key={`ghost-${id}`}
                label={`bash · detached (${id})`}
                selected={false}
                onSelect={() => {
                  setShells(prev => (prev.includes(id) ? prev : [...prev, id]));
                  setActive(id);
                }}
              />
            ))}
        </Box>
      </Panel>
    </PanelGroup>
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

/** Streams the dev boot log (npm install → vite) while a server starts. */
function DevBootLog({
  workspaceId,
  appId,
}: {
  workspaceId: string;
  appId: string;
}) {
  const fetchDevLog = useAppsStore(s => s.fetchDevLog);
  const [text, setText] = useState("");
  const offsetRef = useRef(0);
  useEffect(() => {
    let alive = true;
    offsetRef.current = 0;
    const ansi = new RegExp(
      String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]",
      "g",
    );
    const tick = async () => {
      const { size, chunk } = await fetchDevLog(
        workspaceId,
        appId,
        offsetRef.current,
      );
      if (!alive) return;
      offsetRef.current = size;
      if (chunk) {
        setText(t =>
          (t + chunk.replace(ansi, "").replace(/\r/g, "")).slice(-20000),
        );
      }
    };
    void tick();
    const iv = setInterval(() => void tick(), 1500);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [workspaceId, appId, fetchDevLog]);
  return <BuildLogPanel text={text} title="Dev server starting…" />;
}

/** Live build output during a publish — the streamed npm/vite log. */
function BuildLogPanel({
  text,
  title = "Building & publishing…",
}: {
  text: string;
  title?: string;
}) {
  const ref = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    // Follow the tail as the build streams.
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  // The build output carries ANSI color codes; strip them for a plain reader.
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        bgcolor: "#1e1e1e",
        color: "#d4d4d4",
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1.5,
          py: 1,
          borderBottom: "1px solid rgba(255,255,255,0.1)",
          flexShrink: 0,
        }}
      >
        <CircularProgress size={14} sx={{ color: "#d4d4d4" }} />
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
      </Box>
      <Box
        component="pre"
        ref={ref}
        sx={{
          flex: 1,
          m: 0,
          p: 1.5,
          overflow: "auto",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {clean || "Starting build…"}
      </Box>
    </Box>
  );
}

export default function AppWorkspace({
  tabId: _tabId,
  appId,
}: {
  tabId: string;
  appId: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const app = useAppsStore(s => s.apps.find(a => a.id === appId));
  const status = useAppsStore(s => s.statusByApp[appId]);
  const history = useAppsStore(s => s.historyByApp[appId]);
  const branches = useAppsStore(s => s.branchesByApp[appId]);
  const preview = useAppsStore(s => s.previewByApp[appId]);
  const publishedSha = app?.publishedSha;
  const publishApp = useAppsStore(s => s.publishApp);

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
  const editing = useAppsStore(s => s.editingByApp[appId] ?? false);
  const setEditing = useAppsStore(s => s.setEditing);
  const slug = useAppsStore(
    s => s.apps.find(a => a.id === appId)?.slug ?? null,
  );
  // THE source of truth for "is a dev server running for this app" — the box,
  // via the pushed runningDevApps (same signal as the sidebar's green dot).
  // Every "running" affordance derives from this, so they cannot disagree
  // (apps.md §13.11).
  const runningDevApps = useAppsStore(s => s.runningDevApps);
  const devRunning = slug ? runningDevApps.includes(slug) : false;
  const viewUrl = useAppsStore(s => s.viewUrlByApp[appId]);
  const hiddenPaused = useHiddenPause();
  // Durable, session-authorized URL for the published app — for normal tabs.
  // The token URL (viewUrl) exists ONLY for the sandboxed iframe, whose
  // opaque origin cannot send cookies; tokens are short-lived and in-memory,
  // so handing them to window.open produced "Preview expired" minutes later.
  const liveUrl =
    app?.publishedSha && workspaceId
      ? `/api/workspaces/${workspaceId}/apps/${appId}/live/`
      : undefined;
  const fetchViewUrl = useAppsStore(s => s.fetchViewUrl);

  // Derive the workbench view from BOX TRUTH, never localStorage. Auto-open
  // the workbench ONLY when a dev server is actually serving this app — a
  // read-only probe, no process started, no localStorage flag. The old
  // version restored an `apps-editing` flag from localStorage, which
  // auto-opened the workbench (and its terminals) over an empty box and
  // disagreed with the green dot — the exact multi-source drift §13.11 bans.
  // Editing a stopped app is a deliberate click now, not a restored side
  // effect.
  useEffect(() => {
    if (!workspaceId) return;
    void useAppsStore
      .getState()
      .checkDevStatus(workspaceId, appId)
      .then(() => {
        const p = useAppsStore.getState().previewByApp[appId];
        if (p?.mode === "dev" && p.url && !editing) {
          setEditing(workspaceId, appId, true);
        }
      });
    // Run once per app open; `editing` is deliberately not a dependency —
    // exiting dev mode clears it, and re-entering here would fight it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, workspaceId]);

  // The consumer view's token is short-lived, so it is fetched when this app
  // is opened for viewing and again whenever a publish moves the app on.
  useEffect(() => {
    if (!editing && app?.publishedSha && workspaceId) {
      void fetchViewUrl(workspaceId, appId);
    }
  }, [editing, app?.publishedSha, workspaceId, appId, fetchViewUrl]);
  // Older tabs were opened before slugs rode in tab metadata; heal them so
  // the URL upgrades from /apps/<id> to /apps/<slug>.
  useEffect(() => {
    const slug = app?.slug;
    if (!slug) return;
    useConsoleStore.setState(state => {
      const t = state.tabs[_tabId];
      if (t?.metadata && !t.metadata.appSlug) t.metadata.appSlug = slug;
    });
  }, [app?.slug, _tabId]);

  const [terminalDragging, setTerminalDragging] = useState(false);
  useEffect(() => {
    if (!terminalDragging) return;
    setIframeDragGuard(true);
    return () => setIframeDragGuard(false);
  }, [terminalDragging]);

  const checkDevStatus = useAppsStore(s => s.checkDevStatus);
  // The preview chip and iframe are CLIENT state; the server is the truth.
  // While a dev session is believed live, verify every 15s — Ctrl-C in the
  // dev terminal, a crash, or a recycled sandbox all flip the workbench to
  // the launch state within one beat instead of showing a stale "live".
  useEffect(() => {
    if (!workspaceId || !editing) return;
    // Immediately on entering the workbench: DISCOVER a server that is
    // already running (started elsewhere, or client state lost) instead of
    // asking the user to "start" it. Then keep verifying while editing —
    // the same probe notices Ctrl-C/crashes and flips the other way.
    void checkDevStatus(workspaceId, appId);
    const timer = setInterval(
      () => void checkDevStatus(workspaceId, appId),
      15_000,
    );
    return () => clearInterval(timer);
  }, [workspaceId, appId, editing, checkDevStatus]);

  const fetchApps = useAppsStore(s => s.fetchApps);
  const fetchFiles = useAppsStore(s => s.fetchFiles);
  const fetchStatus = useAppsStore(s => s.fetchStatus);
  const fetchHistory = useAppsStore(s => s.fetchHistory);
  const fetchBranches = useAppsStore(s => s.fetchBranches);
  const startDevPreview = useAppsStore(s => s.startDevPreview);
  const stopDev = useAppsStore(s => s.stopDev);

  const [historyAnchor, setHistoryAnchor] = useState<null | HTMLElement>(null);
  // Bumping this remounts the preview iframe — a plain page refresh.
  const [previewNonce, setPreviewNonce] = useState(0);

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
  // Same "prefer the active chat's branch" logic as the sidebar's Version
  // control section: if the conversation you're currently chatting in has
  // already committed work on this app, Preview build should build THAT
  // branch — your own separate worktree always starts on main, so building
  // it while a chat is actively working here silently renders stale content.
  const activeChatId = useRealtimeStore(s => s.activeChatId);
  const activeChatBranch = (branches ?? []).find(
    b => b.name === `chat/${activeChatId}`,
  );

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
        {devRunning && (
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
              ? `Deployed from commit ${publishedSha.slice(0, 7)} — click to open the live app.`
              : "Nobody can see this app yet. Click to publish it from main."
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
            // Dead chips become navigation: published → open the live app;
            // not published → this IS the call to action, publish.
            onClick={
              publishedSha
                ? liveUrl
                  ? () => window.open(liveUrl, "_blank", "noopener")
                  : undefined
                : preview?.building
                  ? undefined
                  : () => void publishApp(workspaceId, appId)
            }
          />
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        {/* ONE dev toggle in the query-runner's language: blue Play →
            "Start dev" when stopped, red Stop → "Stop dev" while running.
            Restart is gone — stop + start covers it, and agents restart
            through their own tools. */}
        <Tooltip
          title={
            devRunning
              ? "Stop the dev server. All terminal sessions die with it; the sandbox keeps running."
              : "Live preview: keeps the app running in its sandbox so your edits show up instantly, with no rebuild step."
          }
        >
          <span>
            <Button
              size="small"
              variant="contained"
              color={devRunning ? "error" : "primary"}
              startIcon={
                preview?.building ? (
                  <CircularProgress size={14} color="inherit" />
                ) : devRunning ? (
                  <StopIcon size={12} fill="currentColor" />
                ) : (
                  <PlayIcon size={14} />
                )
              }
              disabled={preview?.building}
              onClick={() => {
                if (devRunning) {
                  void stopDev(workspaceId, appId);
                } else {
                  setEditing(workspaceId, appId, true);
                  void startDevPreview(workspaceId, appId);
                }
              }}
            >
              {preview?.building
                ? "Starting..."
                : devRunning
                  ? "Stop dev"
                  : "Start dev"}
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
              variant="outlined"
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
        <Tooltip title="Open the preview in a new tab">
          <span>
            <IconButton
              size="small"
              aria-label="Open the preview in a new tab"
              disabled={!(editing ? preview?.url : liveUrl)}
              onClick={() => {
                const url = editing ? preview?.url : liveUrl;
                if (url) window.open(url, "_blank", "noopener");
              }}
            >
              <ExternalLinkIcon size={16} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Reload the app preview">
          <span>
            <IconButton
              size="small"
              aria-label="Reload the app preview"
              disabled={!(editing ? preview?.url : viewUrl)}
              onClick={() => setPreviewNonce(n => n + 1)}
            >
              <RefreshIcon size={16} />
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      {preview?.error && (
        <Alert
          severity="error"
          onClose={() => {
            useAppsStore.setState(s => {
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
              key={`pub-${previewNonce}`}
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
          autoSaveId="apps:workspace-vertical"
          style={{ flex: 1, minHeight: 0 }}
        >
          <Panel defaultSize={70} minSize={20}>
            {preview?.building && preview.publishing ? (
              <BuildLogPanel text={preview.buildOutput ?? ""} />
            ) : preview?.building ? (
              // A 60-second cold boot behind a bare spinner reads as frozen.
              // The boot writes a real log (npm install → vite); stream its
              // tail here so starting reads as PROGRESS.
              <DevBootLog workspaceId={workspaceId} appId={appId} />
            ) : preview?.mode === "dev" && preview.reachable === false ? (
              <Alert severity="warning" sx={{ m: 2 }}>
                A dev server for this app is running in the sandbox but rejects
                the preview host — it was started outside Mako without{" "}
                <code>server.allowedHosts</code> including{" "}
                <code>&quot;.e2b.app&quot;</code>. Use{" "}
                <strong>Restart dev session</strong> to let Mako run it, or add
                that host to the app&apos;s <code>vite.config</code>.
              </Alert>
            ) : hiddenPaused ? (
              <Alert severity="info" sx={{ m: 2 }}>
                Preview paused after 10 minutes in the background — its sockets
                are released so the sandbox can sleep. It resumes when you come
                back.
              </Alert>
            ) : preview?.url ? (
              <iframe
                key={`dev-${previewNonce}`}
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
                  Browse and edit this app&apos;s files from the Apps explorer
                  on the left — every file opens in its own tab. Ask the agent
                  in chat to build features (it works on your branch and commits
                  every turn), or use the terminal below — it is a real machine
                  with a real git checkout.
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
