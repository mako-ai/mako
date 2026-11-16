/**
 * Live terminals that outlive the socket watching them: the per-worktree
 * registry, scrollback, history replay on reattach, and killing sessions.
 */
import { type WebSocket } from "ws";
import { loggers } from "../../logging";
import { type IAppProject } from "../../database/workspace-schema";
import {
  type SandboxExecContext,
  getSandboxProvider,
  type SandboxTerminal,
} from "../sandbox/provider";
import { boxCtx, ensureWorktree, sessionKeyFor } from "../worktree.service";
import { noteBoxActivity } from "../box-activity";

const logger = loggers.api("apps-terminal");

/**
 * A shell that outlives the socket watching it.
 *
 * Closing a tab, a flaky network, or a laptop lid should not kill a running
 * build. The PTY therefore belongs to the WORKTREE, not to the WebSocket:
 * sockets attach and detach, the shell keeps running. This is the same shape
 * VS Code uses — a pty host that survives window reloads — including the part
 * that makes it feel seamless: a ring buffer of recent output, replayed on
 * reattach so a reconnecting client sees the screen it left rather than a
 * blank one.
 */
export interface LiveTerminal {
  terminal: SandboxTerminal;
  /**
   * Which machine the pty was created on (provider.describe at birth; null
   * until resolved or when the provider cannot say). onExit compares this
   * against the session's CURRENT machine to tell `exit` (same box, close
   * the tab) from the box dying under the shell (different or no box —
   * reconnect, so the tab heals onto the replacement machine).
   */
  bornOn?: string | null;
  /** Recent output, replayed to a client that reconnects. */
  scrollback: Buffer[];
  scrollbackBytes: number;
  sockets: Set<WebSocket>;
  /** Force any pending output out, e.g. before a client detaches. */
  flush: () => void;
  /** Set when the last socket leaves; cancelled if someone comes back. */
  reaper: NodeJS.Timeout | null;
  /**
   * The shell handed itself off to tmux. Replay is then WRONG, not just
   * redundant: the buffered output contains tmux's terminal queries (device
   * attributes, cursor position), and a reconnecting xterm re-answers every
   * one — the answers land at the shell prompt as junk keystrokes
   * ("0;276;0c", strings of R's). tmux repaints the screen itself; all a
   * returning client needs is one real resize to trigger it.
   */
  tmux: boolean;
  /** A client reattached; force a repaint via a size jiggle on next resize. */
  repaint: boolean;
  /** Exec context of the sandbox this pty lives in (for capture-pane). */
  ctx: SandboxExecContext | null;
  /** tmux session name, when the shell handed off to tmux (fallback). */
  tmuxSession: string | null;
  /**
   * Raw session recording inside the sandbox (script(1) under dtach) — the
   * reattach history source. When set, reattaches replay its tail instead
   * of the ring buffer or capture-pane.
   */
  histFile: string | null;
  /** Last size the client reported, for server-driven repaint jiggles. */
  lastCols: number;
  lastRows: number;
}

export const live = new Map<string, LiveTerminal>();

/**
 * Single-flight session creation. Two sockets for the same key race the
 * whole multi-second creation body (React StrictMode mounts twice, opening
 * two websockets) — without this, the second creation overwrote the first
 * in `live`, one pty leaked, and whichever ring the surviving session had
 * was the one clients replayed. Symptom: a dev window attached "open" but
 * blank while a fresh probe socket on the same termId got the full replay.
 */
export const creating = new Map<string, Promise<LiveTerminal>>();

/**
 * dtach+script availability per sandbox — capabilities do not change while
 * a sandbox lives, so one probe per box, not one per terminal open.
 */
export const dtachCapable = new Map<string, boolean>();

/** Forget per-box capability knowledge when the box is destroyed. */
export function forgetTerminalCaches(sessionKey: string): void {
  dtachCapable.delete(sessionKey);
}

/** Enough to redraw a screen and the tail of a build, not a whole session. */
const SCROLLBACK_LIMIT = 256 * 1024;

/** How long a shell keeps running with nobody attached. */
export const ORPHAN_GRACE_MS = 10 * 60 * 1000;

export function remember(session: LiveTerminal, chunk: Buffer): void {
  session.scrollback.push(chunk);
  session.scrollbackBytes += chunk.length;
  while (
    session.scrollbackBytes > SCROLLBACK_LIMIT &&
    session.scrollback.length > 1
  ) {
    session.scrollbackBytes -= session.scrollback.shift()!.length;
  }
}

const CTRL_C = 0x03;

/**
 * Forward client input to the shell, handling ctrl-C as a real tty would.
 *
 * Two problems, one cause — input is written to the sandbox in order, and a
 * large paste is a lot of input:
 *
 *   - ctrl-C typed during a paste queued behind the rest of it, so
 *     interrupting a megabyte took as long as the megabyte.
 *   - Worse, the paste never finished, so the closing `\e[201~` never
 *     arrived. readline stayed in bracketed-paste mode and silently swallowed
 *     everything typed afterwards: no prompt, no error, and reconnecting did
 *     not help, because it was the shell waiting rather than the socket.
 *     Measured: the shell never came back on its own; sending the end marker
 *     brought it back at once.
 *
 * So a ctrl-C jumps the queue, discarding input the shell has not seen yet and
 * closing any paste that input might have left open.
 */
export function forward(session: LiveTerminal, data: Buffer): void {
  // Typing is real use. An open but silent terminal is not.
  noteBoxActivity(session.ctx?.sessionKey, "terminal-input");
  const lastCtrlC = data.lastIndexOf(CTRL_C);
  if (lastCtrlC !== -1) {
    void session.terminal.interrupt().catch(() => undefined);
    // Anything typed after the ctrl-C is still meant for the shell.
    const rest = data.subarray(lastCtrlC + 1);
    if (rest.length === 0) return;
    data = Buffer.from(rest);
  }
  void session.terminal.write(new Uint8Array(data)).catch(error =>
    logger.warn("Terminal input dropped", {
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

/**
 * The worktree id for this actor, if one already exists — a single indexed
 * read, and deliberately NOT `ensureWorktree`.
 *
 * Reattaching to a shell that is already running has no reason to redo
 * worktree setup, and setup is not cheap: it resolves refs, can merge `main`
 * into the actor's branch, takes the worktree lock and writes Mongo. Doing it
 * per connection made reconnecting cost far more than it should — and since
 * the client reconnects on every network blip, that is the common path, not a
 * rare one. Thirty reconnects in a row queued thirty of those behind one lock
 * and left the shell unresponsive for tens of seconds.
 */
export async function existingWorktreeKey(
  project: IAppProject,
  userId: string,
): Promise<string | null> {
  // Convention, not lookup: the session key IS <workspaceId>:<userId>.
  // Kept async-shaped for its callers; there is nothing left to await.
  return sessionKeyFor(project.workspaceId, userId);
}

/**
 * tmux pane history as plain bytes, for prefilling xterm.js's OWN scrollback.
 *
 * The scrolling model is: tmux keeps the session alive; xterm.js does ALL
 * the scrolling. tmux runs with mouse off, status off and the alternate
 * screen stripped (terminal-overrides smcup@/rmcup@), so shell output flows
 * onto the normal buffer where the browser's native scrollback and wheel
 * physics just work — no escape-sequence scroll translation, no copy-mode,
 * no fighting between the div scrollbar and tmux's own scrolling (which
 * produced position indicators and duplicated repaints on screen at once).
 * What the buffer cannot have natively is history from before this client
 * attached — capture-pane provides exactly that.
 */
const TMUX_HISTORY_LINES = 5000;

/** How much of the raw session recording a reattach replays. */
const HIST_REPLAY_BYTES = 256 * 1024;
/**
 * Dev sessions replay far more: their recording is the WHOLE boot (npm
 * install + vite startup), and cutting it to a screenful was the "I'm
 * losing a bunch of output" complaint. Boots are bounded; 4MB covers them.
 */
const DEV_HIST_REPLAY_BYTES = 4 * 1024 * 1024;
/**
 * Generation marker the dev boot writes at the top of its recording. The
 * replay slices at the LAST one so a reattach shows only the newest boot —
 * including its install output, which script(1)'s own "Script started"
 * banner (written when the dev SESSION starts, after the install tee)
 * would otherwise cut off.
 */
const DEV_BOOT_MARKER = "=== mako dev boot:";

/**
 * Strip sequences that would make a REPLAYING terminal talk back. The
 * recording holds everything applications wrote, including queries (device
 * attributes, cursor position, DCS/OSC introspection); a fresh xterm.js
 * dutifully answers each one on replay and the answers land at the shell
 * prompt as junk keystrokes. Colors, cursor movement and screen switches
 * replay fine — only request/response machinery is removed.
 */
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const QUERY_SEQUENCES = new RegExp(
  [
    `${ESC}\\[[>=?]?[0-9;]*c`, // DA1/DA2/DA3 requests
    `${ESC}\\[[0-9;?]*n`, // DSR / CPR requests
    `${ESC}P[^${ESC}]*?${ESC}\\\\`, // any DCS (termcap queries etc.)
    `${ESC}\\][0-9]+;\\?(?:${BEL}|${ESC}\\\\)`, // OSC color queries
  ].join("|"),
  "g",
);

/**
 * Tail of the interactive session's raw recording, for scrollback prefill.
 * Base64 through the exec channel: the recording is binary-ish (escape
 * sequences, arbitrary bytes) and must arrive intact.
 */
export async function sessionHistory(
  ctx: SandboxExecContext,
  histFile: string,
  options: { dev?: boolean } = {},
): Promise<Buffer | null> {
  try {
    const cap = options.dev ? DEV_HIST_REPLAY_BYTES : HIST_REPLAY_BYTES;
    const result = await getSandboxProvider().exec(
      ctx,
      `tail -c ${cap} ${histFile} 2>/dev/null | base64`,
      { timeoutMs: 30_000 },
    );
    const raw = Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
    if (raw.length === 0) return null;
    let recorded = raw.toString("binary");
    // The recording appends across boots; replaying several generations of
    // the same session reads as chaos. Keep the newest one only. Dev boots
    // are delimited by our own marker (which precedes the install output);
    // shells by script(1)'s banner.
    const devMark = options.dev ? recorded.lastIndexOf(DEV_BOOT_MARKER) : -1;
    const lastBanner =
      devMark >= 0 ? devMark : recorded.lastIndexOf("Script started on ");
    if (lastBanner > 0) recorded = recorded.slice(lastBanner);
    const text = recorded
      .replace(QUERY_SEQUENCES, "")
      // script(1) writes its banner and sign-off INTO the recording even
      // with -q; they are bookkeeping, not session output.
      .replace(/^Script started on [^\n]*\n/gm, "")
      .replace(/^Script done on [^\n]*\n?/gm, "");
    return Buffer.from(text, "binary");
  } catch {
    return null;
  }
}
export async function tmuxHistory(
  ctx: SandboxExecContext,
  tmuxSession: string,
): Promise<Buffer | null> {
  try {
    const result = await getSandboxProvider().exec(
      ctx,
      `tmux capture-pane -pJ -e -S -${TMUX_HISTORY_LINES} -t ${tmuxSession} 2>/dev/null || true`,
      { timeoutMs: 30_000 },
    );
    const text = result.stdout.replace(/\s+$/u, "");
    if (!text) return null;
    return Buffer.from(`${text.replace(/\n/g, "\r\n")}\r\n`, "utf8");
  } catch {
    return null;
  }
}

/**
 * Attach a returning client to a shell that kept running: cancel the reaper
 * and replay what it missed.
 */
export function reattach(session: LiveTerminal, ws: WebSocket): void {
  if (session.reaper) {
    clearTimeout(session.reaper);
    session.reaper = null;
  }
  if (session.tmux) {
    // No ring-buffer replay (see LiveTerminal.tmux).
    void (async () => {
      if (session.ctx && session.histFile) {
        // dtach: replay the tail of the session recording — history AND
        // the current prompt, byte-faithful, ending exactly where the live
        // stream picks up. Nothing repaints because nothing needs to.
        const history = await sessionHistory(session.ctx, session.histFile, {
          dev: session.histFile.includes("mako-hist-dev-"),
        });
        if (history && ws.readyState === ws.OPEN) ws.send(history);
        if (!history && ws.readyState === ws.OPEN) {
          // Nothing recorded yet — a dev window waiting for its server, or
          // a brand-new shell. The pty printed its one-shot notice at
          // birth, which an earlier (possibly StrictMode-discarded) socket
          // consumed; say it again for this one.
          ws.send(
            Buffer.from(
              "\r\n\x1b[2m[waiting for the session to produce output]\x1b[0m\r\n",
              "utf8",
            ),
          );
        }
        return;
      }
      if (session.ctx && session.tmuxSession) {
        // tmux fallback: capture-pane history, then a size jiggle so tmux
        // repaints the live viewport BELOW it (repainting first would push
        // the fresh screen up into scrollback above the history).
        const history = await tmuxHistory(session.ctx, session.tmuxSession);
        if (history && ws.readyState === ws.OPEN) ws.send(history);
        if (session.lastCols > 1 && session.lastRows > 1) {
          await session.terminal
            .resize(session.lastCols, session.lastRows - 1)
            .then(() =>
              session.terminal.resize(session.lastCols, session.lastRows),
            )
            .catch(() => undefined);
        } else {
          session.repaint = true;
        }
      }
    })();
    return;
  }
  // Push any batched-but-unsent output into the scrollback first, or the
  // replay would end up to one flush-interval short of what the shell has
  // actually printed.
  session.flush();
  let replayed = 0;
  for (const chunk of session.scrollback) {
    if (ws.readyState === ws.OPEN) {
      ws.send(chunk);
      replayed += chunk.length;
    }
  }
  logger.info("Apps terminal ring replayed", { bytes: replayed });
}

/**
 * Kill a terminal session for real — the pty, the dtach/tmux session behind
 * it, its socket and its recording. This is what closing the tab in the UI
 * means: without it, every closed tab left a bash + script + dtach chain
 * running in the sandbox forever, reachable by nothing.
 */
export async function killTerminalSession(
  project: IAppProject,
  userId: string,
  termId: string,
): Promise<void> {
  const knownKey = await existingWorktreeKey(project, userId).catch(() => null);
  if (knownKey) {
    const key = `${knownKey}:${termId}`;
    const session = live.get(key);
    if (session) {
      live.delete(key);
      if (session.reaper) clearTimeout(session.reaper);
      for (const socket of session.sockets) {
        socket.close(4000, "session killed");
      }
      void session.terminal?.close().catch(() => undefined);
    }
  }
  const handle = await ensureWorktree(project, userId);
  const ctx = boxCtx(handle);
  if (await getSandboxProvider().hasSession(ctx)) {
    const provider = getSandboxProvider();
    // Two execs on purpose. `pkill -f` matches against every process's
    // command line — INCLUDING the shell running this very command. The
    // [m] guard keeps the pattern itself from matching, but any other
    // literal mention of the same path in the same command (the rm below)
    // made the shell match, kill itself, and skip everything after the
    // first pkill: the launcher survived every "kill" with its port. So the
    // kills run alone, with nothing else on their command line.
    const slug = termId.startsWith("dev-") ? termId.slice(4) : null;
    await provider
      .exec(
        ctx,
        `pkill -f "[m]ako-term-${termId}.sock" 2>/dev/null; ` +
          // A dev session's real payload is the node launcher hosting vite —
          // a child the dtach kill does not reach. Reap it by launcher path.
          (slug ? `pkill -f "[m]ako-dev-${slug}.mjs" 2>/dev/null; ` : "") +
          `tmux kill-session -t mako-${termId} 2>/dev/null; echo killed`,
        { timeoutMs: 30_000 },
      )
      .catch(() => undefined);
    await provider
      .exec(
        ctx,
        `rm -f /tmp/mako-term-${termId}.sock /tmp/mako-hist-${termId}.raw; echo done`,
        { timeoutMs: 30_000 },
      )
      .catch(() => undefined);
  }
}

/**
 * Kill EVERY terminal session this (project, user) box holds: all numeric
 * bash shells, plus this app's dev session. Leaving dev mode means leaving
 * — old shells that survived reattached as a museum of terminals (with
 * history) on the next entry. Other apps' dev sessions are NOT touched:
 * stopping app A must not kill app B's running server.
 */
export async function killAllTerminalSessions(
  project: IAppProject,
  userId: string,
  devSlug: string | null,
): Promise<void> {
  const slug = devSlug && /^[A-Za-z0-9_-]+$/.test(devSlug) ? devSlug : null;
  const knownKey = await existingWorktreeKey(project, userId).catch(() => null);
  if (knownKey) {
    for (const [key, session] of [...live.entries()]) {
      if (!key.startsWith(`${knownKey}:`)) continue;
      const termId = key.slice(knownKey.length + 1);
      const mine =
        /^[0-9]+$/.test(termId) || (slug && termId === `dev-${slug}`);
      if (!mine) continue;
      live.delete(key);
      if (session.reaper) clearTimeout(session.reaper);
      for (const socket of session.sockets) {
        socket.close(4000, "session killed");
      }
      void session.terminal?.close().catch(() => undefined);
    }
  }
  const handle = await ensureWorktree(project, userId);
  const ctx = boxCtx(handle);
  const provider = getSandboxProvider();
  if (!(await provider.hasSession(ctx))) return;
  // Same two-exec discipline as the single kill: pkill -f matches every
  // process's command line including the shell running the command, so the
  // kills run alone with nothing else naming the same paths.
  await provider
    .exec(
      ctx,
      `pkill -f "[m]ako-term-[0-9]" 2>/dev/null; ` +
        (slug
          ? `pkill -f "[m]ako-term-dev-${slug}.sock" 2>/dev/null; ` +
            `pkill -f "[m]ako-dev-${slug}.mjs" 2>/dev/null; `
          : "") +
        `echo killed`,
      { timeoutMs: 30_000 },
    )
    .catch(() => undefined);
  await provider
    .exec(
      ctx,
      `rm -f /tmp/mako-term-[0-9]*.sock /tmp/mako-hist-[0-9]*.raw` +
        (slug
          ? ` /tmp/mako-term-dev-${slug}.sock /tmp/mako-hist-dev-${slug}.raw`
          : "") +
        `; echo done`,
      { timeoutMs: 30_000 },
    )
    .catch(() => undefined);
}
