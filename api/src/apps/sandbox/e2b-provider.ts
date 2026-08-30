/**
 * E2B sandbox provider — Firecracker microVM execution for Apps.
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
  APPS_EXEC_DEFAULT_TIMEOUT_MS,
  APPS_EXEC_MAX_OUTPUT_BYTES,
  APPS_EXEC_MAX_TIMEOUT_MS,
  appsE2BTemplateEnv,
} from "../config";
import { loggers } from "../../logging";
import type {
  SandboxTerminal,
  SandboxExecContext,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxProvider,
} from "./provider";

const logger = loggers.api("apps-e2b");

/** Read at call time (not module load) so dotenv ordering can't freeze it. */
function templateId(): string {
  return appsE2BTemplateEnv()?.trim() || "base";
}
const SANDBOX_USER = "user";
const REMOTE_ROOT = "/home/user/app";
/** Idle window before E2B auto-pauses the sandbox (resets on activity). */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function apiKey(): string {
  const key = process.env.E2B_API_KEY;
  if (!key) {
    throw new Error(
      "E2B_API_KEY is not set — configure it or use APPS_SANDBOX_PROVIDER=local for development",
    );
  }
  return key;
}

// In-process session affinity: worktreeId -> sandboxId. Repaired lazily via
// Sandbox.list metadata when the process restarts.
const sessions = new Map<string, string>();

/** The canonical box among duplicates for a key: OLDEST, sandboxId as a
 *  deterministic tiebreak so every process/instance picks the SAME winner.
 *
 *  Oldest, not newest: the established box is the one holding the user's
 *  uncommitted working copy, while a newer duplicate is by construction a
 *  mistake made later (a create race, a convergence miss). Newest-wins had
 *  the failure mode of a freshly created EMPTY box beating — and killing —
 *  the box with the user's work in it. */
function pickWinner<T extends { sandboxId: string; startedAt?: string | Date }>(
  boxes: T[],
): T | undefined {
  return [...boxes].sort((a, b) => {
    const byTime =
      new Date(a.startedAt ?? 0).getTime() -
      new Date(b.startedAt ?? 0).getTime();
    if (byTime !== 0) return byTime;
    return a.sandboxId < b.sandboxId ? -1 : 1;
  })[0];
}

/**
 * After creating a box, make sure it is the ONLY one for its key. A create in
 * another API instance (the single-flight map is per-process) can race this
 * one; both processes independently pick the same winner via pickWinner and
 * kill the rest, so they converge on one box even though neither saw the
 * other's create. Best effort: a lookup failure just keeps the box we made.
 */
async function convergeToSingle(
  sessionKey: string,
  created: Sandbox,
): Promise<Sandbox> {
  try {
    const paginator = Sandbox.list({
      apiKey: apiKey(),
      query: { metadata: { makoAppsSessionKey: sessionKey } },
      limit: 10,
    });
    if (!paginator.hasNext) return created;
    const page = [...(await paginator.nextItems())];
    if (page.length <= 1) return created;
    const winner = pickWinner(page);
    if (!winner || winner.sandboxId === created.sandboxId) {
      for (const box of page) {
        if (box.sandboxId === created.sandboxId) continue;
        void Sandbox.kill(box.sandboxId, { apiKey: apiKey() }).catch(
          () => undefined,
        );
      }
      logger.warn("Converged duplicate sandboxes to one (kept the new box)", {
        sessionKey,
        kept: created.sandboxId,
        killed: page
          .filter(b => b.sandboxId !== created.sandboxId)
          .map(b => b.sandboxId),
      });
      return created;
    }
    // Another instance's box wins the tiebreak; drop ours and adopt it.
    void Sandbox.kill(created.sandboxId, { apiKey: apiKey() }).catch(
      () => undefined,
    );
    logger.warn("Converged duplicate sandboxes to one (adopted the winner)", {
      sessionKey,
      adopted: winner.sandboxId,
      dropped: created.sandboxId,
    });
    return await Sandbox.connect(winner.sandboxId, { apiKey: apiKey() });
  } catch (error) {
    logger.warn("Sandbox convergence failed; using the box we created", {
      sessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return created;
  }
}

/**
 * One box per (workspace, user): concurrent callers for a cold session share
 * ONE connect/create instead of each racing to `Sandbox.create`.
 *
 * connectSession is called from every exec/read entry point, not just through
 * ensureBox — so without this, two requests that arrive before the session id
 * is cached each list (find nothing), each create, and the account grows a
 * duplicate box for the same worktree. The single-flight collapses them; the
 * post-create convergence in connectSessionNow handles the cross-INSTANCE race
 * this map cannot see.
 */
const connecting = new Map<string, Promise<Sandbox>>();

function connectSession(sessionKey: string): Promise<Sandbox> {
  const inflight = connecting.get(sessionKey);
  if (inflight) return inflight;
  const run = connectSessionNow(sessionKey).finally(() =>
    connecting.delete(sessionKey),
  );
  connecting.set(sessionKey, run);
  return run;
}

async function connectSessionNow(sessionKey: string): Promise<Sandbox> {
  const known = sessions.get(sessionKey);
  if (known) {
    try {
      return await Sandbox.connect(known, { apiKey: apiKey() });
    } catch {
      sessions.delete(sessionKey);
    }
  }
  // Recover a paused/running sandbox for this worktree if one exists. A
  // lookup FAILURE must throw, not fall through to create: "the list API
  // blipped" is not "no box exists", and creating on a blip made a fresh
  // empty duplicate whose later convergence could kill the user's real box.
  let page: Array<{ sandboxId: string; startedAt?: string | Date }> = [];
  const paginator = Sandbox.list({
    apiKey: apiKey(),
    query: { metadata: { makoAppsSessionKey: sessionKey } },
    limit: 5,
  });
  if (paginator.hasNext) page = [...(await paginator.nextItems())];
  if (page.length > 0) {
    // Deterministic choice when the key matches more than one sandbox.
    // Duplicates happen: two API processes (a dev machine and a preview
    // deployment share one E2B account and one database) can each create a
    // box for the same worktree, and page order is not a contract — so
    // without sorting, WHICH working copy answered depended on the whim of
    // a list API. pickWinner (oldest) decides, always, everywhere.
    const info = pickWinner(page);
    const stale = page.filter(x => x.sandboxId !== info?.sandboxId);
    if (stale.length > 0) {
      logger.warn("Multiple sandboxes share one session key; converging", {
        sessionKey,
        using: info?.sandboxId,
        killing: stale.map(x => x.sandboxId),
      });
      // Reap the losers, don't just ignore them: a winner without a
      // reaper is how the account quietly accumulated a hundred boxes —
      // every duplicate (two API processes, a create racing a pause, an
      // API restart mid-create) stayed alive forever, billed and
      // confusing every list-based lookup after it.
      for (const dupe of stale) {
        void Sandbox.kill(dupe.sandboxId, { apiKey: apiKey() }).catch(
          () => undefined,
        );
      }
    }
    if (info) {
      try {
        const sandbox = await Sandbox.connect(info.sandboxId, {
          apiKey: apiKey(),
        });
        sessions.set(sessionKey, sandbox.sandboxId);
        return sandbox;
      } catch (error) {
        // The listed box is really gone (killed between list and connect):
        // fall through to a fresh create.
        logger.warn("Listed sandbox would not connect; creating fresh", {
          sessionKey,
          sandboxId: info.sandboxId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const sandbox = await Sandbox.create(templateId(), {
    apiKey: apiKey(),
    timeoutMs: IDLE_TIMEOUT_MS,
    metadata: { makoAppsSessionKey: sessionKey },
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
  // A concurrent create in another API instance may have made a second box
  // for this key; reduce to one deterministically before anyone uses it.
  const winner = await convergeToSingle(sessionKey, sandbox);
  sessions.set(sessionKey, winner.sandboxId);
  logger.info("E2B sandbox created", {
    sessionKey,
    sandboxId: winner.sandboxId,
  });
  return winner;
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
    Math.max(1_000, options.timeoutMs ?? APPS_EXEC_DEFAULT_TIMEOUT_MS),
    APPS_EXEC_MAX_TIMEOUT_MS,
  );
  const startedAt = Date.now();
  const sandbox = await connectSession(ctx.sessionKey);
  // Keep the sandbox alive long enough for this command + sync overhead —
  // without clobbering a longer hold someone asked keepAlive() for.
  await sandbox.setTimeout(
    lifetimeMs(ctx.sessionKey, Math.max(IDLE_TIMEOUT_MS, timeoutMs + 60_000)),
  );

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
  const cap = APPS_EXEC_MAX_OUTPUT_BYTES;
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
  await sandbox.setTimeout(lifetimeMs(ctx.sessionKey, IDLE_TIMEOUT_MS));
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

/**
 * The public URL for a port IF a sandbox already exists — never creates one.
 *
 * publicUrlForPort goes through connectSession, whose cold path is
 * Sandbox.create. Called from a straggler box event after a recycle, that
 * booted a fresh billed microVM just to compute a hostname and flipped every
 * tab back to "online". Status/telemetry paths must use this instead.
 */
async function peekPublicUrlForPortE2b(
  ctx: SandboxExecContext,
  port: number,
): Promise<string | null> {
  const known = sessions.get(ctx.sessionKey);
  if (known) {
    try {
      const sandbox = await Sandbox.connect(known, { apiKey: apiKey() });
      return `https://${sandbox.getHost(port)}`;
    } catch {
      sessions.delete(ctx.sessionKey);
    }
  }
  try {
    const paginator = Sandbox.list({
      apiKey: apiKey(),
      query: { metadata: { makoAppsSessionKey: ctx.sessionKey } },
      limit: 5,
    });
    if (!paginator.hasNext) return null;
    const info = pickWinner([...(await paginator.nextItems())]);
    if (!info) return null;
    const sandbox = await Sandbox.connect(info.sandboxId, {
      apiKey: apiKey(),
    });
    sessions.set(ctx.sessionKey, sandbox.sandboxId);
    return `https://${sandbox.getHost(port)}`;
  } catch {
    return null;
  }
}

/**
 * keepAlive holds are remembered here because E2B's setTimeout is an
 * ABSOLUTE remaining lifetime: the next exec's routine setTimeout silently
 * clobbered a 30-minute hold back down to 10, pausing the box mid-viewing.
 * Every setTimeout call goes through lifetimeMs so the hold is a floor.
 */
const keepAliveUntil = new Map<string, number>();

function lifetimeMs(sessionKey: string, base: number): number {
  const until = keepAliveUntil.get(sessionKey) ?? 0;
  return Math.max(base, until - Date.now());
}

async function keepAliveE2b(
  ctx: SandboxExecContext,
  ms: number,
): Promise<void> {
  const sandbox = await connectSession(ctx.sessionKey);
  keepAliveUntil.set(ctx.sessionKey, Date.now() + Math.max(0, ms));
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
  await sandbox.setTimeout(lifetimeMs(ctx.sessionKey, IDLE_TIMEOUT_MS));
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
    logger.info("Apps terminal ended", { pid: handle.pid, reason });
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
              logger.warn("Apps pty write was slow", {
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
            logger.warn("Apps pty input chunk failed; continuing", {
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
      query: { metadata: { makoAppsSessionKey: sessionKey } },
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
  describe: async ctx => {
    try {
      const paginator = Sandbox.list({
        apiKey: apiKey(),
        query: { metadata: { makoAppsSessionKey: ctx.sessionKey } },
        limit: 5,
      });
      if (!paginator.hasNext) return null;
      const page = await paginator.nextItems();
      const [info] = [...page].sort(
        (a, b) =>
          new Date(b.startedAt ?? 0).getTime() -
          new Date(a.startedAt ?? 0).getTime(),
      );
      if (!info) return null;
      return {
        sandboxId: info.sandboxId,
        startedAt: info.startedAt ? String(info.startedAt) : null,
      };
    } catch {
      return null;
    }
  },
  writeFile: writeFileE2b,
  readFile: readFileE2b,
  openTerminal: openTerminalE2b,
  publicUrlForPort: publicUrlForPortE2b,
  peekPublicUrlForPort: peekPublicUrlForPortE2b,
  keepAlive: keepAliveE2b,
  destroySession: async sessionKey => {
    const sandboxId = sessions.get(sessionKey);
    sessions.delete(sessionKey);
    knownAlive.delete(sessionKey);
    keepAliveUntil.delete(sessionKey);
    // The in-process map is only THIS instance's memory: after an API
    // restart (or when another instance created the box) it is empty, and a
    // recycle that kills nothing while broadcasting "offline" is a lie every
    // tab believes — the next touch rediscovers the same, un-killed box. The
    // metadata index is the durable truth; kill everything it names.
    const ids = new Set<string>(sandboxId ? [sandboxId] : []);
    try {
      const paginator = Sandbox.list({
        apiKey: apiKey(),
        query: { metadata: { makoAppsSessionKey: sessionKey } },
        limit: 10,
      });
      if (paginator.hasNext) {
        for (const box of await paginator.nextItems()) ids.add(box.sandboxId);
      }
    } catch (error) {
      logger.warn(
        "Recycle could not list sandboxes by metadata; killing known id only",
        {
          sessionKey,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    await Promise.all(
      [...ids].map(id =>
        Sandbox.kill(id, { apiKey: apiKey() }).catch(() => undefined),
      ),
    );
  },
};
