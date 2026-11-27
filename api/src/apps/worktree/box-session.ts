/**
 * The actor's sandbox: its session key, the git identity it commits as, and
 * hydrating it (clone, remote, pull) with the caches that keep that cheap.
 */
import { authRepo } from "../../repositories/auth";
import { loggers } from "../../logging";
import { BoundedMap } from "../../utils/bounded-map";
import {
  boxHasRepo,
  boxHasValidCheckout,
  boxPull,
  cloneIntoBox,
  configureBoxRemote,
} from "../box";
import { forgetBoxState } from "../box-state.service";
import { ensureBoxAgent, forgetBoxAgent } from "../box-agent";
import { appsGitOriginBase } from "../config";
import { noteBoxActivity } from "../box-activity";

import { type SandboxExecContext } from "../sandbox/provider";
import { WorktreeHandle } from "./repo";

const logger = loggers.api("apps");

// The sandbox HAS a remote, and a credential for it — see box.ts. Two things
// used to stand in for that: a deliberately unreachable `origin` planted in
// host clones, then a bundle-based transfer with no remote at all. Both were
// ways of not giving a working copy the one thing that makes it a working
// copy.

/** Addresses the actor's sandbox — the one working copy. */
export function boxCtx(handle: WorktreeHandle): SandboxExecContext {
  return {
    sessionKey: sessionKeyFor(handle.doc.workspaceId, handle.doc.userId),
  };
}

/**
 * The sandbox's name at the provider: `<workspaceId>:<userId>`.
 *
 * Convention, not bookkeeping: the sandbox is DISCOVERED by this tag (E2B
 * metadata), so identity needs no stored id anywhere — the same box is
 * findable from any API process, after any restart, with no database in the
 * loop. One sandbox per (workspace, user), by name.
 */
export function sessionKeyFor(
  workspaceId: { toString(): string },
  userId: string,
): string {
  return `${workspaceId.toString()}:${userId}`;
}

/**
 * The git identity for an actor: who their commits are authored as.
 *
 * This is the ONE place the box's commit identity is decided, and it is the
 * same identity minted into the git token — so a commit's author and the
 * endpoint's authorship check can never disagree. The name is the email's
 * local part; a real display name is not something apps needs to carry.
 *
 * Cached per process: it is read on every box reconfigure, and a user's email
 * does not change under us. A non-user actor (the `publish` box) or a lookup
 * miss returns undefined — the caller then leaves the box's existing identity
 * alone rather than stamping a wrong one.
 */
const actorIdentityCache = new BoundedMap<
  string,
  { name: string; email: string } | undefined
>({ maxEntries: 5_000, ttlMs: 10 * 60_000 });

export async function resolveActorIdentity(
  userId: string,
): Promise<{ name: string; email: string } | undefined> {
  if (actorIdentityCache.has(userId)) return actorIdentityCache.get(userId);
  let identity: { name: string; email: string } | undefined;
  try {
    const user = await authRepo.findUserById(userId);
    if (user?.email) {
      identity = {
        name: user.email.split("@")[0] || user.email,
        email: user.email,
      };
    }
  } catch (error) {
    // A non-ObjectId actor id (e.g. the publish actor) makes findById throw
    // on cast — that is a "no user", cache it. Anything else is a transient
    // DB failure: caching undefined for the process lifetime silently
    // disabled authorship for that user until a restart. Answer "unknown"
    // for THIS call only and let the next one retry.
    if ((error as Error | null)?.name !== "CastError") {
      logger.warn("Apps actor identity lookup failed; not caching", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
    identity = undefined;
  }
  actorIdentityCache.set(userId, identity);
  return identity;
}

/**
 * Make sure the actor's sandbox holds a checkout before touching files.
 *
 * Separate from ensureWorktree on purpose: knowing which branch someone is on
 * is cheap git work against the bare repo and must keep working while the
 * sandbox is asleep. Only code that actually reads or writes the working copy
 * pays for a sandbox.
 *
 * On an existing box this refreshes the credential rather than doing nothing.
 * That is what lets the token be short-lived without a session ever hitting
 * its expiry mid-push.
 */
/**
 * When each sandbox last caught up with the server.
 *
 * A `git pull` on every single operation would be a network round trip per
 * file write and an automatic merge each time — too eager to be honest about.
 * Once in a while is what a person does, and it is enough to pick up an app a
 * colleague added. Purely a throttle: forgetting it (a process restart) only
 * means pulling again.
 */
export const lastPull = new Map<string, number>();

/**
 * Drop the pull throttle everywhere: a branch just moved WITHOUT a push from
 * any box (server-side merge, or someone else's push), so "pulled recently"
 * no longer implies "current". The next touch of every box pulls once. This
 * replaced the old catch-up machinery: instead of merging main into personal
 * branches server-side, boxes simply pull like any clone would.
 */
export function invalidatePullThrottle(): void {
  lastPull.clear();
}
const PULL_INTERVAL_MS = 60_000;

/**
 * When each sandbox's credential was last refreshed.
 *
 * Rewriting the remote and the credential on every call was both wasteful and
 * wrong: `git config` takes `.git/config.lock`, so eight parallel writes —
 * which is what an agent firing parallel tool calls produces — became eight
 * failed writes, each losing a lock race against the others for work that did
 * not need doing at all. The token lasts twelve hours; refreshing it twice an
 * hour is plenty, and it keeps ordinary file writes off git's config lock.
 */
/** sessionKey -> { at, base }: when, and against WHICH origin, the box was last configured. */
const lastConfigured = new Map<string, { at: number; base: string }>();
const RECONFIGURE_INTERVAL_MS = 30 * 60_000;

/**
 * One hydration at a time per sandbox.
 *
 * An agent fires tool calls in parallel, and on a cold box every one of them
 * reaches ensureBox at once — eight concurrent `git init` + config + fetch
 * runs against one directory, each losing config.lock races the others
 * created. Not a mutex over work (commands still run concurrently once the
 * box exists); strictly "do not clone the same box twice at the same time".
 */
const ensureInFlight = new Map<string, Promise<SandboxExecContext>>();

/** Forget per-box throttles when the box itself is destroyed. */
export function forgetBoxCaches(sessionKey: string): void {
  lastPull.delete(sessionKey);
  lastConfigured.delete(sessionKey);
  // Nothing the old machine said about itself holds for the next one.
  void forgetBoxState(sessionKey);
  forgetBoxAgent(sessionKey);
}

/** The provider's "cwd does not exist" — the fingerprint of an unhydrated box. */
export function isMissingCwd(error: unknown): boolean {
  return (
    error instanceof Error && /cwd '.*' does not exist/i.test(error.message)
  );
}

/** Force-hydrate a box that turned out to be missing its working copy. */
const rehydrating = new Map<string, Promise<void>>();

export function rehydrateBox(
  handle: WorktreeHandle,
  ctx: SandboxExecContext,
): Promise<void> {
  // Single-flight per box: rehydrate is reached from exec's missing-cwd
  // retry, and an agent firing N parallel tool calls after a recycle hit N
  // concurrent clones into one directory — the git init/config.lock race
  // ensureInFlight exists to prevent, recreated through the back door.
  const inflight = rehydrating.get(ctx.sessionKey);
  if (inflight) return inflight;
  const run = rehydrateBoxNow(handle, ctx).finally(() =>
    rehydrating.delete(ctx.sessionKey),
  );
  rehydrating.set(ctx.sessionKey, run);
  return run;
}

async function rehydrateBoxNow(
  handle: WorktreeHandle,
  ctx: SandboxExecContext,
): Promise<void> {
  logger.warn("Apps box missing its working copy; rehydrating", {
    sessionKey: ctx.sessionKey,
  });
  lastPull.delete(ctx.sessionKey);
  lastConfigured.delete(ctx.sessionKey);
  await forgetBoxState(ctx.sessionKey);
  if (!(await boxHasRepo(ctx))) {
    await cloneIntoBox({
      ctx,
      workspaceId: handle.doc.workspaceId.toString(),
      userId: handle.doc.userId,
      branch: handle.doc.branch,
      author: await resolveActorIdentity(handle.doc.userId),
    });
    await ensureBoxAgent(ctx, { force: true });
    lastPull.set(ctx.sessionKey, Date.now());
    lastConfigured.set(ctx.sessionKey, {
      at: Date.now(),
      base: appsGitOriginBase(),
    });
  }
}

export function ensureBox(
  handle: WorktreeHandle,
  options: { lazyPull?: boolean } = {},
): Promise<SandboxExecContext> {
  const key = boxCtx(handle).sessionKey;
  // Every ensureBox is someone (or an agent turn) asking for the machine:
  // a read-only session must not be paused right after its resume.
  // Throttled to one write per session per 30 s (box-activity.ts).
  noteBoxActivity(key, "read");
  const existing = ensureInFlight.get(key);
  if (existing) return existing;
  const run = ensureBoxNow(handle, options).finally(() =>
    ensureInFlight.delete(key),
  );
  ensureInFlight.set(key, run);
  return run;
}

async function ensureBoxNow(
  handle: WorktreeHandle,
  options: { lazyPull?: boolean } = {},
): Promise<SandboxExecContext> {
  const ctx = boxCtx(handle);
  const workspaceId = handle.doc.workspaceId.toString();
  const userId = handle.doc.userId;
  const author = await resolveActorIdentity(userId);
  // A REAL checkout, not just a `.git`: a box whose clone git-init'd but never
  // fetched/checked-out (a hydrate that threw partway) must fall through to the
  // clone below and be repaired, not be mistaken for a ready box and left empty
  // forever. cloneIntoBox is idempotent, so re-running it completes the hydrate.
  if (await boxHasValidCheckout(ctx)) {
    // Reconfigure when the token is due for a refresh OR when the origin the
    // box should point at has changed (a tunnel restart in development). The
    // record is written only after configure SUCCEEDS: recording first meant
    // a failed configure was remembered as done for the whole interval.
    const base = appsGitOriginBase();
    const last = lastConfigured.get(ctx.sessionKey);
    if (
      !last ||
      last.base !== base ||
      Date.now() - last.at > RECONFIGURE_INTERVAL_MS
    ) {
      await configureBoxRemote({ ctx, workspaceId, userId, author });
      lastConfigured.set(ctx.sessionKey, { at: Date.now(), base });
    }
    // The agent that pushes this box's state; throttled, off the hot path.
    void ensureBoxAgent(ctx);
    // Catch up with the server. Someone else may have added an app on main,
    // and your branch tracks main — this is the `git pull` you would type
    // after opening a laptop that has been shut for a day.
    const since = Date.now() - (lastPull.get(ctx.sessionKey) ?? 0);
    if (since > PULL_INTERVAL_MS) {
      lastPull.set(ctx.sessionKey, Date.now());
      // A terminal opening does not need the pull to have FINISHED — the
      // shell is interactive, the pull lands moments later like a
      // background `git pull` on a laptop. Callers that read files next
      // (the default) still wait.
      const pull = boxPull(ctx).catch(() => undefined);
      if (!options.lazyPull) await pull;
    }
    return ctx;
  }
  // A box with no repository is a NEW machine (first boot, or a replacement
  // after the previous one died). Nothing the old one said about itself
  // holds: drop its snapshot now rather than letting it expire on its own,
  // so a dead server cannot show as running until the TTL runs out.
  await forgetBoxState(ctx.sessionKey);
  await cloneIntoBox({
    ctx,
    workspaceId,
    userId,
    branch: handle.doc.branch,
    author,
  });
  await ensureBoxAgent(ctx, { force: true });
  lastPull.set(ctx.sessionKey, Date.now());
  lastConfigured.set(ctx.sessionKey, {
    at: Date.now(),
    base: appsGitOriginBase(),
  });
  return ctx;
}
