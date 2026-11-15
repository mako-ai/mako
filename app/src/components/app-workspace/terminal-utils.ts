import { useEffect, useState } from "react";

const HIDDEN_PAUSE_MS = 10 * 60 * 1000;

/** Keys a phone keyboard does not have, as the bytes a pty expects. */
export const MOBILE_TERMINAL_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["Esc", "\x1b"],
  ["Tab", "\t"],
  ["^C", "\x03"],
  ["↑", "\x1b[A"],
  ["↓", "\x1b[B"],
  ["←", "\x1b[D"],
  ["→", "\x1b[C"],
  ["Ret", "\r"],
];

/**
 * True once this document has been hidden for HIDDEN_PAUSE_MS straight.
 * A tab left in the background holds its HMR iframe and pty websockets
 * open indefinitely; those sockets read as "someone is watching" to the
 * box's idle reaper AND as activity to E2B's 10-minute auto-pause — which
 * is how a dev box billed hours of idle time. Pausing unmounts the dev
 * preview and terminals (dtach keeps the sessions; they replay on return).
 */
export function useHiddenPause(): boolean {
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

/** xterm colours per palette mode (xterm needs concrete colour strings). */
export function xtermTheme(mode: "light" | "dark") {
  return mode === "dark"
    ? { background: "#0b0b0d", foreground: "#e6e6e6" }
    : { background: "#ffffff", foreground: "#1a1a1a", cursor: "#1a1a1a" };
}
