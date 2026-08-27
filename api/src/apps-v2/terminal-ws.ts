/**
 * Interactive terminal for Apps v2, over a WebSocket.
 *
 * The old terminal ran one command and printed the result. That is fine for
 * `ls`, and useless for everything a shell is actually for: a prompt, ctrl-C,
 * watching a build, an editor, anything that asks a question. This attaches a
 * real PTY in the sandbox and streams it, so the pane behaves like a terminal
 * because it IS one.
 *
 * Bytes both ways, no framing of our own — xterm.js and the shell already
 * agree on a protocol, and inventing a second one on top would only be
 * something else to get wrong. The single exception is window size, which has
 * no in-band representation: those arrive as a small JSON control message.
 *
 * A WebSocket upgrade has to be caught on the raw http.Server before Hono sees
 * it, the same way the old dev-preview proxy did. Unlike that proxy, nothing
 * of the tenant's runs here — this process only moves bytes between a socket
 * and a microVM.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { ServerType } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";
import { Types } from "mongoose";
import { loggers } from "../logging";
import { AppProjectV2, type IAppProjectV2 } from "../database/workspace-schema";
import { sessionManager } from "../auth/session";
import { workspaceService } from "../services/workspace.service";
import { canWriteResource } from "../utils/resource-acl";
import {
  type SandboxExecContext,
  getSandboxProvider,
  type SandboxTerminal,
} from "./sandbox/provider";
import {
  afterTerminalSession,
  boxCtx,
  ensureBox,
  ensureWorktree,
  sessionKeyFor,
  synthesizeProjectFromFolder,
} from "./worktree.service";

const logger = loggers.api("apps-v2-terminal");

const PATH_RE =
  /^\/api\/workspaces\/([^/]+)\/apps-v2\/([^/]+)\/terminal(\?.*)?$/;

/** Control messages are the one thing a byte stream cannot express. */
interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(
      part.slice(eq + 1).trim(),
    );
  }
  return out;
}

/**
 * Resolve the caller and the app, or return null.
 *
 * A terminal is write access by definition — you can run anything in it — so
 * it is gated on `canWriteResource`, not on read.
 */
async function authorize(
  req: IncomingMessage,
  workspaceId: string,
  appRef: string,
): Promise<{ project: IAppProjectV2; userId: string } | null> {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies["auth_session"];
  if (!sessionId) return null;

  const { user } = await sessionManager.validateSession(sessionId);
  if (!user) return null;
  if (!Types.ObjectId.isValid(workspaceId)) return null;

  const ref = appRef.replace(/^apps\//, "");
  const project =
    (Types.ObjectId.isValid(ref)
      ? await AppProjectV2.findOne({
          _id: new Types.ObjectId(ref),
          workspaceId: new Types.ObjectId(workspaceId),
        })
      : await AppProjectV2.findOne({
          slug: ref,
          workspaceId: new Types.ObjectId(workspaceId),
        })) ?? (await synthesizeProjectFromFolder(workspaceId, ref));
  if (!project) return null;

  const member = await workspaceService.getMember(workspaceId, user.id);
  const role = member?.role;
  if (!canWriteResource(project, user.id, role)) return null;
  return { project: project as IAppProjectV2, userId: user.id };
}

export function attachAppsV2TerminalWs(serverType: ServerType): void {
  // @hono/node-server's ServerType is a union including HTTP/2 variants, which
  // do not emit "upgrade" the HTTP/1.1 way. This app only runs the plain form.
  const server = serverType as Server;
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = PATH_RE.exec(req.url ?? "");
    if (!match) return; // Not ours — leave it for any other upgrade handler.
    const [, workspaceId, appRef, query] = match;
    // VS Code-style multiple terminals: each tab is its own PTY, addressed by
    // a client-chosen id. Absent (older clients) = the first tab.
    const params = new URLSearchParams((query ?? "").replace(/^\?/, ""));
    const termId = params.get("term") ?? "1";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(termId)) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    // The client knows its size before it connects; creating the pty at
    // that size (instead of a 2s-lived 80x24) keeps the very first output —
    // the prompt, a replayed recording — from painting at the wrong width.
    const clamp = (v: string | null, lo: number, hi: number, dflt: number) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
    };
    const initialCols = clamp(params.get("cols"), 20, 500, 80);
    const initialRows = clamp(params.get("rows"), 5, 300, 24);
    // A tab the client just created has no history to replay; saying so
    // saves the prefill exec round-trip on the open of every new terminal.
    const fresh = params.get("fresh") === "1";

    void (async () => {
      // A failed lookup is not a failed login. Collapsing both into 401 told
      // the client its session was bad when the truth was a transient error —
      // a worktree being rebuilt after its sandbox expired, say — and 401 is
      // the one status a client should NOT simply retry.
      let auth: Awaited<ReturnType<typeof authorize>> = null;
      try {
        auth = await authorize(req, workspaceId, appRef);
      } catch (error) {
        logger.error("Terminal authorization failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!auth) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, ws => {
        void startSession(ws, auth.project, auth.userId, termId, {
          initialCols,
          initialRows,
          fresh,
        }).catch(error => {
          logger.error("Terminal session failed to start", { error });
          ws.close(1011, "terminal failed to start");
        });
      });
    })();
  });

  logger.info("Apps v2 terminal WebSocket attached");
}

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
interface LiveTerminal {
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

const live = new Map<string, LiveTerminal>();

/**
 * Single-flight session creation. Two sockets for the same key race the
 * whole multi-second creation body (React StrictMode mounts twice, opening
 * two websockets) — without this, the second creation overwrote the first
 * in `live`, one pty leaked, and whichever ring the surviving session had
 * was the one clients replayed. Symptom: a dev window attached "open" but
 * blank while a fresh probe socket on the same termId got the full replay.
 */
const creating = new Map<string, Promise<LiveTerminal>>();

/**
 * dtach+script availability per sandbox — capabilities do not change while
 * a sandbox lives, so one probe per box, not one per terminal open.
 */
const dtachCapable = new Map<string, boolean>();

/** Forget per-box capability knowledge when the box is destroyed. */
export function forgetTerminalCaches(sessionKey: string): void {
  dtachCapable.delete(sessionKey);
}

/** Enough to redraw a screen and the tail of a build, not a whole session. */
const SCROLLBACK_LIMIT = 256 * 1024;

/** How long a shell keeps running with nobody attached. */
const ORPHAN_GRACE_MS = 10 * 60 * 1000;

function remember(session: LiveTerminal, chunk: Buffer): void {
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
function forward(session: LiveTerminal, data: Buffer): void {
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
async function existingWorktreeKey(
  project: IAppProjectV2,
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
async function sessionHistory(
  ctx: SandboxExecContext,
  histFile: string,
): Promise<Buffer | null> {
  try {
    const result = await getSandboxProvider().exec(
      ctx,
      `tail -c ${HIST_REPLAY_BYTES} ${histFile} 2>/dev/null | base64`,
      { timeoutMs: 30_000 },
    );
    const raw = Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
    if (raw.length === 0) return null;
    let recorded = raw.toString("binary");
    // The recording appends across boots; replaying several generations of
    // the same session reads as chaos. Keep the newest one only.
    const lastBanner = recorded.lastIndexOf("Script started on ");
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
async function tmuxHistory(
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
function reattach(session: LiveTerminal, ws: WebSocket): void {
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
        const history = await sessionHistory(session.ctx, session.histFile);
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
  logger.info("Apps v2 terminal ring replayed", { bytes: replayed });
}

/**
 * Kill a terminal session for real — the pty, the dtach/tmux session behind
 * it, its socket and its recording. This is what closing the tab in the UI
 * means: without it, every closed tab left a bash + script + dtach chain
 * running in the sandbox forever, reachable by nothing.
 */
export async function killTerminalSession(
  project: IAppProjectV2,
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

async function startSession(
  ws: WebSocket,
  project: IAppProjectV2,
  userId: string,
  termId: string,
  options: { initialCols: number; initialRows: number; fresh: boolean },
): Promise<void> {
  // Fast path first: if the shell is already running, attach to it and do no
  // repository work at all. Sessions are keyed per (worktree, terminal tab):
  // one sandbox, as many shells in it as the person opens.
  const knownKey = await existingWorktreeKey(project, userId).catch(() => null);
  const running = knownKey ? live.get(`${knownKey}:${termId}`) : undefined;

  // Say something before the slow part. The socket is already open by now, so
  // the client shows "open" while the server may spend the best part of a
  // minute creating a sandbox and syncing files into it — a blank pane that
  // claims to be connected, which is precisely the "terminal looks dead"
  // impression the rest of this file exists to avoid.
  if (!running && ws.readyState === ws.OPEN) {
    ws.send(
      Buffer.from(
        "\x1b[2m[connecting to the app's machine…]\x1b[0m\r\n",
        "utf8",
      ),
    );
  }

  let key: string;
  let session: LiveTerminal;
  let ranCreation = false;

  if (running) {
    key = `${knownKey!}:${termId}`;
    session = running;
    reattach(session, ws);
  } else {
    // Only the cold path pays for worktree setup.
    const handle = await ensureWorktree(project, userId);
    key = `${boxCtx(handle).sessionKey}:${termId}`;
    const existing = live.get(key);
    const inFlight = creating.get(key);
    if (existing) {
      session = existing;
      reattach(session, ws);
    } else if (inFlight) {
      session = await inFlight;
      reattach(session, ws);
    } else {
      let resolveCreated!: (t: LiveTerminal) => void;
      let rejectCreated!: (e: unknown) => void;
      const creation = new Promise<LiveTerminal>((res, rej) => {
        resolveCreated = res;
        rejectCreated = rej;
      });
      creation.catch(() => undefined); // observed via `creating`, not here
      creating.set(key, creation);
      ranCreation = true;
      try {
        const provider = getSandboxProvider();
        // Armed for dev windows: the first dtach attach emits a screen clear
        // we do not want (see onData). Declared here so onData can see it.
        let attachClearPending = termId.startsWith("dev-");
        const created: LiveTerminal = {
          terminal: undefined as unknown as SandboxTerminal,
          scrollback: [],
          scrollbackBytes: 0,
          sockets: new Set(),
          reaper: null,
          flush: () => undefined,
          tmux: false,
          repaint: false,
          ctx: null,
          tmuxSession: null,
          histFile: null,
          lastCols: 0,
          lastRows: 0,
        };
        // Output is BATCHED before it leaves the process.
        //
        // E2B delivers pty output almost byte by byte: 125KB of echo arrived as
        // 68,000 separate callbacks, which without this would be 68,000 WebSocket
        // frames for a single paste. Coalescing on a short timer makes that a few
        // hundred. VS Code batches terminal output for the same reason.
        //
        // Worth being precise about what this did NOT fix: the terminal freezing
        // on a large paste looked like client backpressure reaching the pty, and
        // it was not — it was the interactive shell (see BASHRC in
        // e2b-template.ts). Batching is a real saving on a chatty stream, not the
        // cure for that bug.
        let outbox: Buffer[] = [];
        let outboxBytes = 0;
        let flushTimer: NodeJS.Timeout | null = null;

        const flush = () => {
          flushTimer = null;
          if (outbox.length === 0) return;
          const chunk = outbox.length === 1 ? outbox[0] : Buffer.concat(outbox);
          outbox = [];
          outboxBytes = 0;
          remember(created, chunk);
          if (created.sockets.size === 0) {
            logger.info("Apps v2 terminal output with no sockets", {
              termId,
              bytes: chunk.length,
            });
          }
          for (const socket of created.sockets) {
            // Skip a client that has stopped reading rather than buffering without
            // limit: one wedged tab must not take the server with it.
            if (
              socket.readyState === socket.OPEN &&
              socket.bufferedAmount < 8 * 1024 * 1024
            ) {
              socket.send(chunk);
            }
          }
        };

        // Hydrating here is what makes the terminal a real checkout: the
        // sandbox holds the repository, and nothing overwrites it afterwards —
        // so a `git checkout` typed in this shell survives.
        if (ws.readyState !== ws.OPEN) {
          throw new Error("client disconnected before the terminal opened");
        }
        const ctx = await ensureBox(handle, { lazyPull: true });
        // The client can vanish while the box boots (tab closed, page
        // reloaded, a dying page's last reconnect). Finishing the open
        // would leave a pty and a machine running for NOBODY — the shape
        // that re-created a recycled box from a page mid-teardown. Stop
        // here; a box ensureBox already made simply idles out.
        if (ws.readyState !== ws.OPEN) {
          throw new Error("client disconnected before the box was ready");
        }
        created.ctx = ctx;
        // The pty may be new while the SESSION is old (API restart, new
        // sandbox connection): prefill history now, before any live output,
        // so the client gets [history][live] in that order. A session that
        // does not exist yet has nothing to replay.
        const priorHistory = options.fresh
          ? null
          : ((await sessionHistory(ctx, `/tmp/mako-hist-${termId}.raw`)) ??
            (await tmuxHistory(ctx, `mako-${termId}`)));
        if (priorHistory) {
          if (termId.startsWith("dev-")) {
            // Dev windows are ring-replay sessions: put the history IN the
            // ring, where every attaching socket (including StrictMode's
            // second mount, which discards the first) replays it. A direct
            // send would reach only the first, often-doomed socket.
            remember(created, priorHistory);
          } else if (ws.readyState === ws.OPEN) {
            ws.send(priorHistory);
          }
        }
        // The app's folder can legitimately be absent — a box on a branch from
        // before the app existed, or a pull that refused to merge. A real
        // computer still gives you a shell; refusing to open one here bricked
        // the only tool that could fix the situation. Fall back to the repo
        // root and say so.
        const cwdProbe = await provider.exec(
          ctx,
          `test -d ${JSON.stringify(`/home/user/app/${handle.appRoot}`)} && echo yes || echo no`,
          { timeoutMs: 15_000 },
        );
        const appDirExists = cwdProbe.stdout.includes("yes");
        void Promise.resolve(getSandboxProvider().describe?.(ctx))
          .then(info => {
            created.bornOn = info?.sandboxId ?? null;
          })
          .catch(() => {
            created.bornOn = null;
          });
        created.terminal = await provider.openTerminal(ctx, {
          cwd: appDirExists ? handle.appRoot : ".",
          cols: options.initialCols,
          rows: options.initialRows,
          onExit: () => {
            // The shell is gone for good. Forget it, so the next connection
            // builds a fresh one instead of attaching to a corpse, and tell
            // whoever is watching — the client reconnects on close, and would
            // otherwise sit in front of a terminal that silently ignores every
            // keystroke. This is the difference between a sandbox expiring
            // overnight being invisible and it bricking the terminal until the
            // API restarts.
            if (live.get(key) === created) live.delete(key);
            if (created.reaper) clearTimeout(created.reaper);
            // A shell's pty ending is what `exit` MEANS: close the tab like
            // a real terminal app (client keys off the close code) instead
            // of respawning a shell nobody asked for. A dev window is the
            // opposite — it exists to watch a session that comes and goes,
            // so it reconnects into its waiting loop. Code 4000 = "session
            // over, do not reconnect"; 1012 = "shell lost, come back".
            const devWindow = termId.startsWith("dev-");
            void (async () => {
              // `exit` must close the tab reliably, so 4000 stays the
              // default; reconnect (1012) only on POSITIVE evidence the
              // machine itself died: the session key now resolves to a
              // different box than the one this pty was born on, or to no
              // box at all. A transient lookup failure counts as "unknown"
              // and keeps the close-the-tab behavior.
              let machineGone = false;
              if (!devWindow && created.bornOn) {
                try {
                  const info = await getSandboxProvider().describe?.(ctx);
                  machineGone = (info?.sandboxId ?? null) !== created.bornOn;
                } catch {
                  machineGone = false;
                }
              }
              const reconnect = devWindow || machineGone;
              const notice = devWindow
                ? "\r\n\x1b[2m[the dev server session ended]\x1b[0m\r\n"
                : machineGone
                  ? "\r\n\x1b[2m[the machine restarted — reconnecting…]\x1b[0m\r\n"
                  : "\r\n\x1b[2m[session ended]\x1b[0m\r\n";
              for (const socket of created.sockets) {
                if (socket.readyState === socket.OPEN) {
                  socket.send(Buffer.from(notice, "utf8"));
                  socket.close(reconnect ? 1012 : 4000, "session ended");
                }
              }
              created.sockets.clear();
            })();
          },
          onData: data => {
            let payload: Uint8Array | string = data;
            if (attachClearPending) {
              // dtach clears the client's screen when it attaches — which,
              // in a dev window, wipes the just-replayed session history.
              // Swallow that one clear (and only it); vite's own later
              // clears pass through untouched.
              const text = Buffer.from(data).toString("binary");
              // eslint-disable-next-line no-control-regex -- matching the terminal's own ESC bytes is the whole point
              const cleared = text.replace(/\x1b\[H\x1b\[[02]?J/, "\r\n");
              if (cleared !== text) {
                attachClearPending = false;
                payload = Buffer.from(cleared, "binary");
              }
            }
            outbox.push(Buffer.from(payload as Uint8Array));
            outboxBytes += payload.length;
            // Flush early on volume so a burst is not held back by the timer,
            // and otherwise coalesce a frame's worth of keystroke echo.
            if (outboxBytes >= 64 * 1024) {
              if (flushTimer) clearTimeout(flushTimer);
              flush();
            } else if (!flushTimer) {
              flushTimer = setTimeout(flush, 8);
            }
          },
        });
        created.flush = () => {
          if (flushTimer) clearTimeout(flushTimer);
          flush();
        };

        // Hand the shell to tmux when the sandbox has it. This is what makes
        // sessions durable in the SANDBOX rather than in this process's `live`
        // map: an API restart loses the map, but the next attach runs the same
        // line and tmux `new -A` reattaches to the running session — scrollback,
        // running processes and all. Guarded, not exec'd blind: a sandbox
        // without tmux just keeps its plain bash, which is today's behavior.
        // `clear` hides the handoff line itself so the terminal opens clean.
        if (!appDirExists) {
          // Into the replay buffer, not the socket list — the caller's socket
          // attaches AFTER this block, and replay is what it reads first.
          remember(
            created,
            Buffer.from(
              `\r\n\x1b[33m[${handle.appRoot} is not in this checkout — opened at the repo root; try \x1b[1mgit pull\x1b[22m]\x1b[0m\r\n`,
              "utf8",
            ),
          );
        }
        // Session persistence WITHOUT a screen engine. dtach is a pure
        // socket relay around a pty: the shell's output reaches xterm.js as
        // the linear stream it is, so the browser terminal's own scrollback
        // and wheel physics work natively — no alternate screen, no
        // copy-mode, no scroll-event translation. (tmux was tried first: its
        // redraw engine and a browser terminal fight over scrolling — the
        // wheel either goes dead or turns erratic, and stripping smcup with
        // terminal-overrides no longer yields native scrollback on tmux 3.x,
        // whose engine scrolls with sequences emulators rightly keep out of
        // the scrollback buffer.) script(1) records the session to a file,
        // which is where reattach history comes from (sessionHistory). tmux
        // stays as the fallback for sandboxes without dtach, and remains the
        // right tool for the HEADLESS dev-server sessions.
        const tmuxSession = `mako-${termId}`;
        const histFile = `/tmp/mako-hist-${termId}.raw`;
        const dtachSock = `/tmp/mako-term-${termId}.sock`;
        // A `dev-<slug>` terminal is a WINDOW onto a session the dev-server
        // service owns (ensureDevServer starts it headlessly with dtach -n,
        // same socket/history naming). Attach-only: never start a shell at
        // this id — if the session is not up yet, wait for the socket and
        // attach the moment it appears. Ctrl-C then reaches vite like any
        // process in a terminal, colors flow because vite has a real pty,
        // and scrollback/prefill work exactly as in every other session.
        const isDevWindow = termId.startsWith("dev-");
        const conf =
          `# mako-terminal v2\\nset -g mouse off\\nset -g status off\\n` +
          `set -g history-limit 50000\\nset -g terminal-overrides ",*:smcup@:rmcup@"\\n`;
        if (isDevWindow) {
          // The handoff line is plumbing; without this it echoes as a wall
          // of shell into the dev window before the session content. Sent
          // as its own write so echo is off when the handoff is typed.
          await created.terminal
            .write(new TextEncoder().encode(" stty -echo 2>/dev/null\n"))
            .catch(() => undefined);
        }
        const handoff = isDevWindow
          ? // Not running yet: say so, then tail the recording (a cold Launch
            // tees npm install into it — live progress), and attach the
            // moment the session's socket appears. Running: attach directly.
            ` set +m; if [ ! -S ${dtachSock} ]; then printf '\\x1b[2m[waiting for the dev server]\\x1b[0m\\r\\n'; tail -n 0 -F ${histFile} 2>/dev/null & MAKO_TP=$!; while [ ! -S ${dtachSock} ]; do sleep 0.5; done; kill $MAKO_TP 2>/dev/null; fi; exec dtach -A ${dtachSock} -r winch true\n`
          : ` if command -v dtach >/dev/null && command -v script >/dev/null; then exec dtach -A ${dtachSock} -r winch script -qf -c 'bash -l' ${histFile}; fi; ` +
            `command -v tmux >/dev/null && { if [ ! -f "$HOME/.tmux.conf" ] || grep -q mako-terminal "$HOME/.tmux.conf"; then printf '${conf}' > "$HOME/.tmux.conf"; fi; ` +
            `tmux set -g mouse off 2>/dev/null; tmux set -g status off 2>/dev/null; ` +
            `exec tmux new -A -s ${tmuxSession}; }; clear\n`;
        await created.terminal
          .write(new TextEncoder().encode(handoff))
          .catch(() => undefined);
        // Which manager took over decides the reattach strategy. Probe once:
        // the dtach socket appears within a beat of the exec when dtach won.
        if (isDevWindow) {
          // A dev window is a plain ring-buffer session: dtach relays vite's
          // bytes with no terminal queries (the tmux-era reason to skip the
          // ring), so the ring replay is safe AND necessary — it is what
          // carries the waiting notice, the boot stream and the attach
          // output to sockets that connect after the pty was born
          // (StrictMode double-mounts eat one-shot output otherwise).
          created.tmux = false;
        } else {
          created.tmux = true;
          // Deterministic: the handoff execs dtach exactly when dtach AND
          // script exist, so ask for the capabilities, not the socket —
          // and only once per sandbox; capabilities are immutable while
          // the box lives.
          let capable = dtachCapable.get(ctx.sessionKey);
          if (capable === undefined) {
            const probe = await getSandboxProvider()
              .exec(
                ctx,
                `command -v dtach >/dev/null && command -v script >/dev/null && echo dtach || echo other`,
                { timeoutMs: 15_000 },
              )
              .catch(() => null);
            capable = probe?.stdout.includes("dtach") ?? false;
            if (probe) dtachCapable.set(ctx.sessionKey, capable);
          }
          if (capable) {
            created.histFile = histFile;
          } else {
            created.tmuxSession = tmuxSession;
          }
        }

        live.set(key, created);
        session = created;
        logger.info("Apps v2 terminal started", {
          termId,
          projectId: project._id.toString(),
          appRoot: handle.appRoot,
        });
        resolveCreated(created);
      } catch (error) {
        rejectCreated(error);
        throw error;
      } finally {
        creating.delete(key);
      }
    }
  }

  const current = session;
  current.sockets.add(ws);
  if (ranCreation && !current.tmux) {
    // The creator's socket is attached AFTER the pty started talking, so
    // whatever the shell said in between lives only in the ring. Replay it —
    // for a dev window that is the waiting notice and the boot stream.
    reattach(current, ws);
  }

  ws.on("message", (raw: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      const text = raw.toString("utf8");
      if (text.startsWith("{")) {
        try {
          const msg = JSON.parse(text) as ResizeMessage;
          if (msg.type === "resize" && msg.cols > 0 && msg.rows > 0) {
            current.lastCols = msg.cols;
            current.lastRows = msg.rows;
            if (current.repaint) {
              // tmux only repaints when the size CHANGES, and a reattaching
              // client usually reports exactly the size the pty already
              // has. One row down, then the real size: guaranteed change,
              // full redraw, invisible to the eye.
              current.repaint = false;
              const jiggle = msg.rows > 1 ? msg.rows - 1 : msg.rows + 1;
              void current.terminal
                .resize(msg.cols, jiggle)
                .then(() => current.terminal.resize(msg.cols, msg.rows))
                .catch(() => undefined);
              return;
            }
            void current.terminal
              .resize(msg.cols, msg.rows)
              .catch(() => undefined);
            return;
          }
        } catch {
          // Not a control message — fall through and type it.
        }
      }
      forward(current, Buffer.from(text, "utf8"));
      return;
    }
    forward(current, raw);
  });

  const detach = () => {
    current.sockets.delete(ws);
    if (current.sockets.size > 0 || current.reaper) return;
    // Nobody watching. Settle up first: a `git commit` typed in this shell is
    // sitting unpushed on a disposable machine, and a `git checkout` typed
    // here has moved the branch under the cached record. execInWorktree does
    // this after every command; a PTY has no "after", so the closest thing to
    // it is the last client leaving.
    void afterTerminalSession(project.workspaceId.toString(), userId);
    // Keep the shell for a while — a reload or a dropped connection should
    // not kill a running command — then reap it so an abandoned sandbox is
    // not held open forever.
    current.reaper = setTimeout(() => {
      live.delete(key);
      void current.terminal.close().catch(() => undefined);
      logger.info("Apps v2 terminal reaped after no clients", { key });
    }, ORPHAN_GRACE_MS);
  };
  ws.on("close", detach);
  ws.on("error", detach);
}
