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
import {
  AppProjectV2,
  AppWorktreeV2,
  type IAppProjectV2,
} from "../database/workspace-schema";
import { sessionManager } from "../auth/session";
import { workspaceService } from "../services/workspace.service";
import { canWriteResource } from "../utils/resource-acl";
import { getSandboxProvider, type SandboxTerminal } from "./sandbox/provider";
import {
  ensureWorktree,
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
    const [, workspaceId, appRef] = match;

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
        void startSession(ws, auth.project, auth.userId).catch(error => {
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
  /** Recent output, replayed to a client that reconnects. */
  scrollback: Buffer[];
  scrollbackBytes: number;
  sockets: Set<WebSocket>;
  /** Force any pending output out, e.g. before a client detaches. */
  flush: () => void;
  /** Persist what the shell has done. Debounced; see where it is assigned. */
  persist: () => void;
  /** Set when the last socket leaves; cancelled if someone comes back. */
  reaper: NodeJS.Timeout | null;
}

const live = new Map<string, LiveTerminal>();

/** Enough to redraw a screen and the tail of a build, not a whole session. */
const SCROLLBACK_LIMIT = 256 * 1024;

/** Quiet time after activity before the shell's work is written back. */
const PERSIST_IDLE_MS = 3_000;

/** Longest a steadily-busy shell may go unpersisted. */
const PERSIST_MAX_MS = 30_000;

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
  const doc = await AppWorktreeV2.findOne(
    { workspaceId: project.workspaceId, userId },
    { _id: 1 },
  ).lean();
  return doc ? String(doc._id) : null;
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
  // Push any batched-but-unsent output into the scrollback first, or the
  // replay would end up to one flush-interval short of what the shell has
  // actually printed.
  session.flush();
  for (const chunk of session.scrollback) {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  }
}

async function startSession(
  ws: WebSocket,
  project: IAppProjectV2,
  userId: string,
): Promise<void> {
  // Fast path first: if the shell is already running, attach to it and do no
  // repository work at all.
  const knownKey = await existingWorktreeKey(project, userId).catch(() => null);
  const running = knownKey ? live.get(knownKey) : undefined;

  // Say something before the slow part. The socket is already open by now, so
  // the client shows "open" while the server may spend the best part of a
  // minute creating a sandbox and syncing files into it — a blank pane that
  // claims to be connected, which is precisely the "terminal looks dead"
  // impression the rest of this file exists to avoid.
  if (!running && ws.readyState === ws.OPEN) {
    ws.send(
      Buffer.from(
        "\x1b[2m[starting a sandbox for this app…]\x1b[0m\r\n",
        "utf8",
      ),
    );
  }

  let key: string;
  let session: LiveTerminal;

  if (running) {
    key = knownKey!;
    session = running;
    reattach(session, ws);
  } else {
    // Only the cold path pays for worktree setup.
    const handle = await ensureWorktree(project, userId);
    key = handle.doc._id.toString();
    const existing = live.get(key);
    if (existing) {
      session = existing;
      reattach(session, ws);
    } else {
      const provider = getSandboxProvider();
      const created: LiveTerminal = {
        terminal: undefined as unknown as SandboxTerminal,
        scrollback: [],
        scrollbackBytes: 0,
        sockets: new Set(),
        reaper: null,
        flush: () => undefined,
        persist: () => undefined,
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
        // Output means the shell is doing something, which is the only signal
        // available that files may have changed.
        created.persist();
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

      created.terminal = await provider.openTerminal(
        { hostDir: handle.sessionDir, sessionKey: key },
        {
          cwd: handle.appRoot,
          cols: 80,
          rows: 24,
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
            // A sentence, not the provider's wording: `reason` is whatever E2B
            // put on the wire ("...reached end of life while the request was in
            // flight"), which is useful in a log and baffling in a terminal. The
            // provider already logged it.
            const notice =
              "\r\n\x1b[2m[this shell ended — reconnecting]\x1b[0m\r\n";
            for (const socket of created.sockets) {
              if (socket.readyState === socket.OPEN) {
                socket.send(Buffer.from(notice, "utf8"));
                socket.close(1012, "terminal ended");
              }
            }
            created.sockets.clear();
          },
          onData: data => {
            outbox.push(Buffer.from(data));
            outboxBytes += data.length;
            // Flush early on volume so a burst is not held back by the timer,
            // and otherwise coalesce a frame's worth of keystroke echo.
            if (outboxBytes >= 64 * 1024) {
              if (flushTimer) clearTimeout(flushTimer);
              flush();
            } else if (!flushTimer) {
              flushTimer = setTimeout(flush, 8);
            }
          },
        },
      );
      created.flush = () => {
        if (flushTimer) clearTimeout(flushTimer);
        flush();
      };

      // Persist the shell's work back to the host tree.
      //
      // `exec` syncs around every command; a PTY has no such boundary, so this
      // is debounced on activity instead — quiet for a moment means whatever
      // was running has probably stopped writing. A sync tars the whole tree,
      // so it must not run per keystroke; and a build that prints steadily for
      // a minute must not defer it forever either, hence the ceiling.
      let persistTimer: NodeJS.Timeout | null = null;
      let persistDeadline: NodeJS.Timeout | null = null;
      const runPersist = () => {
        if (persistTimer) clearTimeout(persistTimer);
        if (persistDeadline) clearTimeout(persistDeadline);
        persistTimer = null;
        persistDeadline = null;
        void created.terminal.sync();
      };
      created.persist = () => {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = setTimeout(runPersist, PERSIST_IDLE_MS);
        if (!persistDeadline) {
          persistDeadline = setTimeout(runPersist, PERSIST_MAX_MS);
        }
      };
      live.set(key, created);
      session = created;
      logger.info("Apps v2 terminal started", {
        projectId: project._id.toString(),
        appRoot: handle.appRoot,
      });
    }
  }

  const current = session;
  current.sockets.add(ws);

  ws.on("message", (raw: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      const text = raw.toString("utf8");
      if (text.startsWith("{")) {
        try {
          const msg = JSON.parse(text) as ResizeMessage;
          if (msg.type === "resize" && msg.cols > 0 && msg.rows > 0) {
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
    // Nobody is watching any more, so write the work back now rather than
    // waiting on a debounce that a closed tab will never fire again.
    void current.terminal.sync();
    // Nobody watching. Keep the shell for a while — a reload or a dropped
    // connection should not kill a running command — then reap it so an
    // abandoned sandbox is not held open forever.
    current.reaper = setTimeout(() => {
      live.delete(key);
      // Last chance: after close() the shell is gone, and so is anything it
      // did that never reached the host.
      void current.terminal
        .sync()
        .catch(() => undefined)
        .then(() => current.terminal.close())
        .catch(() => undefined);
      logger.info("Apps v2 terminal reaped after no clients", { key });
    }, ORPHAN_GRACE_MS);
  };
  ws.on("close", detach);
  ws.on("error", detach);
}
