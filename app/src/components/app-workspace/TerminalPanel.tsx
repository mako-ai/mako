import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Box, Typography, useTheme } from "@mui/material";
import { TerminalSquare as TerminalIcon } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useAppsStore } from "../../store/appsStore";
import { TerminalTypeAhead } from "../../lib/terminal-type-ahead";
import { clickableProps } from "../../lib/a11y";
import { xtermTheme } from "./terminal-utils";

export function TerminalPanel({
  appId,
  workspaceId,
  termId,
  label,
  fresh = false,
  onSessionEnd,
  inputRef,
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
  /**
   * Receives the "write to the pty" function while the socket is up, so a
   * parent can inject keystrokes a phone keyboard has no key for (Esc,
   * arrows, ^C) — see the mobile key bar in TerminalTabs.
   */
  inputRef?: MutableRefObject<((data: string) => void) | null>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<
    "connecting" | "open" | "reconnecting" | "off"
  >("connecting");
  // Lets the "off" overlay's click FORCE a connect — the user action that is
  // allowed to boot a machine. Assigned inside the socket effect.
  const connectRef = useRef<((force?: boolean) => void) | null>(null);
  const theme = useTheme();
  const paletteMode = theme.palette.mode;
  // The live xterm instance, so a theme toggle restyles it in place instead
  // of tearing down the terminal and its WebSocket (the mode used to be a
  // dependency of the effect below, which reconnected every pty).
  const termRef = useRef<Terminal | null>(null);
  const paletteModeRef = useRef(paletteMode);
  paletteModeRef.current = paletteMode;

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = xtermTheme(paletteMode);
  }, [paletteMode]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", monospace',
      fontSize: 12,
      cursorBlink: true,
      // Match the app's theme so the terminal does not look bolted on.
      theme: xtermTheme(paletteModeRef.current),
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
    termRef.current = term;
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
    if (inputRef) inputRef.current = send;

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
      if (termRef.current === term) termRef.current = null;
      if (inputRef) inputRef.current = null;
    };
    // onSessionEnd deliberately not a dependency: it is stable in practice
    // and reconnecting the pty because a parent re-rendered would be worse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, workspaceId, termId, fresh]);

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
          // The only way to boot the terminal again: keyboard users must be
          // able to reach it too.
          {...clickableProps(() => {
            setStatus("connecting");
            connectRef.current?.(true);
          }, "The machine is off. Start it and reconnect")}
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
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            The machine is off.
          </Typography>
          <Typography
            variant="caption"
            sx={{
              color: "primary.main",
            }}
          >
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
