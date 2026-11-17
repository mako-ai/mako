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
import {
  ConnectionConfig,
  FileNotFoundError,
  Sandbox,
  SandboxNotFoundError,
  SandboxNotRunningError,
  SandboxUnreachableError,
} from "e2b";
import { clearBoxResume, noteBoxResume } from "../box-activity";
import {
  APPS_EXEC_DEFAULT_TIMEOUT_MS,
  APPS_EXEC_MAX_OUTPUT_BYTES,
  APPS_EXEC_MAX_TIMEOUT_MS,
  appsE2BTemplateEnv,
} from "../config";
import { loggers } from "../../logging";
import type {
  SandboxBoxLifecycle,
  SandboxTerminal,
  SandboxExecContext,
  SandboxExecOptions,
  SandboxFileOptions,
  SandboxExecResult,
  SandboxProvider,
} from "./provider";
import { viteAllowedHostEnv } from "./e2b-domain";
import { commandToRun } from "./hidden-command";

const logger = loggers.api("apps-e2b");

/** Read at call time (not module load) so dotenv ordering can't freeze it. */
function templateId(): string {
  return appsE2BTemplateEnv()?.trim() || "base";
}
const SANDBOX_USER = "user";
/**
 * Root, for the connector sync box's own setup commands only (per-run Unix
 * users and their run directories). See SandboxExecOptions.asRoot.
 */
const ROOT_USER = "root";
const userFor = (options?: { asRoot?: boolean }): string =>
  options?.asRoot ? ROOT_USER : SANDBOX_USER;
const REMOTE_ROOT = "/home/user/app";
/**
 * E2B's own idle timeout: the BACKSTOP, not the policy. The idle sweep
 * (box-idle.service.ts) pauses after 10 minutes of real use; this sits above
 * it (15) so E2B pausing on its own never races the sweep, and a box that
 * escaped the sweep (cron down) still sleeps.
 */
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

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

/**
 * The template a session's FIRST create should use instead of the configured
 * one: a connector box restored from its snapshot (boxLifecycle.create).
 */
const templateOverrides = new Map<string, string>();

/**
 * Connect, and refuse a sandbox other than the one the caller pinned.
 * Never creates a box for a pinned call: a pinned box that is gone is gone.
 */
async function connectPinned(
  sessionKey: string,
  expectSandboxId: string | undefined,
): Promise<Sandbox> {
  if (!expectSandboxId) return connectSession(sessionKey);
  // Always straight to the pinned sandbox, never through connectSession:
  // that path swallows connect errors, lists, and may create or converge to
  // another box, so a 503 there could surface as "gone" and let a run's
  // cleanup count a live box (and its credential) as cleaned.
  try {
    return await Sandbox.connect(expectSandboxId, { apiKey: apiKey() });
  } catch (error) {
    // Only a box E2B says is gone is gone. A timeout or a 5xx is not an
    // answer: rethrown as-is, so the cleanup fails and the box is retired.
    if (!isSandboxGone(error)) throw error;
    throw new SandboxNotFoundError(
      `Sandbox ${expectSandboxId} for ${sessionKey} was replaced or is gone.`,
    );
  }
}

/** Keys boxLifecycle.create is creating right now: the only ones allowed to. */
const creatingBoxes = new Set<string>();

/** Leased connector boxes (connectors/workspace/boxes/box-provider.ts). */
export function isConnectorBoxKey(sessionKey: string): boolean {
  return sessionKey.startsWith("connector-box:");
}

/**
 * Which boxes take public traffic on their ports. E2B now secures every new
 * box's ports behind a traffic access token by default, and a browser iframe
 * cannot send that header, so app previews answered 403. A person's app box
 * (`<workspaceId>:<userId>`) serves those previews and opts out of the
 * token. Its ports are public at an unguessable `<port>-<sandboxId>` host, as
 * they were before 16 Nov 2026.
 *
 * Everything else keeps E2B's secured default because it serves no browser:
 * connector boxes (`connector-box:`, `connector-build:`, `connector-sync:`)
 * and the `<workspaceId>:publish` build box.
 */
export function allowsPublicTraffic(sessionKey: string): boolean {
  const at = sessionKey.indexOf(":");
  if (at <= 0 || at === sessionKey.length - 1) return false;
  if (!/^[0-9a-f]{24}$/.test(sessionKey.slice(0, at))) return false;
  return sessionKey.slice(at + 1) !== "publish";
}

/**
 * The first two frames outside this file and node_modules: which code path
 * connected to (and so possibly resumed) a box. Recorded per session for the
 * idle sweep's safety valve, which names it when a box keeps waking up
 * without anyone using it.
 */
function connectCaller(): string {
  const frames = (new Error().stack ?? "")
    .split("\n")
    .slice(1)
    .map(line => line.trim())
    .filter(
      line =>
        line.startsWith("at ") &&
        !line.includes("e2b-provider") &&
        !line.includes("node_modules") &&
        !line.includes("node:internal"),
    )
    .slice(0, 2)
    .map(line =>
      line
        .replace(/^at /, "")
        .replace(/\(?\/.*\/api\/src\//, "(")
        .replace(/^\/.*\/api\/src\//, ""),
    );
  return frames.join(" < ") || "unknown";
}

function connectSession(sessionKey: string): Promise<Sandbox> {
  const inflight = connecting.get(sessionKey);
  if (inflight) return inflight;
  // After the in-flight check, so a burst records once; and only the first
  // connect after a pause sticks (box-activity.ts noteBoxResume).
  noteBoxResume(sessionKey, connectCaller);
  const run = connectSessionNow(sessionKey).finally(() => {
    connecting.delete(sessionKey);
    // A connect resumes a paused box: "not running" no longer holds, nor
    // does the answer of a lookup that went out before it.
    runningAnswer.delete(sessionKey);
    runningLookups.delete(sessionKey);
  });
  connecting.set(sessionKey, run);
  return run;
}

/**
 * Pinned-only mode, for maintenance scripts that walk existing boxes (the
 * E2B workspace move's pre-save pass, api/src/scripts/e2b-presave-sessions.ts).
 *
 * Normal connectSession repairs what it finds: it lists by metadata, kills
 * duplicate boxes and creates a fresh one when nothing answers. A script that
 * visits someone's paused box must do none of that. In this mode a session
 * only ever reaches the exact box pinned for it; anything else throws.
 */
let pinnedOnly = false;

export function useE2bPinnedSessionsOnly(): void {
  pinnedOnly = true;
}

/** Address `sessionKey` to this exact box (used with pinned-only mode). */
export function pinE2bSession(sessionKey: string, sandboxId: string): void {
  rememberSession(sessionKey, sandboxId);
}

/** Test seam: forget every in-process session and leave pinned-only mode. */
export function resetE2bProviderStateForTests(): void {
  pinnedOnly = false;
  held.clear();
  sessions.clear();
  connecting.clear();
  knownAlive.clear();
  knownAbsent.clear();
  keepAliveUntil.clear();
  runningAnswer.clear();
  runningLookups.clear();
}

async function connectSessionNow(sessionKey: string): Promise<Sandbox> {
  const known = sessions.get(sessionKey);
  if (pinnedOnly) {
    if (!known) {
      throw new Error(
        `Pinned-only mode: no sandbox is pinned for session ${sessionKey}`,
      );
    }
    return Sandbox.connect(known, { apiKey: apiKey() });
  }
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
        rememberSession(sessionKey, sandbox.sandboxId);
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

  // A leased connector box is created only by its scheduler
  // (boxLifecycle.create). Anything else reaching here means the box was
  // killed under a run; recreating it would make a box no record tracks
  // and no reaper ever kills.
  if (isConnectorBoxKey(sessionKey) && !creatingBoxes.has(sessionKey)) {
    throw new SandboxNotFoundError(
      `Connector box ${sessionKey} is gone; only its scheduler may create it.`,
    );
  }
  const sandbox = await Sandbox.create(
    templateOverrides.get(sessionKey) ?? templateId(),
    {
      apiKey: apiKey(),
      timeoutMs: IDLE_TIMEOUT_MS,
      metadata: { makoAppsSessionKey: sessionKey },
      // App boxes only: previews load in a browser iframe, which cannot send
      // E2B's traffic access token. See allowsPublicTraffic.
      ...(allowsPublicTraffic(sessionKey)
        ? { network: { allowPublicTraffic: true } }
        : {}),
      // Pause WITH MEMORY on idle: the sandbox is a stateful computer now —
      // tmux sessions, per-app dev servers, a user's running processes — so
      // idling must be sleep, not death. A full memory snapshot means resume
      // restores every process exactly where it was: reopening the page after
      // a night away reattaches to the same dev server and the same shells
      // instead of cold-booting (fs-only snapshots reboot the VM on resume,
      // which is how "why did my dev server restart overnight" happened).
      // Resume is explicit via Sandbox.connect() in connectSession; a sandbox
      // that is fully dead still falls through to a fresh create + hydrate.
      // One-shot boxes (connector builds) are killed instead: see below.
      lifecycle: { onTimeout: onTimeoutFor(sessionKey) },
    },
  );
  await sandbox.commands.run(`mkdir -p ${REMOTE_ROOT}`, {
    user: SANDBOX_USER,
  });
  // A concurrent create in another API instance may have made a second box
  // for this key; reduce to one deterministically before anyone uses it.
  const winner = await convergeToSingle(sessionKey, sandbox);
  rememberSession(sessionKey, winner.sandboxId);
  logger.info("E2B sandbox created", {
    sessionKey,
    sandboxId: winner.sandboxId,
  });
  return winner;
}

// ---------------------------------------------------------------------------
// Held handles
// ---------------------------------------------------------------------------

/**
 * One connected `Sandbox` handle per session, reused across calls.
 *
 * Every call used to start with `Sandbox.connect`, and every exec with
 * `setTimeout` as well: an exec cost 3 round trips to E2B and a file transfer
 * 2. A connector chunk made 8 provider calls, 20 round trips, about 3.7 s
 * (bench/g1/RESULTS.md). A handle stays valid while its box runs, so it is
 * held, and `connect` happens only when there is no handle or the box may
 * have paused since.
 *
 * `deadline` is when E2B will pause the box, as of the last `setTimeout` this
 * process made. A handle is trusted until shortly before it. A handle whose
 * deadline is unknown (it came from a `connect` with no `setTimeout` after
 * it) is trusted for HANDLE_TTL_MS only.
 *
 * Another API instance can still pause or kill the box under a held handle.
 * Any failure that is not a command's own result then drops the handle, so
 * the next call connects again (which resumes a paused box, as the old
 * per-call `connect` did). Whether the failed call itself is retried depends
 * on whether it can have run: see `withSandbox`.
 */
interface HeldSandbox {
  sandbox: Sandbox;
  deadline: number | null;
  /** When this process last called `setTimeout` on it. */
  lifetimeSetAt: number;
  connectedAt: number;
}

const held = new Map<string, HeldSandbox>();

/** How long a handle with an unknown deadline is trusted without a connect. */
const HANDLE_TTL_MS = 30_000;
/** A handle is not used this close to the box's known pause time. */
const DEADLINE_MARGIN_MS = 5_000;
/**
 * `setTimeout` is skipped while the box's remaining lifetime is within this
 * much of the lifetime a call wants. Each exec used to reset it exactly, so
 * a box paused 10 minutes after its last command; now it pauses 9 to 10
 * minutes after it, for one `setTimeout` a minute instead of one per call.
 */
const LIFETIME_SLACK_MS = 60_000;

function heldUsable(entry: HeldSandbox, now: number): boolean {
  return entry.deadline !== null
    ? now < entry.deadline - DEADLINE_MARGIN_MS
    : now < entry.connectedAt + HANDLE_TTL_MS;
}

function dropHandle(sessionKey: string, sandbox?: Sandbox): void {
  const entry = held.get(sessionKey);
  if (!entry) return;
  if (sandbox && entry.sandbox !== sandbox) return;
  held.delete(sessionKey);
}

/**
 * Set the box's remaining lifetime to `lifetime`, unless it is already
 * within LIFETIME_SLACK_MS of that and at least `floor` (the time the call
 * itself may take). Shortening is kept on purpose: the old per-exec
 * `setTimeout` also brought a long hold back down once the long command was
 * done, and keepAlive holds are already folded into `lifetime`.
 */
async function ensureLifetime(
  sessionKey: string,
  entry: HeldSandbox,
  lifetime: number,
  floor = 0,
): Promise<void> {
  const now = Date.now();
  // The cached deadline is only what THIS process set. Another API instance
  // can shorten the real timeout behind it (its routine exec knows nothing
  // of our keepAlive hold). So it is trusted for one slack window after it
  // was written, and never while this process holds a keepAlive: then every
  // call re-applies the hold, as every exec did before.
  const holding = (keepAliveUntil.get(sessionKey) ?? 0) > now;
  if (entry.deadline !== null && !holding) {
    const remaining = entry.deadline - now;
    if (
      now - entry.lifetimeSetAt < LIFETIME_SLACK_MS &&
      remaining >= floor &&
      Math.abs(remaining - lifetime) <= LIFETIME_SLACK_MS
    ) {
      return;
    }
  }
  await entry.sandbox.setTimeout(lifetime);
  entry.deadline = now + lifetime;
  entry.lifetimeSetAt = now;
}

/**
 * The session's held handle, connecting only when there is none or it may
 * have gone stale. `reused` says whether a connect was skipped.
 */
async function heldSandbox(
  sessionKey: string,
  expectSandboxId?: string,
): Promise<{ entry: HeldSandbox; reused: boolean }> {
  const current = held.get(sessionKey);
  if (
    current &&
    heldUsable(current, Date.now()) &&
    (!expectSandboxId || current.sandbox.sandboxId === expectSandboxId)
  ) {
    return { entry: current, reused: true };
  }
  // A pinned call never runs in a box other than the one it pinned. When the
  // held handle names another box, the pinned one is not thereby gone (the
  // key may have moved while it still runs, holding a run's files): ask E2B
  // for it below, which says "gone" only on a real not-found.
  const sandbox = await connectPinned(sessionKey, expectSandboxId);
  const now = Date.now();
  // A pinned box the session key no longer names is used, but not held:
  // the held handle is the key's current box.
  if (sessions.get(sessionKey) !== sandbox.sandboxId) {
    return {
      entry: { sandbox, deadline: null, lifetimeSetAt: 0, connectedAt: now },
      reused: false,
    };
  }
  let entry = held.get(sessionKey);
  if (!entry || entry.sandbox !== sandbox) {
    // Handles nobody can use any more are dropped as new ones arrive, so an
    // instance that served thousands of sessions holds only the live ones.
    for (const [key, other] of held) {
      if (!heldUsable(other, now)) held.delete(key);
    }
    entry = { sandbox, deadline: null, lifetimeSetAt: 0, connectedAt: now };
    held.set(sessionKey, entry);
  }
  return { entry, reused: false };
}

/**
 * A command that the box provably never accepted: the request to start it
 * failed before envd answered with a pid. Only such a command may be sent
 * again; one that started may still be running, or resume with its box.
 */
class CommandNotStartedError extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original));
    this.name = "CommandNotStartedError";
  }
}

const unwrapNotStarted = (error: unknown): unknown =>
  error instanceof CommandNotStartedError ? error.original : error;

/** The SDK's errors for a box that is gone, paused or unreachable. */
const BOX_ERROR_NAMES = new Set([
  "SandboxNotFoundError",
  "SandboxNotRunningError",
  "SandboxUnreachableError",
]);

/** Walk an error and its causes, as the SDK wraps transport failures. */
function someInChain(
  error: unknown,
  test: (link: { name?: unknown; message?: unknown }) => boolean,
): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (test(current as { name?: unknown; message?: unknown })) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The SDK's "no such file": an answer from a live box, not a box failure. */
function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof FileNotFoundError ||
    (error as { name?: unknown } | null)?.name === "FileNotFoundError"
  );
}

/** Any error that says the box, not the call, is the problem. */
export function isBoxConnectionError(error: unknown): boolean {
  return (
    isSandboxGone(error) ||
    someInChain(
      error,
      link =>
        link instanceof SandboxNotRunningError ||
        link instanceof SandboxUnreachableError ||
        BOX_ERROR_NAMES.has(String(link.name)),
    )
  );
}

/**
 * The request never reached a running box: E2B's API or proxy answered that
 * the sandbox does not exist. Not true of "killed while the request was in
 * flight" (the box may have taken it) or of an unreachable box (state
 * unknown), so neither of those makes a command safe to send again.
 */
export function neverReachedBox(error: unknown): boolean {
  return someInChain(error, link => {
    const name = String(link.name);
    const message = String(link.message ?? "");
    if (
      link instanceof SandboxNotFoundError ||
      name === "SandboxNotFoundError"
    ) {
      return true;
    }
    if (
      link instanceof SandboxNotRunningError ||
      name === "SandboxNotRunningError"
    ) {
      return !/while the request was in flight/i.test(message);
    }
    return false;
  });
}

/**
 * How a failed call may be retried on a fresh connect.
 * - `idempotent`: file transfers, `setTimeout`: sending them twice is safe.
 * - `unstarted-only`: commands and shells: only when the box never accepted
 *   them (`CommandNotStartedError` around a `neverReachedBox` error).
 */
type RetryPolicy = "idempotent" | "unstarted-only";

/**
 * Run `fn` on the session's sandbox, after making sure it has `lifetime`
 * left when one is given.
 *
 * Any error from a HELD handle drops it, whatever the error says: a stale
 * handle must never be reused until its deadline. Errors that say the box is
 * gone also forget the session. Then the call is retried once on a fresh
 * connect, but only when that cannot run anything twice (see RetryPolicy).
 * A failure on a fresh connect is final, as before.
 */
async function withSandbox<T>(
  sessionKey: string,
  lifetime: number | undefined,
  fn: (sandbox: Sandbox) => Promise<T>,
  options: {
    floor?: number;
    policy?: RetryPolicy;
    /** Refuse any box but this one (SandboxExecOptions.expectSandboxId). */
    expectSandboxId?: string;
  } = {},
): Promise<T> {
  const floor = options.floor ?? 0;
  const policy = options.policy ?? "idempotent";
  const pin = options.expectSandboxId;
  const { entry, reused } = await heldSandbox(sessionKey, pin);
  let phase: "lifetime" | "call" = "lifetime";
  try {
    if (lifetime !== undefined) {
      await ensureLifetime(sessionKey, entry, lifetime, floor);
    }
    phase = "call";
    return await fn(entry.sandbox);
  } catch (error) {
    // A missing file says nothing about the box: keep the handle, and spare
    // the next call a connect (about 176 ms).
    if (reused && !isFileNotFound(unwrapNotStarted(error))) {
      dropHandle(sessionKey, entry.sandbox);
    }
    if (isSandboxGone(unwrapNotStarted(error))) forgetSession(sessionKey);
    const retry =
      reused &&
      (phase === "lifetime" || policy === "idempotent"
        ? isBoxConnectionError(unwrapNotStarted(error))
        : error instanceof CommandNotStartedError &&
          neverReachedBox(error.original));
    if (!retry) throw unwrapNotStarted(error);
    // With a pin, the retry reconnects to the pinned box or fails: it never
    // moves to a replacement.
    const fresh = await heldSandbox(sessionKey, pin);
    try {
      if (lifetime !== undefined) {
        await ensureLifetime(sessionKey, fresh.entry, lifetime, floor);
      }
      return await fn(fresh.entry.sandbox);
    } catch (again) {
      if (isBoxConnectionError(unwrapNotStarted(again))) {
        dropHandle(sessionKey, fresh.entry.sandbox);
      }
      throw unwrapNotStarted(again);
    }
  }
}

/** Test hook: how many handles this process holds. */
export function heldSandboxCountForTests(): number {
  return held.size;
}

/** Test hook: forget every held handle and lifetime. */
export function resetHeldSandboxesForTests(): void {
  held.clear();
  keepAliveUntil.clear();
  sessions.clear();
  knownAlive.clear();
  knownAbsent.clear();
}

// ---------------------------------------------------------------------------
// Exec
// ---------------------------------------------------------------------------

type CommandStartOptions = NonNullable<
  Parameters<Sandbox["commands"]["run"]>[1]
>;

/** Start a command; a failure to start is a CommandNotStartedError. */
async function startCommand(
  sandbox: Sandbox,
  command: string,
  options: Omit<CommandStartOptions, "background">,
) {
  try {
    return await sandbox.commands.run(command, {
      ...options,
      background: true,
    });
  } catch (error) {
    throw new CommandNotStartedError(error);
  }
}

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

  const cwd = options.cwd
    ? path.posix.join(REMOTE_ROOT, options.cwd)
    : REMOTE_ROOT;
  if (!cwd.startsWith(REMOTE_ROOT)) {
    throw new Error(
      `cwd escapes the session root: ${JSON.stringify(options.cwd)}`,
    );
  }

  const run = async (
    sandbox: Sandbox,
  ): Promise<Omit<SandboxExecResult, "durationMs">> => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let exitCode: number;
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

    // Started and awaited in two steps, so a failure can be told apart: one
    // before envd accepted the command (it never ran) from one after (it may
    // still be running). Only the first may be retried; see withSandbox.
    const run = commandToRun(command, options);
    const handle = await startCommand(sandbox, run.command, {
      user: userFor(options),
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
        // A `vite` the agent starts by hand accepts the preview origin.
        ...viteAllowedHostEnv(),
        ...run.env,
      },
      onStdout: d => push("out", d),
      onStderr: d => push("err", d),
    });
    try {
      const result = await handle.wait();
      exitCode = result.exitCode;
    } catch (error) {
      // e2b throws CommandExitError on non-zero exit and TimeoutError on
      // deadline; normalize both into the result contract. Anything else
      // propagates, so withSandbox can tell a gone box from a failed command.
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
      truncated,
      sandboxId: sandbox.sandboxId,
    };
  };

  try {
    // Keep the sandbox alive long enough for this command + sync overhead —
    // without clobbering a longer hold someone asked keepAlive() for.
    const result = await withSandbox(
      ctx.sessionKey,
      lifetimeMs(ctx.sessionKey, Math.max(IDLE_TIMEOUT_MS, timeoutMs + 60_000)),
      run,
      {
        // The box must outlive this command whatever the slack allows.
        floor: timeoutMs + DEADLINE_MARGIN_MS,
        policy: "unstarted-only",
        expectSandboxId: options.expectSandboxId,
      },
    );
    return { ...result, durationMs: Date.now() - startedAt };
  } catch (error) {
    // The box is gone, not busy: drop the remembered session so the next
    // `hasSession` asks E2B instead of repeating this instance's stale
    // "yes" — otherwise every later discovery call execs into nothing and
    // throws again. The error still propagates; callers that promise an
    // empty answer rather than a failure catch it themselves.
    if (isSandboxGone(error)) forgetSession(ctx.sessionKey);
    throw error;
  }
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
  const cwd = options.cwd
    ? path.posix.join(REMOTE_ROOT, options.cwd)
    : REMOTE_ROOT;
  if (!cwd.startsWith(REMOTE_ROOT)) {
    throw new Error(
      `cwd escapes the session root: ${JSON.stringify(options.cwd)}`,
    );
  }
  const result = await withSandbox(
    ctx.sessionKey,
    lifetimeMs(ctx.sessionKey, IDLE_TIMEOUT_MS),
    async sandbox => {
      const handle = await startCommand(sandbox, command, {
        user: SANDBOX_USER,
        cwd,
        timeoutMs: 60_000,
        envs: {
          HOME: "/home/user",
          LANG: "C.UTF-8",
          TERM: "dumb",
          CI: "1",
          ...viteAllowedHostEnv(),
          ...(options.env ?? {}),
        },
      });
      try {
        return await handle.wait();
      } catch (error) {
        // A non-zero exit of the launching shell is a result, as before.
        const exit = error as { exitCode?: number; stderr?: string };
        if (typeof exit.exitCode === "number") {
          return { exitCode: exit.exitCode, stderr: exit.stderr ?? "" };
        }
        throw error;
      }
    },
    { policy: "unstarted-only" },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to start detached process: ${result.stderr.slice(0, 500)}`,
    );
  }
}

async function readFileE2b(
  ctx: SandboxExecContext,
  remotePath: string,
  options?: SandboxFileOptions,
): Promise<Uint8Array> {
  const data = await withSandbox(
    ctx.sessionKey,
    undefined,
    sandbox =>
      sandbox.files.read(remotePath, {
        format: "bytes",
        user: userFor(options),
      }),
    { expectSandboxId: options?.expectSandboxId },
  );
  return new Uint8Array(data as Uint8Array);
}

/** The bytes a view covers, as the ArrayBuffer the E2B SDK wants. */
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

async function writeFileE2b(
  ctx: SandboxExecContext,
  remotePath: string,
  bytes: Uint8Array,
  options?: SandboxFileOptions,
): Promise<void> {
  await withSandbox(
    ctx.sessionKey,
    undefined,
    sandbox =>
      sandbox.files.write(remotePath, toArrayBuffer(bytes), {
        user: userFor(options),
      }),
    { expectSandboxId: options?.expectSandboxId },
  );
}

/** Several files in one multipart request: one round trip, not one each. */
async function writeFilesE2b(
  ctx: SandboxExecContext,
  files: Array<{ path: string; bytes: Uint8Array }>,
  options?: SandboxFileOptions,
): Promise<void> {
  if (files.length === 0) return;
  await withSandbox(
    ctx.sessionKey,
    undefined,
    sandbox =>
      sandbox.files.write(
        files.map(file => ({
          path: file.path,
          data: toArrayBuffer(file.bytes),
        })),
        { user: userFor(options) },
      ),
    { expectSandboxId: options?.expectSandboxId },
  );
}

async function publicUrlForPortE2b(
  ctx: SandboxExecContext,
  port: number,
): Promise<string> {
  const { entry } = await heldSandbox(ctx.sessionKey);
  return `https://${entry.sandbox.getHost(port)}`;
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
  // Never connect here. Sandbox.connect RESUMES a paused box, and this runs
  // from the 15 s dev-server status poll (dev-server/status.ts) and every box
  // report: a hostname lookup was waking boxes the idle sweep had just
  // paused. The host is `<port>-<sandboxId>.<domain>`, known from the list
  // alone. A paused box has no reachable host, so it answers null.
  try {
    const paginator = Sandbox.list({
      apiKey: apiKey(),
      query: {
        metadata: { makoAppsSessionKey: ctx.sessionKey },
        state: ["running"],
      },
      limit: 5,
    });
    if (!paginator.hasNext) return null;
    const info = pickWinner([...(await paginator.nextItems())]);
    if (!info) return null;
    const host = new ConnectionConfig({ apiKey: apiKey() }).getHost(
      info.sandboxId,
      port,
      // undefined falls back to the SDK's configured domain (E2B_DOMAIN).
      info.sandboxDomain as string,
    );
    return `https://${host}`;
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
  keepAliveUntil.set(ctx.sessionKey, Date.now() + Math.max(0, ms));
  const lifetime = Math.max(IDLE_TIMEOUT_MS, ms);
  // Always set, never skipped as "close enough": a hold is an explicit ask.
  await withSandbox(ctx.sessionKey, undefined, async sandbox => {
    const now = Date.now();
    await sandbox.setTimeout(lifetime);
    const entry = held.get(ctx.sessionKey);
    if (entry?.sandbox === sandbox) {
      entry.deadline = now + lifetime;
      entry.lifetimeSetAt = now;
    }
  });
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
 * The SDK's own `SandboxNotFoundError` is the reliable signal, so it is
 * checked FIRST and by type. Matching on the message alone is what made this
 * predicate quietly answer "no" to the single most common form of the error:
 * an idle-killed box surfaces as `SandboxNotFoundError: Sandbox is probably
 * not running anymore`, and the old pattern ("sandbox is not running") does
 * not match that string — the word "probably" sits in the middle of it. Every
 * recovery this gates was therefore dead code in exactly the case it exists
 * for (prod, 2026-09-01: a dead box 500'd the dev-servers route, and a
 * terminal whose box had gone logged one warning per keystroke instead of
 * reporting the exit).
 *
 * Messages are still matched, as a fallback for an error that crossed a
 * boundary that flattened it (a worker, a JSON round trip). `NotFoundError`
 * itself is deliberately NOT accepted: `FileNotFoundError` extends it, and a
 * missing file says nothing about the machine.
 */
const SANDBOX_GONE_MESSAGE =
  /sandbox\b[^:\n]*?\bwas not found|sandbox (?:is (?:probably )?not running)|not found: This error|sandbox was killed or reached its|killed or reached its end of life/i;

/**
 * Session keys of boxes that live for one job and are never resumed.
 *
 * A connector build box has a key of its own per build and is destroyed when
 * the build ends. If that never happens (the API restarts mid-build, a kill
 * fails), pausing it on idle would keep it forever: no later build reuses
 * the key. Killed on idle, it goes away by itself.
 */
const ONE_SHOT_SESSION_PREFIXES = ["connector-build:"];

export function onTimeoutFor(
  sessionKey: string,
): "kill" | { action: "pause"; keepMemory: true } {
  return ONE_SHOT_SESSION_PREFIXES.some(prefix => sessionKey.startsWith(prefix))
    ? "kill"
    : { action: "pause", keepMemory: true };
}

export function isSandboxGone(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    // e2b 2.x: a killed, paused or expired box is SandboxNotRunningError
    // (TimeoutError's subclass), e.g. "Sandbox abc was not found" from the
    // proxy, or "killed ... while the request was in flight".
    if (
      current instanceof SandboxNotFoundError ||
      current instanceof SandboxNotRunningError
    ) {
      return true;
    }
    const { name, message, cause } = current as {
      name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (name === "SandboxNotFoundError" || name === "SandboxNotRunningError") {
      return true;
    }
    if (typeof message === "string" && SANDBOX_GONE_MESSAGE.test(message)) {
      return true;
    }
    current = cause;
  }
  return false;
}

/**
 * Forget a session whose sandbox has gone.
 *
 * `sessionExists` answers from this map without asking E2B, so a dead box
 * left in it makes `hasSession` claim a machine that cannot be reached — the
 * caller then execs into nothing and gets an error where the contract
 * promised an empty answer. Discovering the box is gone is the moment the
 * memory becomes wrong, so that is where it is dropped.
 */
function forgetSession(sessionKey: string): void {
  held.delete(sessionKey);
  sessions.delete(sessionKey);
  knownAlive.delete(sessionKey);
  knownAbsent.set(sessionKey, Date.now() + KNOWN_ABSENT_TTL_MS);
}

async function openTerminalE2b(
  ctx: SandboxExecContext,
  // Take the options straight from the interface rather than restating them,
  // so adding one there cannot leave this signature quietly behind.
  opts: Parameters<SandboxProvider["openTerminal"]>[1],
): Promise<SandboxTerminal> {
  const cwd = path.posix.join(REMOTE_ROOT, opts.cwd);
  if (!cwd.startsWith(REMOTE_ROOT)) {
    throw new Error(
      `cwd escapes the session root: ${JSON.stringify(opts.cwd)}`,
    );
  }

  // The shell is created through withSandbox like any command: a held
  // handle to a paused box is dropped, and the create is retried once only
  // when the box never received it.
  const { sandbox, handle } = await withSandbox(
    ctx.sessionKey,
    lifetimeMs(ctx.sessionKey, IDLE_TIMEOUT_MS),
    async box => {
      try {
        const pty = await box.pty.create({
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
            // A real terminal, so colour and redrawing work — this is the
            // whole reason for a PTY over one-shot commands.
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
            // A `vite` the user starts in this shell accepts the preview
            // origin, whatever the app's committed vite.config.ts says.
            ...viteAllowedHostEnv(),
          },
        });
        return { sandbox: box, handle: pty };
      } catch (error) {
        throw new CommandNotStartedError(error);
      }
    },
    { policy: "unstarted-only" },
  );

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
            if (isSandboxGone(error)) {
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

/**
 * ...and negative answers for a moment, because a read path asks in bursts.
 *
 * Resolving "live box or last commit?" happens per FILE READ, so one request
 * that reads a handful of files asked this a handful of times in a row — and
 * with nothing cached on NO, each of those was an E2B list round trip. That
 * is the difference between an app's data binding answering in a second and
 * in thirty. The window is deliberately small, and everything that learns a
 * sandbox exists clears it (rememberSession), so the only staleness left is a
 * box another API instance created — visible at most KNOWN_ABSENT_TTL_MS
 * late, one beat of a poll rather than a frozen view.
 */
const knownAbsent = new Map<string, number>();
const KNOWN_ABSENT_TTL_MS = 2_000;

/** This session has a live sandbox: remember it, and stop calling it absent. */
function rememberSession(sessionKey: string, sandboxId: string): void {
  sessions.set(sessionKey, sandboxId);
  knownAbsent.delete(sessionKey);
  knownAlive.set(sessionKey, Date.now() + KNOWN_ALIVE_TTL_MS);
}

/** Is a sandbox already up for this session? Never creates one. */
async function sessionExists(sessionKey: string): Promise<boolean> {
  if (sessions.has(sessionKey)) return true;
  if ((knownAlive.get(sessionKey) ?? 0) > Date.now()) return true;
  if ((knownAbsent.get(sessionKey) ?? 0) > Date.now()) return false;
  try {
    const paginator = Sandbox.list({
      apiKey: apiKey(),
      query: { metadata: { makoAppsSessionKey: sessionKey } },
      limit: 1,
    });
    const found = paginator.hasNext && (await paginator.nextItems()).length > 0;
    if (found) knownAlive.set(sessionKey, Date.now() + KNOWN_ALIVE_TTL_MS);
    else knownAbsent.set(sessionKey, Date.now() + KNOWN_ABSENT_TTL_MS);
    return found;
  } catch {
    // Unreachable E2B is not the same as "no sandbox", but for the one caller
    // — should this read come from the working copy or the last commit? — the
    // committed answer is the safe one. Deliberately NOT cached: a blip is not
    // an answer, and caching it would extend one bad request into a window.
    return false;
  }
}

/** The sandbox id behind a session, without creating one. */
async function sandboxIdFor(sessionKey: string): Promise<string | null> {
  const known = sessions.get(sessionKey);
  if (known) return known;
  const paginator = Sandbox.list({
    apiKey: apiKey(),
    query: { metadata: { makoAppsSessionKey: sessionKey } },
    limit: 5,
  });
  if (!paginator.hasNext) return null;
  return pickWinner([...(await paginator.nextItems())])?.sandboxId ?? null;
}

const boxLifecycleE2b: SandboxBoxLifecycle = {
  async create(sessionKey, { template }) {
    if (template) templateOverrides.set(sessionKey, template);
    creatingBoxes.add(sessionKey);
    try {
      await connectSession(sessionKey);
    } finally {
      templateOverrides.delete(sessionKey);
      creatingBoxes.delete(sessionKey);
    }
  },
  async pause(sessionKey) {
    const id = await sandboxIdFor(sessionKey);
    if (!id) return;
    await Sandbox.pause(id, { apiKey: apiKey() });
    // The held handle points at a paused box now: drop it, so the next call
    // connects (and resumes) instead of failing on it first.
    noteSessionPaused(sessionKey);
  },
  async snapshot(sessionKey, name) {
    const sandbox = await connectSession(sessionKey);
    const info = await sandbox.createSnapshot({ name });
    return info.snapshotId;
  },
  async deleteSnapshot(snapshotId) {
    await Sandbox.deleteSnapshot(snapshotId, { apiKey: apiKey() });
  },
  async countRunning() {
    const paginator = Sandbox.list({
      apiKey: apiKey(),
      query: { state: ["running"] },
      limit: 100,
    });
    let count = 0;
    while (paginator.hasNext) count += (await paginator.nextItems()).length;
    return count;
  },
};

/**
 * "Running?" answers, briefly, for background polls (provider.ts isRunning).
 *
 * Unlike sessionExists this never trusts the in-process `sessions` map: that
 * map still names a box after E2B paused it, and the exec that followed a
 * stale yes is exactly what resumed it. Both answers are cached for a beat
 * so a poll burst is one list call.
 *
 * The list call is bounded (2026-11-16: a slow E2B list held repo-work pool
 * slots on the apps files/status routes). It gives up after
 * RUNNING_LOOKUP_TIMEOUT_MS, and concurrent lookups of one session on this
 * instance share one call. A lookup that fails or times out answers
 * "unknown" and logs why. Never a stale "running": five poll guards exec on
 * "running", and an exec resumes a paused box.
 */
const runningAnswer = new Map<string, { running: boolean; until: number }>();
const RUNNING_ANSWER_TTL_MS = 10_000;
/** How long an E2B list may take before the lookup gives up. */
export const RUNNING_LOOKUP_TIMEOUT_MS = 3_000;
/** One list call per session at a time on this instance. */
const runningLookups = new Map<string, Promise<boolean>>();

async function sessionRunning(sessionKey: string): Promise<boolean> {
  return (await sessionRunState(sessionKey)) === "running";
}

function lookUpRunning(sessionKey: string): Promise<boolean> {
  const inFlight = runningLookups.get(sessionKey);
  if (inFlight) return inFlight;
  let timer: NodeJS.Timeout | undefined;
  const lookup = (async () => {
    const paginator = Sandbox.list({
      apiKey: apiKey(),
      query: {
        metadata: { makoAppsSessionKey: sessionKey },
        state: ["running"],
      },
      limit: 1,
      requestTimeoutMs: RUNNING_LOOKUP_TIMEOUT_MS,
    });
    return paginator.hasNext && (await paginator.nextItems()).length > 0;
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `E2B list did not answer within ${RUNNING_LOOKUP_TIMEOUT_MS} ms`,
          ),
        ),
      RUNNING_LOOKUP_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  const shared = Promise.race([lookup, timeout])
    .then(running => {
      // A pause noted while this call was out wins over its answer.
      if (runningLookups.get(sessionKey) === shared) {
        runningAnswer.set(sessionKey, {
          running,
          until: Date.now() + RUNNING_ANSWER_TTL_MS,
        });
      }
      return running;
    })
    .finally(() => {
      clearTimeout(timer);
      if (runningLookups.get(sessionKey) === shared) {
        runningLookups.delete(sessionKey);
      }
    });
  // The losing side of the race must not surface as an unhandled rejection.
  lookup.catch(() => undefined);
  runningLookups.set(sessionKey, shared);
  return shared;
}

async function sessionRunState(
  sessionKey: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<"running" | "not-running" | "unknown"> {
  const cached = runningAnswer.get(sessionKey);
  if (!fresh && cached && cached.until > Date.now()) {
    return cached.running ? "running" : "not-running";
  }
  try {
    return (await lookUpRunning(sessionKey)) ? "running" : "not-running";
  } catch (error) {
    // Could not tell. Polls read "unknown" as "offline" (sessionRunning)
    // and the next beat asks again; callers that must not guess fall back
    // to their own answer.
    logger.warn("E2B running lookup failed", {
      sessionKey,
      fresh,
      error: error instanceof Error ? error.message : String(error),
    });
    return "unknown";
  }
}

const pausedListeners = new Set<(sessionKey: string) => void>();

/**
 * Run `listener` whenever this process learns a session's box was paused.
 * For per-session state held outside this module (a cached Sandbox handle,
 * PR 1284), which must not outlive the pause. Returns an unsubscribe.
 */
export function onSessionPaused(
  listener: (sessionKey: string) => void,
): () => void {
  pausedListeners.add(listener);
  return () => pausedListeners.delete(listener);
}

/**
 * The idle sweep paused this session's box: drop everything this process
 * cached about it, so its polls stop answering "running" from memory and
 * the next real use reconnects (and resumes) from scratch.
 */
export function noteSessionPaused(sessionKey: string): void {
  runningLookups.delete(sessionKey);
  runningAnswer.set(sessionKey, {
    running: false,
    until: Date.now() + RUNNING_ANSWER_TTL_MS,
  });
  keepAliveUntil.delete(sessionKey);
  sessions.delete(sessionKey);
  knownAlive.delete(sessionKey);
  clearBoxResume(sessionKey);
  for (const listener of pausedListeners) {
    try {
      listener(sessionKey);
    } catch (error) {
      logger.warn("A session-paused listener threw", {
        sessionKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// A paused box makes its held handle stale: the next call must connect (and
// resume) instead of failing on the handle first. noteSessionPaused (the
// idle sweep, boxLifecycle.pause) tells every listener.
onSessionPaused(sessionKey => {
  held.delete(sessionKey);
});

export const e2bSandboxProvider: SandboxProvider = {
  id: "e2b",
  supportsRunUsers: true,
  boxLifecycle: boxLifecycleE2b,
  exec: execE2b,
  execDetached: execDetachedE2b,
  root: () => REMOTE_ROOT,
  scratch: () => "/tmp",
  hasSession: ctx => sessionExists(ctx.sessionKey),
  isRunning: ctx => sessionRunning(ctx.sessionKey),
  runState: (ctx, options) => sessionRunState(ctx.sessionKey, options),
  sessionSandboxIds: async ctx => {
    // Throws on a lookup failure on purpose: callers must tell "E2B said
    // none" apart from "E2B did not answer".
    const paginator = Sandbox.list({
      apiKey: apiKey(),
      query: { metadata: { makoAppsSessionKey: ctx.sessionKey } },
      limit: 10,
    });
    if (!paginator.hasNext) return [];
    return (await paginator.nextItems()).map(box => box.sandboxId);
  },
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
  writeFiles: writeFilesE2b,
  readFile: readFileE2b,
  openTerminal: openTerminalE2b,
  publicUrlForPort: publicUrlForPortE2b,
  peekPublicUrlForPort: peekPublicUrlForPortE2b,
  keepAlive: keepAliveE2b,
  destroySession: async sessionKey => {
    const sandboxId = sessions.get(sessionKey);
    held.delete(sessionKey);
    sessions.delete(sessionKey);
    knownAlive.delete(sessionKey);
    keepAliveUntil.delete(sessionKey);
    // The in-process map is only THIS instance's memory: after an API
    // restart (or when another instance created the box) it is empty, and a
    // recycle that kills nothing while broadcasting "offline" is a lie every
    // tab believes — the next touch rediscovers the same, un-killed box. The
    // metadata index is the durable truth; kill everything it names.
    const ids = new Set<string>(sandboxId ? [sandboxId] : []);
    let listed = false;
    try {
      const paginator = Sandbox.list({
        apiKey: apiKey(),
        query: { metadata: { makoAppsSessionKey: sessionKey } },
        limit: 10,
      });
      if (paginator.hasNext) {
        for (const box of await paginator.nextItems()) ids.add(box.sandboxId);
      }
      listed = true;
    } catch (error) {
      logger.warn(
        "Recycle could not list sandboxes by metadata; killing known id only",
        {
          sessionKey,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    // Knowing nothing is not the same as there being nothing. A kill that
    // could neither list nor remember a box must fail, so its caller (the
    // connector box reaper, a legacy sync box retirement) retries instead of
    // recording a box as dead while it runs on.
    if (!listed && ids.size === 0) {
      throw new Error(
        `Could not find the sandbox for ${sessionKey} to kill it; the list call failed.`,
      );
    }
    const results = await Promise.allSettled(
      [...ids].map(id => Sandbox.kill(id, { apiKey: apiKey() })),
    );
    const failed = results.filter(r => r.status === "rejected");
    for (const result of failed) {
      logger.warn("Could not kill a sandbox on destroy", {
        sessionKey,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    }
    // Connector boxes and sync boxes: a kill that failed must surface, so
    // the reaper (or the legacy sync box retirement) tries again rather than
    // believing a box with tenant code in it is gone.
    if (
      failed.length > 0 &&
      (isConnectorBoxKey(sessionKey) ||
        sessionKey.startsWith("connector-sync:"))
    ) {
      throw new Error(
        `Could not kill ${failed.length} of ${ids.size} sandboxes for ${sessionKey}.`,
      );
    }
  },
};
