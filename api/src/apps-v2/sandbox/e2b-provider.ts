/**
 * E2B sandbox provider — Firecracker microVM execution for Apps v2.
 *
 * Session model:
 * - One E2B sandbox per worktree (`sessionKey`), reused across commands and
 *   auto-paused by E2B on idle timeout (filesystem-only snapshot) so idle
 *   sessions cost nothing but keep node_modules warm; `connect` resumes.
 - The sandbox holds the working copy — an ordinary git clone whose origin is
 *   Mako's own git endpoint (see box.ts). Nothing is copied in or out around
 *   a command, which is why a `git checkout` typed in the terminal survives:
 *   there is no second working tree to sync with.
 * - Tenant commands run as the unprivileged template user with a minimal env.
 *   The one credential in the box is a workspace-scoped git token in a file
 *   read by a credential helper; no Mako secret or database credential ever
 *   enters the sandbox.
 */
import path from "node:path";
import { Sandbox } from "e2b";
import {
  APPS_V2_EXEC_DEFAULT_TIMEOUT_MS,
  APPS_V2_EXEC_MAX_OUTPUT_BYTES,
  APPS_V2_EXEC_MAX_TIMEOUT_MS,
} from "../config";
import { loggers } from "../../logging";
import type {
  SandboxTerminal,
  SandboxExecContext,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxProvider,
} from "./provider";

const logger = loggers.api("apps-v2-e2b");

/** Read at call time (not module load) so dotenv ordering can't freeze it. */
function templateId(): string {
  return process.env.APPS_V2_E2B_TEMPLATE?.trim() || "base";
}
const SANDBOX_USER = "user";
const REMOTE_ROOT = "/home/user/app";
/** Idle window before E2B auto-pauses the sandbox (resets on activity). */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function apiKey(): string {
  const key = process.env.E2B_API_KEY;
  if (!key) {
    throw new Error(
      "E2B_API_KEY is not set — configure it or use APPS_V2_SANDBOX_PROVIDER=local for development",
    );
  }
  return key;
}

// In-process session affinity: worktreeId -> sandboxId. Repaired lazily via
// Sandbox.list metadata when the process restarts.
const sessions = new Map<string, string>();

async function connectSession(sessionKey: string): Promise<Sandbox> {
  const known = sessions.get(sessionKey);
  if (known) {
    try {
      return await Sandbox.connect(known, { apiKey: apiKey() });
    } catch {
      sessions.delete(sessionKey);
    }
  }
  // Recover a paused/running sandbox for this worktree if one exists.
  try {
    const paginator = Sandbox.list({
      apiKey: apiKey(),
      query: { metadata: { makoAppsV2SessionKey: sessionKey } },
      limit: 5,
    });
    if (paginator.hasNext) {
      const page = await paginator.nextItems();
      // Deterministic choice when the key matches more than one sandbox.
      // Duplicates happen: two API processes (a dev machine and a preview
      // deployment share one E2B account and one database) can each create a
      // box for the same worktree, and page order is not a contract — so
      // without sorting, WHICH working copy answered depended on the whim of
      // a list API, and files written through one process vanished when the
      // next request read the other box. Newest wins, always, everywhere.
      const [info, ...stale] = [...page].sort(
        (a, b) =>
          new Date(b.startedAt ?? 0).getTime() -
          new Date(a.startedAt ?? 0).getTime(),
      );
      if (stale.length > 0) {
        logger.warn("Multiple sandboxes share one session key; using newest", {
          sessionKey,
          using: info?.sandboxId,
          ignoring: stale.map(x => x.sandboxId),
        });
      }
      if (info) {
        const sandbox = await Sandbox.connect(info.sandboxId, {
          apiKey: apiKey(),
        });
        sessions.set(sessionKey, sandbox.sandboxId);
        return sandbox;
      }
    }
  } catch (error) {
    logger.warn("E2B session lookup failed; creating fresh sandbox", {
      sessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const sandbox = await Sandbox.create(templateId(), {
    apiKey: apiKey(),
    timeoutMs: IDLE_TIMEOUT_MS,
    metadata: { makoAppsV2SessionKey: sessionKey },
    // Pause WITH MEMORY on idle: the sandbox is a stateful computer now —
    // tmux sessions, per-app dev servers, a user's running processes — so
    // idling must be sleep, not death. A full memory snapshot means resume
    // restores every process exactly where it was: reopening the page after
    // a night away reattaches to the same dev server and the same shells
    // instead of cold-booting (fs-only snapshots reboot the VM on resume,
    // which is how "why did my dev server restart overnight" happened).
    // Resume is explicit via Sandbox.connect() in connectSession; a sandbox
    // that is fully dead still falls through to a fresh create + hydrate.
    lifecycle: { onTimeout: { action: "pause", keepMemory: true } },
  });
  await sandbox.commands.run(`mkdir -p ${REMOTE_ROOT}`, {
    user: SANDBOX_USER,
  });
  sessions.set(sessionKey, sandbox.sandboxId);
  logger.info("E2B sandbox created", {
    sessionKey,
    sandboxId: sandbox.sandboxId,
  });
  return sandbox;
}

// ---------------------------------------------------------------------------
// Host <-> sandbox sync (tar streams over the E2B filesystem API)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Exec
// ---------------------------------------------------------------------------

async function execE2b(
  ctx: SandboxExecContext,
  command: string,
  options: SandboxExecOptions = {},
): Promise<SandboxExecResult> {
  const timeoutMs = Math.min(
    Math.max(1_000, options.timeoutMs ?? APPS_V2_EXEC_DEFAULT_TIMEOUT_MS),
    APPS_V2_EXEC_MAX_TIMEOUT_MS,
  );
  const startedAt = Date.now();
  const sandbox = await connectSession(ctx.sessionKey);
  // Keep the sandbox alive long enough for this command + sync overhead.
  await sandbox.setTimeout(Math.max(IDLE_TIMEOUT_MS, timeoutMs + 60_000));

  const cwd = options.cwd
    ? path.posix.join(REMOTE_ROOT, options.cwd)
    : REMOTE_ROOT;
  if (!cwd.startsWith(REMOTE_ROOT)) {
    throw new Error(
      `cwd escapes the session root: ${JSON.stringify(options.cwd)}`,
    );
  }

  let stdout = "";
  let stderr = "";
  let truncated = false;
  let exitCode = 0;
  let timedOut = false;
  const cap = APPS_V2_EXEC_MAX_OUTPUT_BYTES;
  const push = (target: "out" | "err", data: string) => {
    if (target === "out") {
      if (stdout.length < cap) stdout += data.slice(0, cap - stdout.length);
      else truncated = true;
    } else {
      if (stderr.length < cap) stderr += data.slice(0, cap - stderr.length);
      else truncated = true;
    }
  };

  try {
    const result = await sandbox.commands.run(command, {
      user: SANDBOX_USER,
      cwd,
      timeoutMs,
      envs: {
        HOME: "/home/user",
        LANG: "C.UTF-8",
        TERM: "dumb",
        CI: "1",
        npm_config_yes: "true",
        NO_UPDATE_NOTIFIER: "1",
        // There is no human at this end. Without it git blocks on a
        // credential prompt until the timeout and reports nothing.
        GIT_TERMINAL_PROMPT: "0",
        ...(options.env ?? {}),
      },
      onStdout: d => push("out", d),
      onStderr: d => push("err", d),
    });
    exitCode = result.exitCode;
  } catch (error) {
    // e2b throws CommandExitError on non-zero exit and TimeoutError on
    // deadline; normalize both into the result contract.
    const err = error as {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      name?: string;
      message?: string;
    };
    if (typeof err.exitCode === "number") {
      exitCode = err.exitCode;
      if (err.stdout && !stdout) push("out", err.stdout);
      if (err.stderr && !stderr) push("err", err.stderr);
    } else if (err.name === "TimeoutError") {
      exitCode = 124;
      timedOut = true;
    } else {
      throw error;
    }
  }

  return {
    exitCode,
    stdout,
    stderr,
    timedOut,
    durationMs: Date.now() - startedAt,
    truncated,
  };
}

/**
 * Start a detached process and return as soon as it is running.
 *
 * Syncs the tree IN (the process needs current sources) but deliberately not
 * back OUT: the command has not finished, and a sync-out mid-run would race a
 * live dev server writing caches. Long-running work reaches the host through
 * the ordinary per-command syncs that follow.
 */
async function execDetachedE2b(
  ctx: SandboxExecContext,
  command: string,
  options: SandboxExecOptions = {},
): Promise<void> {
  const sandbox = await connectSession(ctx.sessionKey);
  await sandbox.setTimeout(IDLE_TIMEOUT_MS);
  const cwd = options.cwd
    ? path.posix.join(REMOTE_ROOT, options.cwd)
    : REMOTE_ROOT;
  if (!cwd.startsWith(REMOTE_ROOT)) {
    throw new Error(
      `cwd escapes the session root: ${JSON.stringify(options.cwd)}`,
    );
  }
  const result = await sandbox.commands.run(command, {
    user: SANDBOX_USER,
    cwd,
    timeoutMs: 60_000,
    envs: {
      HOME: "/home/user",
      LANG: "C.UTF-8",
      TERM: "dumb",
      CI: "1",
      ...(options.env ?? {}),
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to start detached process: ${result.stderr.slice(0, 500)}`,
    );
  }
}

async function readFileE2b(
  ctx: SandboxExecContext,
  remotePath: string,
): Promise<Uint8Array> {
  const sandbox = await connectSession(ctx.sessionKey);
  const data = await sandbox.files.read(remotePath, {
    format: "bytes",
    user: SANDBOX_USER,
  });
  return new Uint8Array(data as Uint8Array);
}

async function writeFileE2b(
  ctx: SandboxExecContext,
  remotePath: string,
  bytes: Uint8Array,
): Promise<void> {
  const sandbox = await connectSession(ctx.sessionKey);
  await sandbox.files.write(remotePath, bytes.buffer as ArrayBuffer, {
    user: SANDBOX_USER,
  });
}

async function publicUrlForPortE2b(
  ctx: SandboxExecContext,
  port: number,
): Promise<string> {
  const sandbox = await connectSession(ctx.sessionKey);
  return `https://${sandbox.getHost(port)}`;
}

async function keepAliveE2b(
  ctx: SandboxExecContext,
  ms: number,
): Promise<void> {
  const sandbox = await connectSession(ctx.sessionKey);
  await sandbox.setTimeout(Math.max(IDLE_TIMEOUT_MS, ms));
}

/**
 * Open a shell in the sandbox and stream it.
 *
 * The tree is synced IN first so the shell starts on current sources, but not
 * back OUT: the session stays open and the user keeps typing, so there is no
 * moment that means "finished". Work leaves the sandbox the usual way, through
 * the syncs around ordinary commands.
 */
/**
 * Whether an error means the sandbox is gone rather than merely unhappy.
 *
 * E2B reports an expired or deleted sandbox as a plain "not found" on whatever
 * call happens to touch it next, so this is matched on the message.
 */
function isSandboxGone(message: string): boolean {
  return /sandbox was not found|sandbox is not running|not found: This error/i.test(
    message,
  );
}

async function openTerminalE2b(
  ctx: SandboxExecContext,
  // Take the options straight from the interface rather than restating them,
  // so adding one there cannot leave this signature quietly behind.
  opts: Parameters<SandboxProvider["openTerminal"]>[1],
): Promise<SandboxTerminal> {
  const sandbox = await connectSession(ctx.sessionKey);
  await sandbox.setTimeout(IDLE_TIMEOUT_MS);
  const cwd = path.posix.join(REMOTE_ROOT, opts.cwd);
  if (!cwd.startsWith(REMOTE_ROOT)) {
    throw new Error(
      `cwd escapes the session root: ${JSON.stringify(opts.cwd)}`,
    );
  }

  const handle = await sandbox.pty.create({
    cols: opts.cols,
    rows: opts.rows,
    cwd,
    user: SANDBOX_USER,
    onData: opts.onData,
    // Long enough that a shell left open over lunch is still there.
    timeoutMs: IDLE_TIMEOUT_MS,
    envs: {
      HOME: "/home/user",
      LANG: "C.UTF-8",
      // A real terminal, so colour and redrawing work — this is the whole
      // reason for a PTY over one-shot commands.
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
  });

  // Announce the shell's death exactly once, however we learn of it.
  let exited = false;
  const reportExit = (reason: string): void => {
    if (exited) return;
    exited = true;
    logger.info("Apps v2 terminal ended", { pid: handle.pid, reason });
    opts.onExit?.(reason);
  };
  // The pty exiting on its own — `exit`, ctrl-D, a crash — is the ordinary
  // case, and is not an error.
  void handle
    .wait()
    .then(() => reportExit("the shell exited"))
    .catch((error: unknown) =>
      reportExit(error instanceof Error ? error.message : String(error)),
    );

  // No shell handoff here on purpose. E2B's PTY starts bash, which is the
  // shell we want (see BASHRC in e2b-template.ts for the measurements behind
  // that), so the terminal is usable the moment it opens instead of after a
  // round trip that re-execs it.

  // Input is COALESCED and SERIALISED, the way VS Code's terminal queues
  // writes to its pty host.
  //
  // Each keystroke used to be its own RPC, fired without waiting for the last
  // one. Typing at speed then raced a dozen calls against each other: they
  // arrived out of order (so the line came out scrambled), and enough of them
  // at once exhausted the connection and dropped the session. One in-flight
  // write, with everything typed meanwhile merged into the next batch, fixes
  // both — and typing faster now means *fewer, larger* writes rather than more.
  let pending: Uint8Array[] = [];
  let draining: Promise<void> | null = null;
  // Bumped by interrupt(). The drain loop re-reads it between chunks and
  // abandons what it is writing if it has changed, which is the only way to
  // stop a paste already being written: by then the bytes have left `pending`
  // and live in a local buffer the queue can no longer reach.
  let epoch = 0;

  // Chunk size chosen from measurement, not intuition: sendInput costs
  // ~150-300ms REGARDLESS of payload size, because it is a round trip. Small
  // chunks are therefore ruinous — at 2KB a 100KB paste is 49 round trips and
  // takes ten seconds, which reads as a hung terminal. At 16KB it is seven.
  //
  // Not unbounded, because a pty's line discipline holds a limited buffer
  // (MAX_CANON, usually 4KB) for a line with no newline in it; handing it an
  // enormous single line in one write overflows and truncates. 16KB is the
  // compromise: few round trips, and small enough that the tty keeps up with
  // realistic multi-line content.
  const PTY_CHUNK = 16 * 1024;

  const drain = async (): Promise<void> => {
    try {
      while (pending.length > 0) {
        const batch = pending;
        pending = [];
        const total = batch.reduce((n, c) => n + c.length, 0);
        const merged = new Uint8Array(total);
        let at = 0;
        for (const chunk of batch) {
          merged.set(chunk, at);
          at += chunk.length;
        }
        const writingEpoch = epoch;
        for (let off = 0; off < merged.length; off += PTY_CHUNK) {
          // An interrupt while this was writing means the rest is input the
          // user has explicitly abandoned; sending it anyway would replay the
          // paste they just cancelled.
          if (epoch !== writingEpoch) break;
          const slice = merged.subarray(
            off,
            Math.min(off + PTY_CHUNK, merged.length),
          );
          try {
            const t0 = Date.now();
            // A bounded write. Without this, a pty whose input buffer has
            // filled leaves sendInput pending forever, and because the queue
            // is serial that one call silently stops every keystroke behind
            // it — the terminal looks dead with nothing in the logs.
            await sandbox.pty.sendInput(handle.pid, slice, {
              requestTimeoutMs: 15_000,
            });
            if (Date.now() - t0 > 3000) {
              // A slow write means the pty could not drain — worth knowing
              // about, because it is the shape a stalled terminal takes.
              logger.warn("Apps v2 pty write was slow", {
                bytes: slice.length,
                ms: Date.now() - t0,
              });
            }
          } catch (error) {
            // One failed chunk must not take the session with it. This is how
            // a large paste used to wedge a terminal permanently: the throw
            // escaped the drain loop, `draining` was never cleared, and every
            // subsequent keystroke joined a queue that would never run again.
            // Drop the chunk, keep the shell.
            const message =
              error instanceof Error ? error.message : String(error);
            // Unless the shell is gone for good, in which case carrying on
            // means logging one of these per keystroke forever while the user
            // stares at a terminal that will never answer.
            if (isSandboxGone(message)) {
              pending = [];
              reportExit("the sandbox this terminal was running in has gone");
              return;
            }
            logger.warn("Apps v2 pty input chunk failed; continuing", {
              bytes: slice.length,
              error: message,
            });
          }
        }
      }
    } finally {
      // ALWAYS release the queue, however we leave. A stuck `draining` is
      // indistinguishable from a dead terminal.
      draining = null;
      if (pending.length > 0) draining = drain();
    }
  };

  return {
    pid: handle.pid,
    write: async data => {
      pending.push(data);
      if (!draining) draining = drain();
      return draining;
    },
    interrupt: async () => {
      // Drop what has not reached the shell yet, both the queue and whatever
      // the drain loop is midway through. A chunk already in flight still
      // lands: that is one 16KB write, not a megabyte.
      epoch += 1;
      pending = [];
      // `\e[201~` first, in case the discarded input was a paste the shell is
      // still waiting to see the end of. Without it readline stays in paste
      // mode and silently swallows everything typed afterwards, which looks
      // exactly like a dead terminal and does not recover on reconnect.
      pending.push(new TextEncoder().encode("\x1b[201~\x03"));
      if (!draining) draining = drain();
      return draining;
    },
    resize: (cols, rows) => sandbox.pty.resize(handle.pid, { cols, rows }),
    close: async () => {
      await handle.kill().catch(() => undefined);
    },
  };
}

/**
 * Positive answers to "does a sandbox exist?", briefly.
 *
 * `hasSession` backs every read's live-or-committed decision, and without a
 * cache each file read in a fresh process is an E2B list API round trip. Only
 * YES is cached, and only for seconds: a stale yes degrades into one failed
 * exec, but a cached NO would freeze reads on the committed view after the
 * sandbox comes up.
 */
const knownAlive = new Map<string, number>();
const KNOWN_ALIVE_TTL_MS = 15_000;

/** Is a sandbox already up for this session? Never creates one. */
async function sessionExists(sessionKey: string): Promise<boolean> {
  if (sessions.has(sessionKey)) return true;
  if ((knownAlive.get(sessionKey) ?? 0) > Date.now()) return true;
  try {
    const paginator = Sandbox.list({
      apiKey: apiKey(),
      query: { metadata: { makoAppsV2SessionKey: sessionKey } },
      limit: 1,
    });
    const found = paginator.hasNext && (await paginator.nextItems()).length > 0;
    if (found) knownAlive.set(sessionKey, Date.now() + KNOWN_ALIVE_TTL_MS);
    return found;
  } catch {
    // Unreachable E2B is not the same as "no sandbox", but for the one caller
    // — should this read come from the working copy or the last commit? — the
    // committed answer is the safe one.
    return false;
  }
}

export const e2bSandboxProvider: SandboxProvider = {
  id: "e2b",
  exec: execE2b,
  execDetached: execDetachedE2b,
  root: () => REMOTE_ROOT,
  scratch: () => "/tmp",
  hasSession: ctx => sessionExists(ctx.sessionKey),
  writeFile: writeFileE2b,
  readFile: readFileE2b,
  openTerminal: openTerminalE2b,
  publicUrlForPort: publicUrlForPortE2b,
  keepAlive: keepAliveE2b,
  destroySession: async sessionKey => {
    const sandboxId = sessions.get(sessionKey);
    sessions.delete(sessionKey);
    knownAlive.delete(sessionKey);
    if (sandboxId) {
      await Sandbox.kill(sandboxId, { apiKey: apiKey() }).catch(
        () => undefined,
      );
    }
  },
};
