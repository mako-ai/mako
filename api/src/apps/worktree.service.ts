/**
 * Apps worktree service.
 *
 * What this module is, after the sandbox got a real git remote:
 *
 * 1. The SANDBOX is the working copy, and it is an ordinary clone. It fetches
 *    and pushes to Mako's git-over-HTTP endpoint, which serves the same bare
 *    repo this module reads. One repository, two ordinary git clients.
 * 2. Uncommitted work lives in the working copy, the way it does on a laptop.
 *    `git push` is what makes work durable — there is no shadow commit, no WIP
 *    ref, and no database mirror of either.
 * 3. Reads come from the working copy when the sandbox is up, and from the
 *    last commit when it is not. That is not two implementations of one thing;
 *    it is the difference between an editor and a code host, and the only
 *    honest answer when the machine is off.
 * 4. What remains server-side is what genuinely belongs there: creating and
 *    deleting apps, listing branches and history, and the publish merge —
 *    plain git against the bare repo, no sandbox involved.
 *
 * This file used to be more than twice this size. The difference was a
 * transfer layer (bundles), a durability layer (WIP refs and snapshot
 * commits), a mirror of both in Mongo, and the reconciliation between them.
 * All of it existed because the sandbox could not push.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Types } from "mongoose";
import {
  AppIndexEntry,
  AppProject,
  AppWorktree,
  type IAppProject,
  type IAppWorktree,
} from "../database/workspace-schema";
import {
  APP_HISTORY_SCAN_MAX_COMMITS,
  aliasFolders,
  appHistory,
  type AppHistoryCommit,
} from "./app-history";
import { User } from "../database/schema";
import { loggers } from "../logging";
import {
  boxCheckout,
  boxCommitAll,
  boxDiscard,
  boxGlob,
  boxGrep,
  boxHasRepo,
  boxHasValidCheckout,
  boxHead,
  boxListFiles,
  boxPull,
  boxPushIfAhead,
  boxReadFile,
  boxRoot,
  boxStatus,
  boxWriteFile,
  cloneIntoBox,
  configureBoxRemote,
  sh,
  boxGitPaths,
  boxFileVersions,
  boxPorcelain,
  type BoxFileVersions,
  boxRestoreTreeFrom,
} from "./box";
import { publishRealtimeEvent } from "../services/realtime.service";
import {
  forgetBoxState,
  getBoxState,
  hasGitState,
  patchBoxState,
} from "./box-state.service";
import { ensureBoxAgent, forgetBoxAgent } from "./box-agent";
import {
  APPS_MAX_FILE_BYTES,
  RepoRequiredError,
  appsGitOriginBase,
  appsSessionsRoot,
} from "./config";
import { requireWorkspaceRepo } from "./workspace-repo-required";
import { getWorkspaceRepo } from "../services/workspace-repos.service";
import {
  assertSafeRelPath,
  caseTwinOf,
  EMPTY_TREE,
  runGit,
  ZERO_OID,
} from "./git";
import {
  DEFAULT_BRANCH,
  commitTree,
  globTree,
  grepTree,
  listTree,
  log as repoLog,
  diffNameStatus,
  readBlob,
  repoDirFor,
  repoExists,
  resolveCommit,
  snapshotDirToTree,
  updateRefCas,
  type ChangedFile,
  type GitAuthor,
  type GrepMatch,
  type TreeEntry,
} from "./repository.service";
import {
  authorForUser,
  syncConsolesIndexFromRepo,
} from "./workspace-consoles.service";
import {
  MAX_ALIASES_PER_APP,
  aliasForOldPath,
  aliasMatchesRef,
  aliasesForMoves,
  forgetRolledBackCommit,
  holdBackCommit,
  invalidateAppsIndexCache,
  loadAppsIndex,
  readIndexedAppsAt,
  resolveAppRef,
  resolveAppRefVia,
  syncAppsIndexFromRepo,
  type AppIndexRow,
  type AppSchedule,
  type AppsIndexSnapshot,
} from "./app-index.service";
import {
  APP_MANIFEST,
  APPS_DIR,
  FOLDER_KEEP_FILE,
  addManifestAliases,
  appRepoPath,
  appTitleProblem,
  parseAppRepoPath,
  appTreeRoot,
  isSafeSegment,
  newSegmentProblem,
  normalizeName,
  parseAppFolderPath,
  parseAppManifest,
  setManifestTitle,
  stampManifestId,
  stripManifestAliases,
  type AppScope,
} from "./app-paths";
import { appSdkDependency } from "./app-sdk-package";
import { canReadResource } from "../utils/resource-acl";

// Identity helpers moved to app-paths.ts (pure); re-exported so existing
// importers keep working.
export { derivedAppId } from "./app-paths";
import { createAppsScaffold } from "./scaffold";
import {
  ensureCommitLocally,
  ensureLocalRepo,
  freshenBeforeMainWrite,
  mirrorPushNow,
  resolveMirrorTarget,
  queueMirrorPush,
} from "./cloud-repo.service";

/**
 * Local repo dir for a project, restoring it from the cloud mirror first
 * when the cache is cold (serverless hosts start with an empty
 * APPS_GIT_ROOT — see ensureLocalRepo).
 */
async function repoFor(project: IAppProject): Promise<string> {
  return repoForWorkspace(project.workspaceId.toString());
}

/** §10 monorepo: the ONE bare repo per workspace (clone-on-miss). */
export async function repoForWorkspace(workspaceId: string): Promise<string> {
  if (!(await getWorkspaceRepo(workspaceId))) {
    throw new RepoRequiredError();
  }
  await ensureLocalRepo(workspaceId);
  return repoDirFor(workspaceId);
}

/**
 * Repo-relative folder an app's content lives under. `path` is maintained by
 * the apps index from the tree at main; rows that predate it are at
 * `apps/<slug>`, which is what every app was before folders nested.
 */
export function appRootFor(project: IAppProject): string {
  return (
    project.path ?? `${APPS_DIR}/${project.slug ?? project._id.toString()}`
  );
}

/** Prefix an app-relative path into its repo-relative form. */
function appPath(project: IAppProject, relPath: string): string {
  return `${appRootFor(project)}/${assertSafeRelPath(relPath)}`;
}

/** Prefix a handle-relative path into its repo-relative form ("" root = repo). */
function scopedPath(handle: WorktreeHandle, relPath: string): string {
  const safe = assertSafeRelPath(relPath);
  return handle.appRoot ? `${handle.appRoot}/${safe}` : safe;
}

/** The app this handle was opened for; workspace-scoped handles have none. */
export function handleProject(handle: WorktreeHandle): IAppProject {
  if (!handle.project) {
    throw new Error("This operation requires an app-scoped worktree handle");
  }
  return handle.project;
}
import {
  getSandboxProvider,
  type SandboxExecContext,
  type SandboxExecOptions,
  type SandboxExecResult,
} from "./sandbox/provider";

const logger = loggers.api("apps");

/** Poke open windows to refetch this app's git-backed state. */
function pokeApp(
  workspaceId: { toString(): string },
  appId: { toString(): string } | null | undefined,
  origin: "commit" | "merge" | "discard" | "checkout" | "lifecycle" | "push",
  updatedBy?: string,
): void {
  publishRealtimeEvent(workspaceId.toString(), {
    type: "app.updated",
    // "" = workspace-wide (a workspace worktree changed; may span apps).
    appId: appId?.toString() ?? "",
    updatedBy,
    origin,
  });
}

/**
 * React to commits reaching this server's bare repo over the git endpoint.
 *
 * Called by routes/apps-git.ts after every completed receive-pack. This is
 * the ONE place push-shaped side effects live, because every path commits take
 * to the server — the commit button, the agent's end-of-turn commit, `git
 * push` typed in a terminal — converges on that endpoint. The commit
 * functions below deliberately do not queue the mirror or poke windows
 * themselves; doing it both here and there meant every button-press push did
 * its bookkeeping twice, and a terminal push did it zero times.
 */
export function notifyRepoPushed(workspaceId: string, userId: string): void {
  queueMirrorPush(workspaceId);
  pokeApp(workspaceId, null, "push", userId);
  // Another box on the same branch is now behind; let it pull on next touch.
  invalidatePullThrottle();
  syncRepoBackedResources(workspaceId, userId);
}

/**
 * Reconcile every Mongo index that a file in the repo is authoritative for.
 *
 * Split out of {@link notifyRepoPushed} because commits reach main by two
 * routes, not one: this server's git endpoint, and a push made directly on
 * GitHub, which arrives as a webhook (routes/github.routes.ts) and never
 * touches receive-pack here. That second route had grown its own copy of this
 * list containing consoles and skills only, so a dbt job or a notebook edited
 * on GitHub reached Mongo only when someone later happened to push through
 * Mako — config-as-code flowing one way, silently. One list, both callers, so
 * adding a repo-backed resource cannot leave one route behind again.
 *
 * Every sync is an idempotent reconcile against the tree at main, so a push
 * touching none of these costs one tree read each and changes nothing. Each
 * is fire-and-forget and independently caught: one resource's bad YAML must
 * not stop the others from syncing.
 *
 * Callers must have the commit locally FIRST — the git endpoint does by
 * construction, the webhook by fetching before it calls. dbt's sync deletes
 * job rows whose slugs are absent from the tree it reads, so running it
 * against a stale tree would not merely miss an update, it would remove live
 * jobs and deregister their schedules.
 *
 * Flows (RFC #904 block 3) are the most dangerous entry in this list, because
 * a flow is a running stream rather than a row: a file missing from the tree
 * means a CDC teardown and checkpoint disposal, which re-backfills rather than
 * resuming. Two guards make that safe, and both live below this call — an
 * empty `flows/` changes nothing, and every destructive branch is behind a
 * fail-closed assertion that the tree really is the mirror's main.
 */
export function syncRepoBackedResources(
  workspaceId: string,
  userId?: string,
): void {
  // Apps: the folder tree at main IS the list; the index is its read model.
  // A `git mv` in a terminal, a folder pushed from a laptop, a manifest id
  // stamped by hand — all land here.
  void syncAppsIndexFromRepo(workspaceId).catch(error => {
    logger.warn("Apps index sync after push failed", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  // Consoles edited in a terminal or a laptop clone reach the index (and the
  // agent's search) by the next turn (apps.md §16.3).
  void syncConsolesIndexFromRepo(workspaceId, userId).catch(error => {
    logger.warn("Console index sync after push failed", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  // Skills are files only (apps.md §27): nothing to reconcile on push.
  // dbt orchestration config (jobs/environments YAML — apps.md §23):
  // external edits re-register schedules on the next push.
  void import("../dbt/dbt-config.service")
    .then(m => m.syncDbtConfigFromRepo(workspaceId, userId))
    .catch(error => {
      logger.warn("dbt config sync after push failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  // Notebook .deepnote checkpoints (apps.md §24): external edits flow into
  // the hot store unless the live document is ahead.
  void import("../notebooks/notebook-git.service")
    .then(m => m.syncNotebooksFromRepo(workspaceId, userId))
    .catch(error => {
      logger.warn("Notebook sync after push failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  // Workspace connectors (`connectors/<slug>/`): a folder pushed to main is
  // run in the sync box to capture its `spec`, which is what a credential form
  // is built from. A connector whose spec fails is indexed as blocked with the
  // reason, so whoever pushed it can see why it is not in the picker.
  void import("../connectors/workspace/reconcile.service")
    .then(m => m.syncConnectorsFromRepo(workspaceId, userId))
    .then(result => {
      if (result.blocked > 0 || result.skipped.length > 0) {
        logger.warn("Some workspace connectors were not indexed", {
          workspaceId,
          blocked: result.blocked,
          skipped: result.skipped,
        });
      }
    })
    .catch(error => {
      logger.warn("Connector sync after push failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  // Flow definitions (RFC #904 block 3): `flows/<slug>.yml` is authoritative,
  // so an external edit reconfigures a live CDC stream and a removed file
  // tears one down. Caught like the others — one resource's bad YAML must not
  // stop the rest — and a refused teardown is reported, not silently skipped.
  void import("../services/flow-sync.service")
    .then(m => m.syncFlowsFromRepo(workspaceId, userId))
    .then(result => {
      if (result.deferred.length > 0) {
        logger.warn("Flow teardown deferred; will retry on the next push", {
          workspaceId,
          slugs: result.deferred,
        });
      }
    })
    .catch(error => {
      logger.warn("Flow sync after push failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

// The sandbox HAS a remote, and a credential for it — see box.ts. Two things
// used to stand in for that: a deliberately unreachable `origin` planted in
// host clones, then a bundle-based transfer with no remote at all. Both were
// ways of not giving a working copy the one thing that makes it a working
// copy.
//
// There is also no per-worktree mutex here any more. It existed to serialize
// compare-and-swap advances of the WIP ref; git takes its own index lock, and
// concurrent writers to one checkout are now exactly as (un)safe as they are
// on any developer's machine.

export class WorktreeConflictError extends Error {
  constructor(
    message: string,
    public readonly conflictRef?: string,
  ) {
    super(message);
    this.name = "WorktreeConflictError";
  }
}

export interface WorktreeHandle {
  doc: IAppWorktree;
  /** Absent for a workspace-scoped handle (Source Control, repo-level ops). */
  project?: IAppProject;
  repoDir: string;
  /** Repo-relative root this handle is scoped to; "" = the whole repo. */
  appRoot: string;
}

/**
 * What repo-level reads operate on: the workspace repo, optionally narrowed
 * to one content root. The repo is a WORKSPACE-level thing (§10) — an app is
 * just one lens on it — so functions like status/history/branches take this
 * instead of an IAppProject, and the Source Control surface needs no app
 * handle at all.
 */
export interface RepoScope {
  workspaceId: string;
  /** Repo-relative content root to filter to; null = the whole repo. */
  root: string | null;
  defaultBranch: string;
  /** Present when the scope is one app (window pokes carry the app id). */
  projectId?: Types.ObjectId;
}

/** Scope of one app: its folder, its default branch. */
export function scopeOf(project: IAppProject): RepoScope {
  return {
    workspaceId: project.workspaceId.toString(),
    root: appRootFor(project),
    defaultBranch: project.defaultBranch || DEFAULT_BRANCH,
    projectId: project._id,
  };
}

/** Scope of the whole workspace repo. */
export function workspaceScope(workspaceId: string): RepoScope {
  return { workspaceId, root: null, defaultBranch: DEFAULT_BRANCH };
}

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
const actorIdentityCache = new Map<
  string,
  { name: string; email: string } | undefined
>();

export async function resolveActorIdentity(
  userId: string,
): Promise<{ name: string; email: string } | undefined> {
  if (actorIdentityCache.has(userId)) return actorIdentityCache.get(userId);
  let identity: { name: string; email: string } | undefined;
  try {
    const user = await User.findById(userId).select("email").lean<{
      email?: string;
    } | null>();
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
const lastPull = new Map<string, number>();

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

/**
 * Where a publish parks the merge result while it is being built.
 *
 * It has to live in the repo rather than in a working directory: the scratch
 * clone that produced it is deleted immediately, and the sandbox has to be
 * moved onto exactly this commit so that what gets built is what would ship.
 */
const PUBLISH_CANDIDATE_REF = "refs/mako/publish-candidate";

/**
 * Run a git operation in a throwaway checkout of `ref`.
 *
 * Some server-side git genuinely needs a working directory — a merge does —
 * but that is not a reason to keep a long-lived one around. This one exists
 * for the length of the call and is deleted afterwards, so it can never drift,
 * be edited, or become a second opinion about the state of the app.
 */
async function scratchCheckout<T>(
  repoDir: string,
  ref: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mako-scratch-"));
  try {
    await runGit(["clone", "--quiet", "--branch", ref, repoDir, dir], {
      timeoutMs: 120_000,
    });
    await runGit(["-C", dir, "config", "user.name", "Mako"]);
    await runGit(["-C", dir, "config", "user.email", "publish@mako.ai"]);
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Set a ref unconditionally (used for refs only this process writes). */
async function updateRef(
  repoDir: string,
  ref: string,
  oid: string,
): Promise<void> {
  await runGit(["-C", repoDir, "update-ref", ref, oid]);
}

// ---------------------------------------------------------------------------
// Project lifecycle
// ---------------------------------------------------------------------------

export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return base || "app";
}

/** Where a new app goes: a folder chain in one of the two trees. */
export interface AppFolderTarget {
  scope: AppScope;
  /** Required for `private`: the owner of the `users/<id>/apps` tree. */
  ownerId?: string;
  folderSegments: string[];
}

/** Parse a folder path (`apps/Sales`, `users/<id>/apps`) into a target. */
export function folderTargetFromPath(folderPath: string): AppFolderTarget {
  const parsed = parseAppFolderPath(
    folderPath.trim().normalize("NFC").replace(/\/+$/, ""),
  );
  if (!parsed) {
    throw new AppFolderError(
      `Not an app folder: ${JSON.stringify(folderPath)} (expected apps/… or users/<id>/apps/…)`,
    );
  }
  return parsed;
}

/**
 * Every path an app occupies or could not occupy: the index's paths, the
 * project rows' paths (an app whose folder left main still holds its old
 * address until the row is deleted), and the folders themselves.
 */
async function occupiedPaths(workspaceId: string): Promise<Set<string>> {
  const snapshot = await loadAppsIndex(workspaceId);
  const taken = new Set<string>(snapshot.folders);
  for (const app of snapshot.apps) taken.add(app.path);
  const rows = await AppProject.find({
    workspaceId: new Types.ObjectId(workspaceId),
    path: { $exists: true },
  })
    .select("path")
    .lean();
  for (const row of rows) if (row.path) taken.add(row.path);
  return taken;
}

async function uniqueSlug(
  workspaceId: string,
  title: string,
  target: AppFolderTarget,
): Promise<string> {
  const base = slugify(title);
  const taken = await occupiedPaths(workspaceId);
  // The FOLDER typed in another case than one that exists (apps/Sales
  // next to apps/sales) is a refusal: no slug inside it is ever free, so
  // counting up would never end.
  const folder = folderPathOf(target);
  const folderTwin = caseTwinOf(taken, folder);
  if (folderTwin) {
    throw caseTwinError(
      folderTwin,
      folder,
      await loadAppsIndex(workspaceId),
      taken,
    );
  }
  // Free in git AND in a case-insensitive checkout: with the folder chain
  // clear, a twin can only be of the slug itself.
  // …and a name a new app may take at all: never a Windows device name
  // (`Con` → `con-2`) nor one that reads as an id.
  const free = (slug: string) => {
    if (newSegmentProblem(slug)) return false;
    const at = appRepoPath({ ...target, slug });
    return !taken.has(at) && !caseTwinOf(taken, at);
  };
  if (free(base)) return base;
  for (let i = 2; i <= MAX_SLUG_SUFFIX; i++) {
    const candidate = `${base}-${i}`;
    if (free(candidate)) return candidate;
  }
  throw new AppFolderError(
    `No free folder name for "${title}" in ${folder} (tried ${base} to ${base}-${MAX_SLUG_SUFFIX}); give the app another name.`,
    409,
  );
}

/** How far uniqueSlug counts (`report-2` … `report-1000`) before it gives up. */
const MAX_SLUG_SUFFIX = 1000;

/** Remove `dir` and its parents while they are empty, never `root`. */
async function removeEmptyDirsUp(dir: string, root: string): Promise<void> {
  let current = dir;
  while (current.startsWith(`${root}${path.sep}`)) {
    try {
      await fs.rmdir(current);
    } catch {
      return; // not empty (or gone): the rest above it stays
    }
    current = path.dirname(current);
  }
}

/** What one lifecycle commit changes (see {@link commitFilesOnBranch}). */
export interface LifecycleMutation {
  writes?: Record<string, string>;
  deletePrefixes?: string[];
  moves?: Array<{ from: string; to: string }>;
}

/**
 * Commit a mutation (writes, prefix deletions and/or directory moves)
 * directly onto a branch of the bare repo via a throwaway clone. Used for app
 * lifecycle commits (scaffold, move, delete) and by the v1→v2 migrator —
 * actor worktrees are not involved. Moves run first, then deletions, then
 * writes, so a write can land inside a just-moved folder.
 *
 * The ref is swapped compare-and-set, and a lost swap is retried on the new
 * head. A change DECIDED from what main held — a manifest to rewrite, a
 * folder to move, a path to fill — must therefore be a function: it is
 * re-run against each head it is about to land on (and may throw when that
 * head no longer allows it, or return null when there is nothing left to
 * do). Re-applying a change computed from an older head would write a
 * stale manifest over a save that landed in between, bring back an app
 * deleted in between, or move a folder that is no longer there.
 */
export async function commitFilesOnBranch(
  repoDir: string,
  branch: string,
  mutation:
    | LifecycleMutation
    | ((head: string) => Promise<LifecycleMutation | null>),
  options: {
    message: string;
    author?: GitAuthor;
    /**
     * Called with the new commit right before main is swapped to it; the
     * function it returns is called if the swap is lost. (Lifecycle
     * commits hold themselves back from the index until durable.)
     */
    beforeSwap?: (commitOid: string) => () => void;
  },
): Promise<{ commitOid: string; previousHead: string; unchanged?: true }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await resolveCommit(repoDir, `refs/heads/${branch}`);
    if (!head) throw new Error(`Branch ${branch} is missing`);
    const change =
      typeof mutation === "function" ? await mutation(head) : mutation;
    if (!change) {
      return { commitOid: head, previousHead: head, unchanged: true };
    }
    await fs.mkdir(appsSessionsRoot(), { recursive: true });
    const tmp = await fs.mkdtemp(path.join(appsSessionsRoot(), "lifecycle-"));
    try {
      await runGit(["clone", "--branch", branch, repoDir, tmp], {
        timeoutMs: 120_000,
      });
      // The tree must be built from `head` itself: the clone takes the
      // branch as it is NOW, which a writer may have moved since.
      await runGit(["-C", tmp, "reset", "-q", "--hard", head]);
      for (const [i, move] of (change.moves ?? []).entries()) {
        const from = path.join(tmp, assertSafeRelPath(move.from));
        const to = path.join(tmp, assertSafeRelPath(move.to));
        // A static change cannot re-check itself: never let the file
        // system's ENOENT / ENOTEMPTY (with this clone's path in it) be
        // the answer, nor a move merge one folder into another.
        if (!(await pathExists(from))) {
          throw new AppFolderError(
            `${move.from} is no longer on ${branch}: it was moved or deleted meanwhile`,
            409,
          );
        }
        // Through a parking name, with the folders it empties removed
        // first: on a case-insensitive disk (macOS) `apps/Team/x` IS
        // `apps/team/x` while `team` still exists, and a direct rename
        // would keep the old case in the snapshot.
        const parked = path.join(tmp, `.mako-move-${i}`);
        await fs.rename(from, parked);
        await removeEmptyDirsUp(path.dirname(from), tmp);
        // Only now, with the source out of the way: on such a disk the
        // target "exists" while it is the source in another case.
        if (await pathExists(to)) {
          throw new AppFolderError(`${move.to} already exists`, 409);
        }
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.rename(parked, to);
      }
      for (const prefix of change.deletePrefixes ?? []) {
        await fs.rm(path.join(tmp, assertSafeRelPath(prefix)), {
          recursive: true,
          force: true,
        });
      }
      for (const [rel, contents] of Object.entries(change.writes ?? {})) {
        const abs = path.join(tmp, assertSafeRelPath(rel));
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, contents, "utf8");
      }
      const treeOid = await snapshotDirToTree(repoDir, tmp);
      const commitOid = await commitTree(repoDir, {
        treeOid,
        parents: [head],
        message: options.message,
        author: options.author,
      });
      const undo = options.beforeSwap?.(commitOid);
      const swapped = await updateRefCas(
        repoDir,
        `refs/heads/${branch}`,
        commitOid,
        head,
      ).catch((error: unknown) => {
        undo?.();
        throw error;
      });
      if (swapped) return { commitOid, previousHead: head };
      undo?.();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
  throw new WorktreeConflictError(
    `Branch ${branch} kept advancing during a lifecycle commit; retry.`,
  );
}

async function pathExists(abs: string): Promise<boolean> {
  return fs.lstat(abs).then(
    () => true,
    () => false,
  );
}

/** Create an app: its state row and its scaffold, one commit on main. */
export async function createProject(
  input: CreateProjectInput,
): Promise<IAppProject> {
  return (await createProjectWith(input)).project;
}

type CreateProjectInput = {
  workspaceId: string;
  title: string;
  description?: string;
  userId?: string;
  author?: GitAuthor;
  /**
   * Force an exact slug instead of deriving a unique one from the title. The
   * caller owns uniqueness — used by the v1→v2 migration, which assigns each
   * app a deterministic slug and clears any prior occupant first, so a re-run
   * overwrites in place rather than spawning a "…-2" duplicate.
   */
  slug?: string;
  /**
   * Where to file it. Default: the top of the workspace tree (`apps/`). A
   * `private` target puts it under the creator's `users/<id>/apps/`.
   */
  folder?: AppFolderTarget;
};

/**
 * {@link createProject}, also saying whose old link the new app takes over
 * ({@link linkTakeovers}): a new app at another app's old name opens on
 * that link from now on — every caller warns (supersessionWarnings).
 */
export async function createProjectWith(input: CreateProjectInput): Promise<{
  project: IAppProject;
  takenOver: SupersededAlias[];
}> {
  // An empty (or invisible) name is "Untitled app", as it always was; a
  // name with control characters, or an essay, is refused before anything
  // is written (a NUL cannot even reach the commit message).
  const typed = normalizeName(input.title);
  const title = typed.replace(/[\s\p{Cf}]/gu, "") ? typed : "Untitled app";
  const titleProblem = appTitleProblem(title);
  if (titleProblem) throw new AppFolderError(titleProblem);
  // Git first (#956): do not init a local-only repo that then lets consoles,
  // dbt, and prompt writes skip the 412. A GitHub binding (or a test that
  // already seeded the bare repo) is required.
  const repoDir = await requireWorkspaceRepo(input.workspaceId);
  const mirror = await resolveMirrorTarget(input.workspaceId);
  const target: AppFolderTarget = normalizedTarget(
    input.folder ?? { scope: "workspace", folderSegments: [] },
  );
  if (target.scope === "private") {
    target.ownerId = target.ownerId ?? input.userId;
    if (!target.ownerId) {
      throw new Error("A personal app needs a signed-in owner");
    }
  }
  assertNewFolderNames(target, await loadAppsIndex(input.workspaceId));
  const slug =
    input.slug ?? (await uniqueSlug(input.workspaceId, title, target));
  const appPath = appRepoPath({ ...target, slug });
  // Never scaffold inside another app: the outer folder would swallow it
  // (the index files one app per outermost manifest) and the row would be
  // orphaned while the parent redeploys with a stranger's files.
  const before = await loadAppsIndex(input.workspaceId);
  const parentApp = before.apps.find(a => isWithin(appPath, a.path));
  if (parentApp) {
    throw new AppFolderError(`${parentApp.path} is an app, not a folder`, 409);
  }
  const takenOver = linkTakeovers(before.apps, appPath);
  const project = await AppProject.create({
    workspaceId: new Types.ObjectId(input.workspaceId),
    title,
    slug,
    path: appPath,
    description: input.description,
    access: "private",
    owner_id: input.userId,
    createdBy: input.userId ?? "system",
    defaultBranch: DEFAULT_BRANCH,
  });

  // §10 monorepo: commit the scaffold under its folder onto main. The row's
  // id goes into the manifest: that is the app's identity from here on,
  // whatever folder it is later filed under.
  let scaffoldCommit: { commitOid: string; previousHead: string } | null = null;
  let releaseScaffold: (() => void) | undefined;
  try {
    const scaffold = createAppsScaffold({
      title: project.title,
      description: input.description,
      id: project._id.toString(),
    });
    const prefixed: Record<string, string> = {};
    for (const [rel, contents] of Object.entries(scaffold)) {
      prefixed[`${appPath}/${rel}`] = contents;
    }
    scaffoldCommit = await commitFilesOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      // Re-checked on every head the commit is about to land on: an app or
      // folder that appeared at this path meanwhile (a laptop push, another
      // instance) must never get a scaffold written into it.
      async () => {
        const now = await loadAppsIndex(input.workspaceId, { freshen: false });
        const there = new Set([...now.folders, ...now.apps.map(a => a.path)]);
        if (
          there.has(appPath) ||
          caseTwinOf(there, appPath) ||
          now.apps.some(a => isWithin(appPath, a.path))
        ) {
          throw new AppFolderError(
            `${appPath} was taken meanwhile; create the app again`,
            409,
          );
        }
        return { writes: prefixed };
      },
      {
        // Not durable until the mirror has it: no read indexes it before.
        ...(mirror
          ? {
              beforeSwap: (oid: string) =>
                (releaseScaffold = holdBackCommit(input.workspaceId, oid)),
            }
          : {}),
        message: `Create app "${title}" (${appPath})`,
        // The person who created it, as for a rename or move; the
        // committer stays Mako, and nobody behind the call (a workspace
        // API key) keeps Mako as the author.
        author: input.author ?? (await authorForUser(input.userId)),
      },
    );
  } catch (error) {
    // Don't leave a content-less project behind.
    await AppProject.deleteOne({
      _id: project._id,
      workspaceId: project.workspaceId,
    });
    throw error;
  }
  // Durable tier (§13.17): the connected repo. When one is bound, the
  // durable push is REQUIRED — on serverless hosts the local repo is an
  // ephemeral cache. Hosts without a binding (dev, previews) stay local-only.
  try {
    if (mirror) {
      await mirrorPushNow(input.workspaceId);
    }
    releaseScaffold?.();
  } catch (error) {
    releaseScaffold?.();
    await AppProject.deleteOne({
      _id: project._id,
      workspaceId: project.workspaceId,
    });
    // Roll the scaffold commit back so the repo matches the docs. The CAS
    // returns false (it does not throw) when main moved on meanwhile; that
    // leaves the scaffold on a tip the mirror never received — say so.
    const rolledBack = await updateRefCas(
      repoDir,
      `refs/heads/${DEFAULT_BRANCH}`,
      scaffoldCommit.previousHead,
      scaffoldCommit.commitOid,
    ).catch(() => false);
    if (!rolledBack) {
      logger.warn("Apps scaffold rollback skipped: main moved on", {
        projectId: project._id.toString(),
        commit: scaffoldCommit.commitOid,
      });
    } else {
      await forgetRolledBackCommit(
        input.workspaceId,
        scaffoldCommit.commitOid,
      ).catch(() => undefined);
    }
    logger.error("Apps creation aborted: durable push failed", {
      projectId: project._id.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(
      `Could not store the app durably (GitHub push failed): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  logger.info("Apps project created", {
    projectId: project._id.toString(),
    workspaceId: input.workspaceId,
    path: appPath,
  });
  // The list must show the new app on the very next read, on this instance
  // and every other: the index is keyed by main's sha, which just moved.
  await syncAppsIndexFromRepo(input.workspaceId).catch(() => undefined);
  pokeApp(project.workspaceId, project._id, "lifecycle", input.userId);
  return { project, takenOver };
}

export async function deleteProject(project: IAppProject): Promise<void> {
  // §10 monorepo: deleting an app is a COMMIT removing its folder — the
  // workspace repo (and other apps, worktrees, history) are untouched.
  const workspaceId = project.workspaceId.toString();
  const repoDir = await repoForWorkspace(workspaceId);
  if (await repoExists(repoDir)) {
    const id = project._id.toString();
    await commitFilesOnBranch(
      repoDir,
      project.defaultBranch || DEFAULT_BRANCH,
      // The app where it is on the head the commit lands on (by id): a
      // rename that landed meanwhile must not leave it alive at its new
      // name — nor may the delete take out ANOTHER app that has since
      // arrived at this one's old folder.
      async () => {
        const now = await loadAppsIndex(workspaceId, { freshen: false });
        const at = now.apps.find(a => a.appId === id)?.path;
        if (at) return { deletePrefixes: [at] };
        const stale = appRootFor(project);
        return now.apps.some(
          a => isWithin(a.path, stale) || isWithin(stale, a.path),
        )
          ? null
          : { deletePrefixes: [stale] };
      },
      { message: `Delete app "${project.title}" (${appRootFor(project)})` },
    );
    queueMirrorPush(workspaceId);
  }
  await AppProject.deleteOne({
    _id: project._id,
    workspaceId: project.workspaceId,
  });
  await syncAppsIndexFromRepo(project.workspaceId.toString()).catch(
    () => undefined,
  );
  pokeApp(project.workspaceId, project._id, "lifecycle");
}

// ---------------------------------------------------------------------------
// Folders: real directories, moved with real commits
// ---------------------------------------------------------------------------

export class AppFolderError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "AppFolderError";
  }
}

function folderPathOf(target: AppFolderTarget): string {
  for (const seg of target.folderSegments) {
    if (!isSafeSegment(seg)) {
      throw new AppFolderError(`Invalid folder name: ${JSON.stringify(seg)}`);
    }
  }
  return [
    appTreeRoot(target.scope, target.ownerId),
    ...target.folderSegments,
  ].join("/");
}

/** A target as it will be stored: every folder name in NFC (normalizeName). */
function normalizedTarget<T extends AppFolderTarget>(target: T): T {
  return {
    ...target,
    folderSegments: target.folderSegments.map(seg => seg.normalize("NFC")),
  };
}

/**
 * Refuse a folder chain whose NEW folders — the ones the commit would
 * create — carry a name {@link newSegmentProblem} forbids. A folder that
 * already exists (listed, or the parent of an app) is not being named now:
 * an old `con` folder pushed from a laptop stays usable, and an app can be
 * moved out of it.
 */
function assertNewFolderNames(
  target: AppFolderTarget,
  snapshot: {
    folders: readonly string[];
    apps: ReadonlyArray<{ path: string }>;
  },
): void {
  let at = folderPathOf({ ...target, folderSegments: [] });
  for (const seg of target.folderSegments) {
    at = `${at}/${seg}`;
    const exists =
      snapshot.folders.includes(at) ||
      snapshot.apps.some(app => app.path.startsWith(`${at}/`));
    if (exists) continue;
    const problem = newSegmentProblem(seg);
    if (problem) {
      throw new AppFolderError(
        `Invalid folder name: ${JSON.stringify(seg)} — ${problem}`,
      );
    }
  }
}

/** Is `candidate` the app itself or something inside it? */
function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

/**
 * The app (by id) is still at `from` in `snapshot` — or the refusal that
 * says where it went: moved (409, from there) or gone (404). A path match
 * alone is not enough: another app may have arrived at the old folder.
 */
function assertStillAt(
  snapshot: AppsIndexSnapshot,
  appId: string,
  from: string,
): void {
  const now = snapshot.apps.find(a => a.appId === appId);
  if (now?.path === from) return;
  if (now) {
    throw new AppFolderError(
      `The app was moved to ${now.path} meanwhile; try again from there`,
      409,
    );
  }
  throw new AppFolderError(`App folder ${from} is not on main`, 404);
}

/**
 * Manifest writes that pin every app under `dir` to the id the index already
 * knows it by — so a move never changes an identity, even for an app that
 * predates manifest ids — and, when an app's FOLDER NAME changes, record
 * the old one as an alias in the SAME commit, so the old link keeps opening
 * it (the planner is {@link aliasesForMoves}; the lookup is
 * findAppInSnapshot). An app whose name does not change (filed elsewhere,
 * or carried along by a folder move) gets no write at all when it already
 * carries its id: its tree stays as it was and nothing rebuilds; the index
 * records its old path itself. Paths are the NEW ones (post-move).
 *
 * A manifest that cannot be parsed stops the move: the alias has to be
 * written INTO it, and writing a fresh manifest over whatever the user had
 * there would lose their work. They fix the file, then move.
 *
 * `manifestPatch` is a rename's title change, applied to that app's
 * manifest in the same write — one commit per rename, whatever it changes.
 *
 * A name the moved app is leaving may already be an OLD name of another
 * app (that app was renamed away from it first, then this one was created
 * there). Two claims would make the link die; instead the most recent
 * holder keeps it — while this app sat there, the link opened this app
 * anyway. The older claim is superseded in the INDEX on the sync that
 * follows (`supersededAliases`, re-derived from history on every rebuild
 * by walkHistory); the other app's manifest is never touched: it may be
 * someone else's private app, and a write there would rebuild and
 * redeploy it. `superseded` says which apps, for the caller's warning.
 */
export interface SupersededAlias {
  /** The name, as the new holder's manifest records it. */
  name: string;
  /** The app that loses its claim. */
  appId: string;
  path: string;
  title: string;
  /**
   * The app now SITS at the name (created there, or moved or renamed onto
   * it) rather than keeping it as an old name: see {@link linkTakeovers}.
   */
  takenOver?: boolean;
}

/**
 * The apps that lose an old link when an app ARRIVES at `path` — created
 * there, or moved or renamed onto it: every OTHER app whose aliases name
 * that path. A current name beats any alias, so the link opens the
 * newcomer from now on. A nested or personal path takes no bare name (a
 * bare `/apps/<name>` is a top-level link), exactly as findAppInSnapshot
 * resolves. A claim the index already parked (another app held it more
 * recently) is not in `aliases`, so it is not reported twice. Pure.
 */
export function linkTakeovers(
  apps: readonly AppIndexRow[],
  path: string,
  appId?: string,
): SupersededAlias[] {
  const name = aliasForOldPath(path);
  return apps
    .filter(
      other =>
        other.appId !== appId &&
        !other.duplicateOf &&
        other.path !== path &&
        other.aliases.some(alias => aliasMatchesRef(alias, path)),
    )
    .map(other => ({
      name,
      appId: other.appId,
      path: other.path,
      title: other.title,
      takenOver: true,
    }));
}

/**
 * The refusal for a move onto a path something already occupies, in the
 * words a person used: a top-level app's folder name IS its link.
 */
function occupiedPathError(
  to: string,
  snapshot: { folders: readonly string[] },
): AppFolderError {
  const slug = to.split("/").pop() ?? to;
  const parent = to.slice(0, to.length - slug.length - 1);
  if (snapshot.folders.includes(to)) {
    return new AppFolderError(
      `A folder named "${slug}" already exists in ${parent}.`,
      409,
    );
  }
  if (to === `apps/${slug}`) {
    return new AppFolderError(
      `An app already uses the link /apps/${slug}.`,
      409,
    );
  }
  return new AppFolderError(
    `An app named "${slug}" already exists in ${parent}.`,
    409,
  );
}

/**
 * `taken` as it will be once `leaving` (an app or folder being moved) has
 * gone: without it and everything in it, and without each folder above it
 * that held nothing else and no `.gitkeep` — git drops a directory that
 * empties, so a case variant of it is free after the move (an app alone
 * in apps/team may move to apps/Team).
 */
async function occupiedAfterLeaving(
  repoDir: string,
  taken: ReadonlySet<string>,
  leaving: string,
): Promise<Set<string>> {
  const rest = new Set([...taken].filter(path => !isWithin(path, leaving)));
  const parts = leaving.split("/");
  for (let i = parts.length - 1; i >= 1; i--) {
    const folder = parts.slice(0, i).join("/");
    // The tree roots (`apps`, `users/<id>/apps`) never go.
    if (!parseAppFolderPath(folder)?.folderSegments.length) break;
    const holdsOther = [...rest].some(
      path => path !== folder && isWithin(path, folder),
    );
    if (holdsOther) break;
    const marked = await readBlob(
      repoDir,
      DEFAULT_BRANCH,
      `${folder}/${FOLDER_KEEP_FILE}`,
    ).then(
      () => true,
      () => false,
    );
    if (marked) break;
    rest.delete(folder);
  }
  return rest;
}

/**
 * {@link occupiedPathError} for a case twin ({@link caseTwinOf}): an app,
 * or a folder (listed, or only the parent of something in `taken`).
 */
function caseTwinError(
  twin: string,
  to: string,
  snapshot: { folders: readonly string[] },
  taken: ReadonlySet<string>,
): AppFolderError {
  const wanted = to.split("/")[twin.split("/").length - 1] ?? to;
  const isFolder = snapshot.folders.includes(twin) || !taken.has(twin);
  const occupied = occupiedPathError(twin, {
    folders: isFolder ? [twin] : [],
  }).message;
  return new AppFolderError(
    `${occupied} "${wanted}" differs from it only in upper/lower case, and a checkout on macOS or Windows cannot tell the two apart.`,
    409,
  );
}

async function moveWritesUnder(
  workspaceId: string,
  repoDir: string,
  moves: Array<{ from: string; to: string }>,
  manifestPatch?: { path: string; title?: string },
): Promise<{ writes: Record<string, string>; superseded: SupersededAlias[] }> {
  const snapshot = await loadAppsIndex(workspaceId, { freshen: false });
  const plans = aliasesForMoves(snapshot.apps, moves);
  const writes: Record<string, string> = {};
  const superseded: SupersededAlias[] = [];
  const readAt = async (rel: string): Promise<string | null> => {
    try {
      return (await readBlob(repoDir, DEFAULT_BRANCH, rel)).contents;
    } catch {
      return null;
    }
  };
  const unparseable = (app: AppIndexRow) =>
    new AppFolderError(
      `${app.path}/${APP_MANIFEST} cannot be parsed; fix it before moving or renaming the app`,
      409,
    );
  for (const app of snapshot.apps) {
    const move = moves.find(m => isWithin(app.path, m.from));
    if (!move) continue;
    const newPath = `${move.to}${app.path.slice(move.from.length)}`;
    // The name it arrives at may be another app's OLD name: that link
    // opens this app from now on.
    superseded.push(...linkTakeovers(snapshot.apps, newPath, app.appId));
    let manifest = await readAt(`${app.path}/${APP_MANIFEST}`);
    const original = manifest;
    if (!app.hasManifestId) {
      manifest = stampManifestId(manifest, app.appId);
      if (manifest === null) throw unparseable(app);
    }
    // A copy that is given its own id here (its manifest still declared
    // the source's) gives up the source's aliases with it, as stampAppId
    // does — or the two would claim the same old names and neither would
    // answer to them.
    if (app.duplicateOf) {
      manifest = stripManifestAliases(manifest);
      if (manifest === null) throw unparseable(app);
    }
    const plan = plans.get(app.path);
    if (plan && plan.add.length > 0) {
      manifest = addManifestAliases(
        manifest,
        plan.add,
        plan.drop,
        MAX_ALIASES_PER_APP,
      );
      if (manifest === null) throw unparseable(app);
      for (const name of plan.add) {
        for (const other of snapshot.apps) {
          if (other.appId === app.appId || other.duplicateOf) continue;
          if (!other.aliases.some(alias => aliasMatchesRef(alias, name))) {
            continue;
          }
          superseded.push({
            name,
            appId: other.appId,
            path: other.path,
            title: other.title,
          });
        }
      }
    }
    if (manifestPatch?.path === app.path && manifestPatch.title !== undefined) {
      manifest = setManifestTitle(manifest, manifestPatch.title);
      if (manifest === null) throw unparseable(app);
    }
    if (manifest !== null && manifest !== original) {
      writes[`${newPath}/${APP_MANIFEST}`] = manifest;
    }
    // A pre-npm `file:../../packages/app-sdk` dependency is relative to the
    // app's depth: it breaks the moment the folder moves. Point it at the
    // registry package the scaffold uses.
    const pkgRaw = await readAt(`${app.path}/package.json`);
    if (pkgRaw) {
      try {
        const pkg = JSON.parse(pkgRaw) as {
          dependencies?: Record<string, string>;
        };
        const dep = pkg.dependencies?.["@makoai/app-sdk"];
        if (typeof dep === "string" && dep.startsWith("file:")) {
          pkg.dependencies = { ...pkg.dependencies, ...appSdkDependency() };
          writes[`${newPath}/package.json`] =
            `${JSON.stringify(pkg, null, 2)}\n`;
        }
      } catch {
        // Not JSON: leave it to the user.
      }
    }
  }
  return { writes, superseded };
}

/**
 * A lifecycle commit on main that must reach the durable mirror: on
 * serverless hosts the local repo is a cache, so a commit the mirror never
 * received would be a commit that never happened. Rolled back on failure,
 * as createProject does.
 */
async function commitOnMainDurably(
  workspaceId: string,
  repoDir: string,
  /**
   * The change, or a function computing it. A function runs AFTER the
   * freshen below, so anything it reads from main (a manifest to stamp, a
   * package.json to rewrite) is the mirror's current content, not a copy
   * a laptop push has since replaced — and it runs again on every head
   * the commit is retried on (commitFilesOnBranch), so a change decided
   * from main is never applied to a main it was not decided from. It
   * re-checks what it relies on (the app is still there, the target is
   * still free) and returns null when nothing is left to do.
   */
  mutation: LifecycleMutation | (() => Promise<LifecycleMutation | null>),
  options: { message: string; author?: GitAuthor },
): Promise<{ commitOid: string; unchanged?: true }> {
  const mirror = await resolveMirrorTarget(workspaceId);
  // Commit onto the mirror's main, not a stale local copy of it — a laptop
  // push this instance has not seen would make the result unmirrorable.
  await freshenBeforeMainWrite(workspaceId);
  invalidateAppsIndexCache(workspaceId);
  // Not durable until the mirror has it: no read indexes it before then.
  let release: (() => void) | undefined;
  const commit = await commitFilesOnBranch(
    repoDir,
    DEFAULT_BRANCH,
    typeof mutation === "function" ? () => mutation() : mutation,
    {
      ...options,
      ...(mirror
        ? {
            beforeSwap: (oid: string) =>
              (release = holdBackCommit(workspaceId, oid)),
          }
        : {}),
    },
  );
  if (commit.unchanged) return { commitOid: commit.commitOid, unchanged: true };
  try {
    if (mirror) await mirrorPushNow(workspaceId);
    release?.();
  } catch (error) {
    // The CAS returns false (it does not throw) when main moved on
    // meanwhile; the commit then stays on a local tip the mirror never got.
    const rolledBack = await updateRefCas(
      repoDir,
      `refs/heads/${DEFAULT_BRANCH}`,
      commit.previousHead,
      commit.commitOid,
    ).catch(() => false);
    release?.();
    if (!rolledBack) {
      logger.warn("Apps lifecycle commit rollback skipped: main moved on", {
        workspaceId,
        commit: commit.commitOid,
      });
    } else {
      await forgetRolledBackCommit(workspaceId, commit.commitOid).catch(
        () => undefined,
      );
    }
    throw new Error(
      `Could not store the change durably (GitHub push failed): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  invalidateAppsIndexCache(workspaceId);
  await syncAppsIndexFromRepo(workspaceId).catch(() => undefined);
  return { commitOid: commit.commitOid };
}

/**
 * File an app somewhere else: `git mv` of its folder, as one commit on main.
 * The app keeps its id (stamped into the manifest in the same commit if it
 * had none), so deployments, sharing, env vars and favourites all follow it.
 * Filed elsewhere under the same name, an app that already carries its id
 * keeps its tree oid and nothing rebuilds (deploy-on-push keys on that; a
 * stamp is a manifest write, so a pre-ids app rebuilds once); the index
 * records the old path so old refs keep resolving. RENAMED (a new folder
 * name), the old name becomes an alias in the manifest in the same commit —
 * so the old `/apps/<slug>` link keeps opening it — and that one manifest
 * write is what deploy-on-push rebuilds once. `warnings` says when that
 * old name was another app's old name too (that app stops answering to it;
 * see moveWritesUnder) — every caller shows them.
 */
export async function moveProject(
  project: IAppProject,
  target: AppFolderTarget & { slug?: string },
  options: { userId?: string; role?: string; author?: GitAuthor } = {},
): Promise<{ from: string; to: string; warnings: string[] }> {
  const { from, to, superseded } = await moveProjectWith(
    project,
    target,
    options,
  );
  return {
    from,
    to,
    warnings: await supersessionWarnings(
      project.workspaceId.toString(),
      options.userId,
      options.role,
      project.title ?? to.split("/").pop() ?? "",
      superseded,
    ),
  };
}

/**
 * What the caller must know when a link changes hands: a name a rename
 * keeps as an alias was also another app's old name (the link now opens
 * the renamed app, and the other app no longer answers to it), or the app
 * arrived at another app's old name ({@link linkTakeovers}: created there,
 * or moved or renamed onto it). The other app is named only when the
 * caller may see it (a workspace API key with nobody behind it sees all).
 */
export async function supersessionWarnings(
  workspaceId: string,
  userId: string | undefined,
  role: string | undefined,
  newTitle: string,
  superseded: readonly SupersededAlias[],
): Promise<string[]> {
  const warnings: string[] = [];
  for (const entry of superseded) {
    let other = "another app";
    if (!userId) {
      other = `"${entry.title}" (${entry.path})`;
    } else {
      const state = await AppProject.findOne({
        _id: new Types.ObjectId(entry.appId),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      const row = await resolveAppRef(workspaceId, entry.appId);
      const resource =
        state ?? (row ? projectFromIndexRow(workspaceId, row) : null);
      if (resource && canReadResource(resource, userId, role)) {
        other = `"${entry.title}" (${entry.path})`;
      }
    }
    const link = entry.name.includes("/")
      ? entry.name
      : `/apps/${encodeURIComponent(entry.name)}`;
    warnings.push(
      entry.takenOver
        ? // Named: the warning can show while another app is on screen
          // (the explorer's snackbar after a create or rename).
          `${link} used to open ${other}; it now opens "${newTitle}".`
        : `${link} now opens "${newTitle}"; it was also an old name of ${other}, which no longer answers to it.`,
    );
  }
  return warnings;
}

/**
 * Rename an app — its display name (`title` in mako.json), its folder name
 * (the slug its link is made of), or both — as ONE commit on main. The
 * service behind every rename path (the explorer's dialog, the REST
 * `objects/app/rename` route, the agent's `rename_object`): a slug change is
 * a move within the app's own folder, so it records the old slug as an
 * alias exactly as app_move_app does; a title change rewrites the manifest
 * (the AppProject row and the index follow on the sync).
 */
export async function renameProject(
  project: IAppProject,
  change: { title?: string; slug?: string },
  options: { userId?: string; author?: GitAuthor } = {},
): Promise<{
  from: string;
  to: string;
  title: string;
  commit?: string;
  aliasesAdded: string[];
  /**
   * Other apps' older claims to the names added: reported, never rewritten
   * (their manifests are not this caller's to change); the index records
   * the supersession.
   */
  superseded: SupersededAlias[];
}> {
  const workspaceId = project.workspaceId.toString();
  const from = appRootFor(project);
  const location = parseAppRepoPath(from);
  if (!location) throw new AppFolderError(`Not an app path: ${from}`, 404);
  const title =
    change.title === undefined ? undefined : normalizeName(change.title);
  if (title !== undefined) {
    const problem = appTitleProblem(title);
    if (problem) throw new AppFolderError(problem);
  }
  const currentTitle = project.title ?? location.slug;
  const titleChanges = title !== undefined && title !== currentTitle;
  const slug =
    change.slug === undefined ? location.slug : normalizeName(change.slug);
  if (slug !== location.slug) {
    const { to, commit, aliasesAdded, superseded } = await moveProjectWith(
      project,
      { ...location, slug },
      options,
      titleChanges ? { title } : undefined,
    );
    if (titleChanges) {
      project.title = title;
      await AppProject.updateOne(
        { _id: project._id, workspaceId: project.workspaceId },
        { $set: { title } },
      );
    }
    return {
      from,
      to,
      title: titleChanges ? title : currentTitle,
      commit,
      aliasesAdded,
      superseded,
    };
  }
  if (!titleChanges) {
    return {
      from,
      to: from,
      title: currentTitle,
      aliasesAdded: [],
      superseded: [],
    };
  }
  const repoDir = await requireWorkspaceRepo(workspaceId);
  const manifestPath = `${from}/${APP_MANIFEST}`;
  const { commitOid } = await commitOnMainDurably(
    workspaceId,
    repoDir,
    async () => {
      // Re-run on every head the commit is about to land on: the manifest
      // is read from THAT head, so a save or push in between is kept, and
      // an app deleted or moved in between is not written back.
      assertStillAt(
        await loadAppsIndex(workspaceId, { freshen: false }),
        project._id.toString(),
        from,
      );
      let contents: string | null;
      try {
        contents = (await readBlob(repoDir, DEFAULT_BRANCH, manifestPath))
          .contents;
      } catch {
        contents = null;
      }
      const next = setManifestTitle(contents, title);
      if (next === null) {
        throw new AppFolderError(
          `${manifestPath} cannot be parsed; fix it before renaming the app`,
          409,
        );
      }
      return { writes: { [manifestPath]: next } };
    },
    {
      message: `Rename app "${currentTitle}" to "${title}" (${from})`,
      author: options.author ?? (await authorForUser(options.userId)),
    },
  );
  project.title = title;
  await AppProject.updateOne(
    { _id: project._id, workspaceId: project.workspaceId },
    { $set: { title } },
  );
  pokeApp(project.workspaceId, project._id, "lifecycle", options.userId);
  return {
    from,
    to: from,
    title,
    commit: commitOid,
    aliasesAdded: [],
    superseded: [],
  };
}

/** {@link moveProject}, with the commit and aliases a rename reports. */
async function moveProjectWith(
  project: IAppProject,
  target: AppFolderTarget & { slug?: string },
  options: { userId?: string; author?: GitAuthor } = {},
  manifestPatch?: { title?: string },
): Promise<{
  from: string;
  to: string;
  commit?: string;
  aliasesAdded: string[];
  superseded: SupersededAlias[];
}> {
  const workspaceId = project.workspaceId.toString();
  const repoDir = await requireWorkspaceRepo(workspaceId);
  const from = appRootFor(project);
  const currentSlug = from.split("/").pop() ?? "app";
  const slug = normalizeName(target.slug ?? currentSlug);
  target = normalizedTarget(target);
  // Every folder name must be one git and a URL take (a 400, not a crash
  // in appRepoPath); a NEW app name must also be one a person may choose.
  folderPathOf(target);
  if (slug !== currentSlug) {
    const problem = newSegmentProblem(slug);
    if (problem) {
      throw new AppFolderError(
        `Invalid app folder name: ${JSON.stringify(slug)} — ${problem}`,
      );
    }
  } else if (!isSafeSegment(slug)) {
    throw new AppFolderError(
      `Invalid app folder name: ${JSON.stringify(slug)}`,
    );
  }
  const to = appRepoPath({ ...target, slug });
  if (to === from) return { from, to, aliasesAdded: [], superseded: [] };
  const appId = project._id.toString();
  /** Everything a move relies on, against the index at hand. */
  const checkMove = async (snapshot: AppsIndexSnapshot) => {
    assertStillAt(snapshot, appId, from);
    const taken = await occupiedPaths(workspaceId);
    if (taken.has(to)) throw occupiedPathError(to, snapshot);
    const twin = caseTwinOf(
      await occupiedAfterLeaving(repoDir, taken, from),
      to,
    );
    if (twin) throw caseTwinError(twin, to, snapshot, taken);
    // Never file an app inside another app: the outer one would swallow it.
    const parent = snapshot.apps.find(a => isWithin(to, a.path));
    if (parent) {
      throw new AppFolderError(`${parent.path} is an app, not a folder`, 409);
    }
  };
  const snapshot = await loadAppsIndex(workspaceId);
  assertStillAt(snapshot, appId, from);
  assertNewFolderNames(target, snapshot);
  await checkMove(snapshot);
  const moves = [{ from, to }];
  const aliasesAdded =
    aliasesForMoves(snapshot.apps, moves).get(from)?.add ?? [];
  let superseded: SupersededAlias[] = [];
  const { commitOid } = await commitOnMainDurably(
    workspaceId,
    repoDir,
    async () => {
      // Re-checked on every head the commit is about to land on (the
      // freshened main, then each one a retry meets): the app may have
      // moved or gone, and the target may have been taken, by a push or
      // another instance a moment ago.
      await checkMove(await loadAppsIndex(workspaceId, { freshen: false }));
      const planned = await moveWritesUnder(
        workspaceId,
        repoDir,
        moves,
        manifestPatch ? { path: from, ...manifestPatch } : undefined,
      );
      superseded = planned.superseded;
      return { moves, writes: planned.writes };
    },
    {
      message:
        manifestPatch?.title !== undefined
          ? `Rename app "${project.title}" to "${manifestPatch.title}" (${from} → ${to})`
          : `Move app "${project.title}" (${from} → ${to})`,
      // The person who renamed or moved it, as for every other kind.
      author: options.author ?? (await authorForUser(options.userId)),
    },
  );
  // The sync above relocated the row; keep the caller's copy honest too.
  // Visibility follows the tree: filed into a personal tree, the app is that
  // person's (private, theirs); filed back into the workspace tree, it is
  // workspace content again — a row-backed app must not keep the visibility
  // of the tree it left, or a "personal" app stays readable by everyone.
  const fromScope = parseAppRepoPath(from)?.scope;
  const visibility: Partial<IAppProject> =
    target.scope === "private"
      ? { access: "private", owner_id: target.ownerId }
      : fromScope === "private"
        ? { access: "workspace" }
        : {};
  project.path = to;
  project.slug = slug;
  Object.assign(project, visibility);
  await AppProject.updateOne(
    { _id: project._id, workspaceId: project.workspaceId },
    { $set: { path: to, slug, ...visibility } },
  );
  pokeApp(project.workspaceId, project._id, "lifecycle", options.userId);
  return { from, to, commit: commitOid, aliasesAdded, superseded };
}

/**
 * A new, empty folder. Git cannot hold an empty directory, so it is a
 * `.gitkeep` — the marker the index reads folders from.
 */
export async function createAppFolder(
  workspaceId: string,
  target: AppFolderTarget,
  options: { userId?: string; author?: GitAuthor } = {},
): Promise<{ path: string }> {
  if (target.folderSegments.length === 0) {
    throw new AppFolderError("A folder needs a name");
  }
  const repoDir = await requireWorkspaceRepo(workspaceId);
  target = normalizedTarget(target);
  const folderPath = folderPathOf(target);
  const snapshot = await loadAppsIndex(workspaceId);
  if (snapshot.folders.includes(folderPath)) {
    throw new AppFolderError(`${folderPath} already exists`, 409);
  }
  assertNewFolderNames(target, snapshot);
  const taken = await occupiedPaths(workspaceId);
  const twin = caseTwinOf(taken, folderPath);
  if (twin) throw caseTwinError(twin, folderPath, snapshot, taken);
  const clash = snapshot.apps.find(
    a => a.path === folderPath || isWithin(folderPath, a.path),
  );
  if (clash) {
    throw new AppFolderError(`${clash.path} is an app, not a folder`, 409);
  }
  await commitOnMainDurably(
    workspaceId,
    repoDir,
    // Re-checked on the head it lands on: an app pushed to this very path
    // meanwhile must not get a `.gitkeep` written into it.
    async () => {
      const fresh = await loadAppsIndex(workspaceId, { freshen: false });
      const app = fresh.apps.find(
        a => a.path === folderPath || isWithin(folderPath, a.path),
      );
      if (app) {
        throw new AppFolderError(`${app.path} is an app, not a folder`, 409);
      }
      return { writes: { [`${folderPath}/${FOLDER_KEEP_FILE}`]: "" } };
    },
    { message: `Create folder ${folderPath}`, author: options.author },
  );
  pokeApp(workspaceId, null, "lifecycle", options.userId);
  return { path: folderPath };
}

/**
 * Rename or move a folder, apps and subfolders included. Every app inside
 * keeps its id (stamped where missing), so nothing rebuilds or loses state.
 */
export async function moveAppFolder(
  workspaceId: string,
  from: AppFolderTarget,
  to: AppFolderTarget,
  options: { userId?: string; author?: GitAuthor } = {},
): Promise<{ from: string; to: string; apps: number }> {
  if (from.folderSegments.length === 0 || to.folderSegments.length === 0) {
    throw new AppFolderError("The tree roots cannot be moved");
  }
  const repoDir = await requireWorkspaceRepo(workspaceId);
  to = normalizedTarget(to);
  const fromPath = folderPathOf(from);
  const toPath = folderPathOf(to);
  if (fromPath === toPath) return { from: fromPath, to: toPath, apps: 0 };
  if (isWithin(toPath, fromPath)) {
    throw new AppFolderError("A folder cannot be moved into itself", 409);
  }
  const snapshot = await loadAppsIndex(workspaceId);
  if (!snapshot.folders.includes(fromPath)) {
    throw new AppFolderError(`Folder ${fromPath} not found`, 404);
  }
  assertNewFolderNames(to, snapshot);
  const taken = await occupiedPaths(workspaceId);
  if (taken.has(toPath)) {
    throw new AppFolderError(`${toPath} already exists`, 409);
  }
  const twin = caseTwinOf(
    await occupiedAfterLeaving(repoDir, taken, fromPath),
    toPath,
  );
  if (twin) throw caseTwinError(twin, toPath, snapshot, taken);
  const parentApp = snapshot.apps.find(a => isWithin(toPath, a.path));
  if (parentApp) {
    throw new AppFolderError(`${parentApp.path} is an app, not a folder`, 409);
  }
  const moves = [{ from: fromPath, to: toPath }];
  const apps = snapshot.apps.filter(a => isWithin(a.path, fromPath));
  await commitOnMainDurably(
    workspaceId,
    repoDir,
    async () => {
      // Re-checked on every head the commit is about to land on.
      const fresh = await loadAppsIndex(workspaceId, { freshen: false });
      if (!fresh.folders.includes(fromPath)) {
        throw new AppFolderError(`Folder ${fromPath} not found`, 404);
      }
      const takenNow = await occupiedPaths(workspaceId);
      if (takenNow.has(toPath)) {
        throw new AppFolderError(`${toPath} already exists`, 409);
      }
      const twinNow = caseTwinOf(
        await occupiedAfterLeaving(repoDir, takenNow, fromPath),
        toPath,
      );
      if (twinNow) throw caseTwinError(twinNow, toPath, fresh, takenNow);
      if (fresh.apps.some(a => isWithin(toPath, a.path))) {
        throw new AppFolderError(`${toPath} is inside an app`, 409);
      }
      return {
        moves,
        writes: (await moveWritesUnder(workspaceId, repoDir, moves)).writes,
      };
    },
    { message: `Move folder ${fromPath} → ${toPath}`, author: options.author },
  );
  pokeApp(workspaceId, null, "lifecycle", options.userId);
  return { from: fromPath, to: toPath, apps: apps.length };
}

/** Delete a folder. Only an empty one — deleting apps is deleteProject's job. */
export async function deleteAppFolder(
  workspaceId: string,
  target: AppFolderTarget,
  options: { userId?: string; author?: GitAuthor } = {},
): Promise<void> {
  if (target.folderSegments.length === 0) {
    throw new AppFolderError("The tree roots cannot be deleted");
  }
  const repoDir = await requireWorkspaceRepo(workspaceId);
  const folderPath = folderPathOf(target);
  const snapshot = await loadAppsIndex(workspaceId);
  if (!snapshot.folders.includes(folderPath)) {
    throw new AppFolderError(`Folder ${folderPath} not found`, 404);
  }
  const inside = snapshot.apps.filter(a => isWithin(a.path, folderPath));
  if (inside.length > 0) {
    throw new AppFolderError(
      `${folderPath} still holds ${inside.length} app(s); move or delete them first`,
      409,
    );
  }
  await commitOnMainDurably(
    workspaceId,
    repoDir,
    // Re-checked on the head it lands on: an app moved INTO the folder
    // meanwhile would otherwise be deleted with it.
    async () => {
      const fresh = await loadAppsIndex(workspaceId, { freshen: false });
      const now = fresh.apps.filter(a => isWithin(a.path, folderPath));
      if (now.length > 0) {
        throw new AppFolderError(
          `${folderPath} still holds ${now.length} app(s); move or delete them first`,
          409,
        );
      }
      return { deletePrefixes: [folderPath] };
    },
    { message: `Delete folder ${folderPath}`, author: options.author },
  );
  pokeApp(workspaceId, null, "lifecycle", options.userId);
}

/**
 * Give a copied app (one that declared another app's id) an identity of its
 * own: write the id the index filed it under into its manifest.
 */
export async function stampAppId(
  workspaceId: string,
  app: AppIndexRow,
  options: { userId?: string; author?: GitAuthor } = {},
): Promise<void> {
  const repoDir = await requireWorkspaceRepo(workspaceId);
  /** The stamped manifest at main as it is now; null when already stamped. */
  const stampNow = async (): Promise<LifecycleMutation | null> => {
    let contents: string | null = null;
    try {
      contents = (
        await readBlob(repoDir, DEFAULT_BRANCH, `${app.path}/${APP_MANIFEST}`)
      ).contents;
    } catch {
      contents = null;
    }
    let stamped = stampManifestId(contents, app.appId);
    // A copy keeps its source's `aliases` too, and a name two apps claim
    // resolves to neither: with an id of its own the copy gives them up.
    if (stamped !== null && app.duplicateOf) {
      stamped = stripManifestAliases(stamped);
    }
    if (stamped === null) {
      throw new AppFolderError(
        `${app.path}/${APP_MANIFEST} is not valid JSON; fix it before stamping an id`,
      );
    }
    // Already carries this id: nothing to write, no empty commit to push.
    if (stamped === contents) return null;
    return { writes: { [`${app.path}/${APP_MANIFEST}`]: stamped } };
  };
  if (!(await stampNow())) return;
  await commitOnMainDurably(
    workspaceId,
    repoDir,
    // Re-read on every head the commit lands on: a save of the manifest in
    // between is stamped, not overwritten; a folder that moved or went in
    // between is not written back.
    async () => {
      const fresh = await loadAppsIndex(workspaceId, { freshen: false });
      if (!fresh.apps.some(a => a.path === app.path)) {
        throw new AppFolderError(`App folder ${app.path} is not on main`, 404);
      }
      return stampNow();
    },
    { message: `Stamp app id for ${app.path}`, author: options.author },
  );
  pokeApp(workspaceId, app.appId, "lifecycle", options.userId);
}

// ---------------------------------------------------------------------------
// Worktree + session materialization
// ---------------------------------------------------------------------------

/**
 * Dedicated actor for publishing (§13.3).
 *
 * Publishing must build from `main` and nothing else, so it gets its own
 * worktree instead of borrowing whoever happened to trigger it. Two reasons:
 * a human's session sits on their own branch with uncommitted WIP, and
 * `ensureWorktree` only fast-forwards a CLEAN worktree — so a session with WIP
 * would build a stale tree that can predate the app being published. Keeping
 * this worktree write-free means it fast-forwards to the branch head every
 * time.
 */
export const PUBLISH_ACTOR = "publish";

/** A real user id, as opposed to PUBLISH_ACTOR / "" / other system sentinels. */
function isUserActor(actorId: string): boolean {
  return /^[0-9a-f]{24}$/i.test(actorId);
}

// The doctrine of which branch an actor starts on — and where each content
// kind's commits land — lives in branch-policy.ts (apps.md §18). Re-exported
// so existing importers keep working.
export { defaultBranchForActor, sessionBranchFor } from "./branch-policy";
import { defaultBranchForActor } from "./branch-policy";

/**
 * Find-or-create the record of which branch this actor works on.
 *
 * `actorId` is a user id for UI/API actors. Everyone gets their own branch —
 * you do not edit production — created off the default branch head the first
 * time they touch the workspace.
 *
 * No sandbox is started here, and no working copy is materialized. This is a
 * question about branches, and it has to keep answering while the sandbox is
 * asleep, because the file tree depends on it.
 */
export async function ensureWorktree(
  project: IAppProject,
  actorId: string,
  options: { branch?: string } = {},
): Promise<WorktreeHandle> {
  const core = await ensureWorktreeCore(
    project.workspaceId.toString(),
    actorId,
    options,
  );
  return { ...core, project, appRoot: appRootFor(project) };
}

/**
 * The workspace-scoped handle: same session doc, same sandbox, no app lens.
 * This is what repo-level surfaces (Source Control, workspace repo routes)
 * use — the worktree was always keyed by (workspace, actor); only the code
 * used to insist on an app to reach it.
 */
export async function ensureWorkspaceWorktree(
  workspaceId: string,
  actorId: string,
  options: { branch?: string } = {},
): Promise<WorktreeHandle> {
  const core = await ensureWorktreeCore(workspaceId, actorId, options);
  return { ...core, appRoot: "" };
}

async function ensureWorktreeCore(
  workspaceId: string,
  actorId: string,
  options: { branch?: string } = {},
): Promise<{ doc: IAppWorktree; repoDir: string }> {
  const repoDir = await repoForWorkspace(workspaceId);
  if (!(await repoExists(repoDir))) {
    throw new Error("Workspace repository is missing");
  }

  const mainHead = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!mainHead) throw new Error("Workspace default branch is missing");

  // The doc remembers which branch this actor is on (checkoutBranch writes
  // it); an actor with no doc yet starts on the default branch, like a fresh
  // clone. options.branch overrides both (publish pins main explicitly).
  const existing = await AppWorktree.findOne({
    workspaceId: new Types.ObjectId(workspaceId),
    userId: actorId,
  });
  const branch =
    options.branch ?? existing?.branch ?? defaultBranchForActor(actorId);
  let branchHead = await resolveCommit(repoDir, `refs/heads/${branch}`);
  if (!branchHead) {
    // The remembered branch no longer exists (deleted from another checkout,
    // say) — fork it back off the default branch head rather than failing.
    // CAS-create; a concurrent creator winning is fine (re-resolve).
    await updateRefCas(repoDir, `refs/heads/${branch}`, mainHead, ZERO_OID);
    branchHead = await resolveCommit(repoDir, `refs/heads/${branch}`);
    if (!branchHead) throw new Error(`Failed to create branch ${branch}`);
    logger.info("Apps actor branch created", { workspaceId, branch });
  }

  // No automatic merging of main into the actor's branch. That existed for
  // the forced-personal-branch era, when everyone lived forever on a branch
  // that would otherwise never learn about new apps. Branches are explicit
  // now — you make one when you want one — and no laptop merges main into
  // your feature branch behind your back. `git merge main` (terminal) or
  // switching to main (UI) is the git-native way to catch up.

  // Atomic find-or-create: the agent routinely fires tool calls in parallel
  // right after app creation, so a findOne+create pair races itself into
  // E11000 on the (workspaceId, userId) unique index.
  const doc = await AppWorktree.findOneAndUpdate(
    { workspaceId: new Types.ObjectId(workspaceId), userId: actorId },
    { $setOnInsert: { branch } },
    { new: true, upsert: true },
  );

  return { doc, repoDir };
}

/**
 * Follow a branch switch made in the terminal.
 *
 * `git checkout` in the shell is a legitimate way to change branches — it is
 * the same command the button runs — so the cached branch follows the sandbox
 * rather than the other way round. Cheap, and never fatal: a stale cache
 * shows the wrong branch name for a moment; refusing to read would show
 * nothing at all.
 */
async function syncBranchFromBox(handle: WorktreeHandle): Promise<void> {
  try {
    const ctx = boxCtx(handle);
    if (!(await getSandboxProvider().hasSession(ctx))) return;
    if (!(await boxHasRepo(ctx))) return;
    const { branch } = await boxHead(ctx);
    if (branch && branch !== "HEAD" && branch !== handle.doc.branch) {
      logger.info("Apps following a branch switch made in the sandbox", {
        from: handle.doc.branch,
        to: branch,
      });
      handle.doc.branch = branch;
      await handle.doc.save();
    }
  } catch {
    // Not worth failing a read over.
  }
}

// ---------------------------------------------------------------------------
// The client: a shell, a file system, and git — all of it in the sandbox
// ---------------------------------------------------------------------------

export type ExecOutcome = SandboxExecResult;

export async function execInWorktree(
  handle: WorktreeHandle,
  command: string,
  options: SandboxExecOptions = {},
): Promise<ExecOutcome> {
  // §10: the session is the whole workspace repo; commands are app-scoped by
  // default (caller cwd is app-relative). posix.join keeps it session-rooted.
  const cwd = path.posix.join(handle.appRoot, options.cwd ?? "");
  const ctx = await ensureBox(handle);
  let result: ExecOutcome;
  try {
    result = await getSandboxProvider().exec(ctx, command, {
      ...options,
      cwd,
    });
  } catch (error) {
    if (!isMissingCwd(error)) throw error;
    // The box under this exec is not the box ensureBox inspected — a
    // recycle or expiry swapped machines between calls, and the fresh one
    // has no clone yet. Hydrate THIS box and retry once; convention
    // (rebuild from the repo) beats tracing which cache went stale.
    await rehydrateBox(handle, ctx);
    result = await getSandboxProvider().exec(ctx, command, {
      ...options,
      cwd,
    });
  }
  // A command can `git checkout`, and it can commit. Nothing needs
  // snapshotting — but the cached branch should follow, and a commit made in
  // the shell should not be left sitting only on a disposable machine.
  //
  // EXCEPT in the publish actor's box. That box sits on `main` holding the
  // trial-merge candidate — a commit that must reach main only through
  // promote's compare-and-swap, after the build has passed. Auto-pushing it
  // here shipped the candidate on the FIRST build command (npm install),
  // before anything had been built at all, and then promote failed its CAS
  // against the very merge it was promoting. A build machine reports its
  // result; it does not publish it.
  await syncBranchFromBox(handle);
  if (handle.doc.userId !== PUBLISH_ACTOR) {
    await boxPushIfAhead(ctx).catch(error =>
      logger.warn("Apps could not push commits made in the shell", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  return result;
}

/**
 * Write a file to the sandbox's scratch area — outside the working copy, so
 * it can never be committed — and return its absolute path in the sandbox.
 * Used to keep the full output of a command whose tool result was truncated,
 * where `grep`/`tail` in app_bash can reach it. Scratch lives as long as the
 * sandbox: a recycled box loses it.
 *
 * `keepNewest` bounds the file's directory to that many files (newest kept):
 * the box disk is small, and these files are regenerable by re-running the
 * command, so they must never be what fills it.
 */
export async function writeWorktreeScratchFile(
  handle: WorktreeHandle,
  relPath: string,
  contents: string,
  options: { keepNewest?: number } = {},
): Promise<string> {
  const ctx = await ensureBox(handle);
  const provider = getSandboxProvider();
  const remotePath = path.posix.join(
    provider.scratch(ctx),
    assertSafeRelPath(relPath),
  );
  // TextEncoder, not Buffer.from: a Buffer can be a view into Node's shared
  // pool, and the E2B provider uploads `bytes.buffer` — the whole pool.
  await provider.writeFile(ctx, remotePath, new TextEncoder().encode(contents));
  if (options.keepNewest && options.keepNewest > 0) {
    const dir = sh(path.posix.dirname(remotePath));
    await provider
      .exec(
        ctx,
        // cd first and delete bare names: nothing outside the directory can
        // match, and a failed cd stops the pipeline before any rm runs.
        // (A read loop, not xargs -d: that flag is GNU-only.)
        `cd ${dir} && ls -1t | tail -n +${options.keepNewest + 1} | ` +
          'while IFS= read -r f; do rm -f -- "$f"; done',
        { timeoutMs: 15_000 },
      )
      .catch(error =>
        logger.warn("Could not prune sandbox scratch files", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }
  return remotePath;
}

/**
 * Where a read comes from.
 *
 * If the sandbox is up, the working copy — that is what the person is
 * looking at, including everything they have not committed. If it is not, the
 * last commit on their branch, because that is the last thing anyone can
 * still see. Asking is deliberately a question that does not start a sandbox;
 * browsing a repository should not boot a microVM.
 */
async function readSource(
  project: IAppProject,
  userId: string | undefined,
  at?: string,
): Promise<
  | { kind: "box"; ctx: SandboxExecContext; handle: WorktreeHandle }
  | { kind: "repo"; repoDir: string; ref: string; appRoot?: string }
> {
  const repoDir = await repoFor(project);
  // A pinned commit reads exactly that commit — no box, no actor branch.
  // Published serving needs this: the deployed build was made from
  // `publishedSha`, and its data bindings must be the ones AT that commit,
  // not whatever main says today. Resolving them from main meant an edit to
  // a binding on main changed its content-addressed artifact key under the
  // live app, whose tables then 404'd until someone republished.
  //
  // The commit has to be HERE, though: only the instance that handled the
  // push has it, so on a multi-instance host a published app read binding
  // files at a sha its own cache had never seen (`fatal: not a tree object`,
  // a 500 per data request, roughly half of them). Fetch it on a miss.
  if (at) {
    await ensureCommitLocally(
      project.workspaceId.toString(),
      at,
      project.defaultBranch || DEFAULT_BRANCH,
    );
    // Most reads still use the same folder: avoid scanning the workspace
    // for every binding request. Resolve history only after a move.
    const manifest = await readBlob(
      repoDir,
      at,
      `${appRootFor(project)}/${APP_MANIFEST}`,
    ).catch(() => null);
    const declaredId = manifest
      ? parseAppManifest(manifest.contents, project.slug ?? "").id
      : undefined;
    if (manifest && (!declaredId || declaredId === project._id.toString())) {
      return { kind: "repo", repoDir, ref: at };
    }
    const apps = await readIndexedAppsAt(
      project.workspaceId.toString(),
      repoDir,
      at,
    );
    const historical = apps.find(a => a.appId === project._id.toString());
    return {
      kind: "repo",
      repoDir,
      ref: at,
      appRoot: historical?.path ?? appRootFor(project),
    };
  }
  const branchRef = `refs/heads/${project.defaultBranch || DEFAULT_BRANCH}`;
  if (!userId) return { kind: "repo", repoDir, ref: branchRef };

  const doc = await AppWorktree.findOne({
    workspaceId: project.workspaceId,
    userId,
  });
  if (!doc) return { kind: "repo", repoDir, ref: branchRef };

  const handle: WorktreeHandle = {
    doc,
    project,
    repoDir,
    appRoot: appRootFor(project),
  };
  const ctx = boxCtx(handle);
  const live = await getSandboxProvider()
    .hasSession(ctx)
    .catch(() => false);
  if (live && (await boxHasRepo(ctx).catch(() => false))) {
    await syncBranchFromBox(handle);
    // The box's checkout may predate a move of this app (or its creation
    // by another actor): its folder is not where the row now says. Pull
    // main once; if the folder is still missing, read the repo at main
    // rather than show an app with no files.
    if (!(await boxPathExists(ctx, handle.appRoot))) {
      await boxPull(ctx).catch(() => undefined);
      lastPull.set(ctx.sessionKey, Date.now());
      if (!(await boxPathExists(ctx, handle.appRoot))) {
        return { kind: "repo", repoDir, ref: branchRef };
      }
    }
    return { kind: "box", ctx, handle };
  }

  const actorRef = (await resolveCommit(repoDir, `refs/heads/${doc.branch}`))
    ? `refs/heads/${doc.branch}`
    : branchRef;
  // An actor branch that predates the app would make a listed app look empty,
  // which reads as data loss rather than as "your branch is behind".
  if (await pathExistsAtRef(repoDir, actorRef, appRootFor(project))) {
    return { kind: "repo", repoDir, ref: actorRef };
  }
  return { kind: "repo", repoDir, ref: branchRef };
}

/** Whether `relPath` exists in the box's working copy. */
async function boxPathExists(
  ctx: SandboxExecContext,
  relPath: string,
): Promise<boolean> {
  const result = await getSandboxProvider()
    .exec(
      ctx,
      `test -e ${sh(`${boxRoot(ctx)}/${relPath}`)} && echo yes || echo no`,
      {
        timeoutMs: 15_000,
      },
    )
    .catch(() => null);
  return result?.stdout.trim() === "yes";
}

/** Whether `path` exists at `ref` (a file or a directory). */
async function pathExistsAtRef(
  repoDir: string,
  ref: string,
  path: string,
): Promise<boolean> {
  try {
    await runGit(["-C", repoDir, "cat-file", "-e", `${ref}:${path}`], {
      timeoutMs: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Entries the listing returns before saying "and N more". Not a page — the
 * tree is not paginated — but the honest ceiling past which a UI stops being
 * a tree and becomes a memory leak. A 100k-file folder (a committed
 * node_modules, a data dump) lists its first files and reports the total,
 * instead of shipping a multi-megabyte response to a client that dies
 * building nodes for it.
 */
const LIST_ENTRY_LIMIT = 5000;

export interface FileListing {
  ref: string;
  entries: TreeEntry[];
  /** True when the tree holds more files than `entries` carries. */
  truncated: boolean;
  /** Total file count when known (always known unless counting failed). */
  total?: number;
}

export async function listFiles(
  project: IAppProject,
  userId?: string,
): Promise<FileListing> {
  const source = await readSource(project, userId);
  const root = appRootFor(project);
  if (source.kind === "box") {
    const listing = await boxListFiles(source.ctx, root, LIST_ENTRY_LIMIT);
    return {
      ref: source.handle.doc.branch,
      entries: listing.entries.map(e => ({
        ...e,
        path: e.path.slice(root.length + 1),
      })),
      truncated: listing.truncated,
      total: listing.total,
    };
  }
  const prefix = `${root}/`;
  const all = (await listTree(source.repoDir, source.ref))
    .filter(e => e.path.startsWith(prefix))
    .map(e => ({ ...e, path: e.path.slice(prefix.length) }));
  const truncated = all.length > LIST_ENTRY_LIMIT;
  return {
    ref: source.ref,
    entries: truncated ? all.slice(0, LIST_ENTRY_LIMIT) : all,
    truncated,
    total: all.length,
  };
}

export async function readFile(
  project: IAppProject,
  relPath: string,
  userId?: string,
  /** Read at this commit instead of the actor's view (see readSource). */
  at?: string,
): Promise<{
  path: string;
  contents: string;
  isBinary: boolean;
  size: number;
}> {
  const safe = assertSafeRelPath(relPath);
  const source = await readSource(project, userId, at);
  if (source.kind === "box") {
    const blob = await boxReadFile(source.ctx, appPath(project, safe));
    return { path: safe, ...blob };
  }
  const blob = await readBlob(
    source.repoDir,
    source.ref,
    `${source.appRoot ?? appRootFor(project)}/${safe}`,
  );
  return { path: safe, ...blob };
}

/** Search file contents at whatever the actor is actually looking at. */
export async function grepFiles(
  project: IAppProject,
  pattern: string,
  userId: string | undefined,
  options?: { ignoreCase?: boolean; pathspec?: string; maxMatches?: number },
): Promise<GrepMatch[]> {
  const source = await readSource(project, userId);
  const root = appRootFor(project);
  const pathspec = options?.pathspec ? `${root}/${options.pathspec}` : root;
  const matches =
    source.kind === "box"
      ? await boxGrep(source.ctx, pattern, { ...options, pathspec })
      : await grepTree(source.repoDir, source.ref, pattern, {
          ...options,
          pathspec,
        });
  return matches.map(m =>
    m.path.startsWith(`${root}/`)
      ? { ...m, path: m.path.slice(root.length + 1) }
      : m,
  );
}

/** List paths matching a glob at whatever the actor is actually looking at. */
export async function globFiles(
  project: IAppProject,
  glob: string,
  userId?: string,
  limit?: number,
  /** Read at this commit instead of the actor's view (see readSource). */
  at?: string,
): Promise<string[]> {
  const source = await readSource(project, userId, at);
  const root =
    source.kind === "repo"
      ? (source.appRoot ?? appRootFor(project))
      : appRootFor(project);
  const matched =
    source.kind === "box"
      ? await boxGlob(source.ctx, `${root}/${glob}`, limit)
      : await globTree(source.repoDir, source.ref, `${root}/${glob}`, limit);
  return matched
    .filter(p => p.startsWith(`${root}/`))
    .map(p => p.slice(root.length + 1));
}

/**
 * Write a file into the working copy.
 *
 * Just a write. It used to be a write plus a snapshot plus a verification that
 * the snapshot contained it — because a write to an ignored path was accepted,
 * reported as successful, and silently discarded. The check survives, because
 * that failure mode does not go away: `git add -A` still skips ignored paths,
 * so a file written to node_modules/ or dist/ would still vanish at commit
 * time, and an agent told the write worked would build on a file that is not
 * there.
 */
export async function writeFile(
  handle: WorktreeHandle,
  relPath: string,
  contents: string,
): Promise<void> {
  const safe = scopedPath(handle, relPath);
  if (Buffer.byteLength(contents, "utf8") > APPS_MAX_FILE_BYTES) {
    throw new Error("File exceeds the maximum size for a direct write");
  }
  const ctx = await ensureBox(handle);
  await boxWriteFile(ctx, safe, contents);

  const ignored = await getSandboxProvider().exec(
    ctx,
    `git -C ${sh(boxRoot(ctx))} check-ignore -q ${sh(safe)}`,
    { timeoutMs: 30_000 },
  );
  if (ignored.exitCode === 0) {
    throw new Error(
      `${relPath} is ignored by git (.gitignore or the sandbox's excludes), so it cannot be saved. Build output and installed dependencies live only in the sandbox by design — write somewhere tracked instead.`,
    );
  }
}

/** Read a file straight from the working copy (agents editing in place). */
export async function readSessionFile(
  handle: WorktreeHandle,
  relPath: string,
): Promise<string> {
  const ctx = await ensureBox(handle);
  const blob = await boxReadFile(ctx, scopedPath(handle, relPath));
  return blob.contents;
}

// ---------------------------------------------------------------------------
// Status / history
// ---------------------------------------------------------------------------

/**
 * Bring an actor's RUNNING sandbox level with the server, now.
 *
 * For the moment right after a server-side commit (app creation is one: the
 * scaffold lands on main with no sandbox involved). Reads are served from the
 * working copy whenever a sandbox is running, so a running-but-behind box
 * makes a just-created app read as empty — which is exactly how the agent saw
 * `files: []` from create_app and rebuilt the scaffold by hand on top of it.
 *
 * Never boots a sandbox: a sleeping box hydrates fresh on next use and needs
 * nothing from us.
 */
export async function catchUpLiveBox(
  project: IAppProject,
  actorId: string,
): Promise<void> {
  try {
    // ensureWorktree first: it is what merges main into the actor's branch
    // server-side, so the pull below has the new commit to bring over.
    const handle = await ensureWorktree(project, actorId);
    const ctx = boxCtx(handle);
    if (!(await getSandboxProvider().hasSession(ctx))) return;
    if (!(await boxHasRepo(ctx))) return;
    await boxPull(ctx);
    lastPull.set(ctx.sessionKey, Date.now());
  } catch (error) {
    logger.warn("Apps live-box catch-up failed", {
      actorId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Settle up after a terminal session ends.
 *
 * The terminal is a live PTY, so unlike execInWorktree nothing runs "after the
 * command" — a `git commit` typed there would otherwise sit on a disposable
 * machine until some unrelated API call happened to touch the box, and a
 * `git checkout` typed there would leave the cached branch pointing at the
 * old one. Called when the last client detaches (terminal-ws.ts).
 *
 * Best-effort by design: the work is committed in a real repository either
 * way, and failing a disconnect over bookkeeping helps nobody.
 */
export async function afterTerminalSession(
  workspaceId: string,
  userId: string,
): Promise<void> {
  try {
    const doc = await AppWorktree.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      userId,
    });
    if (!doc) return;
    const ctx: SandboxExecContext = {
      sessionKey: sessionKeyFor(doc.workspaceId, doc.userId),
    };
    if (!(await getSandboxProvider().hasSession(ctx))) return;
    if (!(await boxHasRepo(ctx))) return;

    const { branch } = await boxHead(ctx);
    if (branch && branch !== "HEAD" && branch !== doc.branch) {
      logger.info("Apps following a branch switch made in the terminal", {
        from: doc.branch,
        to: branch,
      });
      doc.branch = branch;
      await doc.save();
    }
    // Commits typed in the shell but never pushed: push them. The push runs
    // through the git endpoint, whose reaction handles mirror + refresh.
    await boxPushIfAhead(ctx);
  } catch (error) {
    logger.warn("Apps terminal settle-up failed", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface WorktreeStatus {
  branch: string;
  /** Commit the working copy is on. */
  baseSha: string;
  branchHead: string | null;
  /** Commits this branch has that the server does not. */
  ahead: number;
  /** Uncommitted changes inside THIS app's folder. */
  changes: ChangedFile[];
  /**
   * Uncommitted changes anywhere in the repo.
   *
   * One working copy serves the whole monorepo, so what a branch switch has to
   * get past — and what Discard throws away — is the repo-wide set, not this
   * app's slice. Reporting only the slice once made an app look clean while a
   * lock file another app's build had written kept `git checkout` refusing,
   * with nothing on screen naming it.
   */
  repoChanges: ChangedFile[];
  /** True while the sandbox is asleep: this is the last committed state. */
  offline: boolean;
}

/**
 * What `git status` says.
 *
 * With no sandbox running there is nothing to have uncommitted work IN, so the
 * answer is the branch head and an empty change set, flagged as such rather
 * than presented as a clean tree.
 */
export async function worktreeStatus(
  scope: RepoScope,
  userId: string,
): Promise<WorktreeStatus | null> {
  const repoDir = await repoForWorkspace(scope.workspaceId);
  const doc = await AppWorktree.findOne({
    workspaceId: new Types.ObjectId(scope.workspaceId),
    userId,
  });
  if (!doc) return null;

  const handle: WorktreeHandle = {
    doc,
    repoDir,
    appRoot: scope.root ?? "",
  };
  const ctx = boxCtx(handle);
  const prefix = scope.root ? `${scope.root}/` : null;
  const narrow = (changes: WorktreeStatus["repoChanges"]) =>
    prefix
      ? changes
          .filter(ch => ch.path.startsWith(prefix))
          .map(ch => ({ ...ch, path: ch.path.slice(prefix.length) }))
      : changes;

  // Snapshot first: what the box's own agent pushed moments ago answers this
  // without three execs into the machine (~2s). The snapshot expires unless
  // the agent keeps refreshing it, so a hit is by construction recent; a
  // miss (agent not up yet, API just restarted in memory mode, box gone)
  // falls through to discovery exactly as before.
  const snapshot = await getBoxState(ctx.sessionKey);
  if (hasGitState(snapshot)) {
    if (
      snapshot.branch !== "HEAD" &&
      snapshot.branch !== doc.branch &&
      !snapshot.branch.startsWith("No ")
    ) {
      logger.info("Apps following a branch switch reported by the box", {
        from: doc.branch,
        to: snapshot.branch,
      });
      doc.branch = snapshot.branch;
      await doc.save();
    }
    const branchHead = await resolveCommit(
      repoDir,
      `refs/heads/${snapshot.branch}`,
    );
    return {
      branch: snapshot.branch,
      baseSha: snapshot.head ?? branchHead ?? "",
      branchHead,
      ahead: snapshot.ahead ?? 0,
      changes: narrow(snapshot.changes),
      repoChanges: snapshot.changes,
      offline: false,
    };
  }

  const live =
    (await getSandboxProvider()
      .hasSession(ctx)
      .catch(() => false)) &&
    (await boxHasValidCheckout(ctx).catch(() => false));

  if (!live) {
    const branchHead = await resolveCommit(repoDir, `refs/heads/${doc.branch}`);
    return {
      branch: doc.branch,
      baseSha: branchHead ?? "",
      branchHead,
      ahead: 0,
      changes: [],
      repoChanges: [],
      offline: true,
    };
  }

  await syncBranchFromBox(handle);
  const status = await boxStatus(ctx);
  const branchHead = await resolveCommit(
    repoDir,
    `refs/heads/${status.branch}`,
  );
  return {
    branch: status.branch,
    baseSha: status.head,
    branchHead,
    ahead: status.ahead,
    changes: narrow(status.changes),
    repoChanges: status.changes,
    offline: false,
  };
}

/**
 * Commit sha at the tip of the project's default branch — what a publish
 * deploys, and the identity an immutable deployment is keyed by (§13.3).
 */
export async function defaultBranchSha(project: IAppProject): Promise<string> {
  const repoDir = await repoFor(project);
  const branch = project.defaultBranch || DEFAULT_BRANCH;
  const { stdout } = await runGit(["rev-parse", `refs/heads/${branch}`], {
    cwd: repoDir,
  });
  const sha = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(
      `Could not resolve ${branch} to a commit (got ${JSON.stringify(sha)})`,
    );
  }
  return sha;
}

export async function projectHistory(
  scope: RepoScope,
  limit = 20,
  ref?: string,
  view: "app" | "repo" = "app",
) {
  const repoDir = await repoForWorkspace(scope.workspaceId);
  // History follows the branch the caller is actually on (VS Code semantics),
  // falling back to the default branch when the ref is absent or bogus. The
  // shape check keeps user input out of argv option position; show-ref
  // verifies existence without ever resolving arbitrary expressions.
  let target = `refs/heads/${scope.defaultBranch}`;
  if (ref && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) && !ref.includes("..")) {
    const exists = await runGit(
      ["show-ref", "--verify", "--quiet", `refs/heads/${ref}`],
      { cwd: repoDir },
    ).then(
      () => true,
      () => false,
    );
    if (exists) target = `refs/heads/${ref}`;
  }
  // An app's own history: across its renames (it did not start at the
  // last one), and never a previous occupant's of the folder it is in.
  if (view === "app" && scope.root && parseAppRepoPath(scope.root)) {
    const previous = await previousRootsOf(scope);
    return (await appHistory(repoDir, target, scope.root, previous, limit)).map(
      ({ oid, author, timestamp, subject }) => ({
        oid,
        author,
        timestamp,
        subject,
      }),
    );
  }
  return repoLog(
    repoDir,
    target,
    limit,
    view === "repo" ? undefined : (scope.root ?? undefined),
  );
}

/**
 * Folders an app had before its current one, as the index knows them (its
 * manifest's aliases and the ones the index learned, superseded included —
 * a name the app lost is still where its older commits are).
 */
async function previousRootsOf(scope: RepoScope): Promise<string[]> {
  if (!scope.projectId || !scope.root) return [];
  const row = await AppIndexEntry.findOne({
    workspaceId: new Types.ObjectId(scope.workspaceId),
    appId: scope.projectId.toString(),
  })
    .select("aliases indexAliases supersededAliases")
    .lean();
  if (!row) return [];
  return aliasFolders([
    ...(row.aliases ?? []),
    ...(row.indexAliases ?? []),
    ...(row.supersededAliases ?? []),
  ]).filter(folder => folder !== scope.root);
}

/**
 * Where the app was in `sha` (and before it, for the commit that moved
 * it), when that is not where it is now: the commit is in its history
 * from before a rename. Null when the app's current folder is the answer.
 */
async function rootsAt(
  repoDir: string,
  scope: RepoScope,
  sha: string,
): Promise<AppHistoryCommit | null> {
  const previous = await previousRootsOf(scope);
  if (!scope.root || previous.length === 0) return null;
  const history = await appHistory(
    repoDir,
    `refs/heads/${scope.defaultBranch}`,
    scope.root,
    previous,
    APP_HISTORY_SCAN_MAX_COMMITS,
  );
  return history.find(c => c.oid === sha) ?? null;
}

// ---------------------------------------------------------------------------
// Commit (WIP -> branch) and discard
// ---------------------------------------------------------------------------

export interface CommitResult {
  committed: boolean;
  commitOid?: string;
  message?: string;
  reason?: string;
}

/**
 * Per-file git actions (stage / unstage / discard), then push the box's
 * fresh status so every open panel updates at once — the agent would report
 * it within a tick anyway, but a click deserves an immediate answer.
 */
export async function gitPathsAction(
  handle: WorktreeHandle,
  action: "stage" | "unstage" | "discard",
  paths: string[],
): Promise<void> {
  const ctx = await ensureBox(handle);
  await boxGitPaths(ctx, action, paths);
  try {
    const { branch, changes } = await boxPorcelain(ctx);
    await patchBoxState({
      workspaceId: handle.doc.workspaceId.toString(),
      userId: handle.doc.userId,
      patch: { ...(branch ? { branch } : {}), changes },
      source: "api",
    });
  } catch (error) {
    logger.warn("Apps could not push status after a git action", {
      action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** HEAD / index / working-tree contents of one repo-relative path, for diffs. */
/**
 * What one commit changed INSIDE this app (paths app-relative), and its
 * parent — the unit the History panel's "View changes" works in. Read from
 * the bare repo: no sandbox, no working copy.
 */
export async function commitChanges(
  scope: RepoScope,
  sha: string,
  /** "repo": every file, repo-relative — the Source Control graph's view. */
  view: "app" | "repo" = "app",
): Promise<{ sha: string; parent: string | null; files: ChangedFile[] }> {
  const repoDir = await repoForWorkspace(scope.workspaceId);
  const oid = await resolveCommit(repoDir, sha);
  if (!oid) throw new Error(`No such commit: ${sha}`);
  const parent = await resolveCommit(repoDir, `${oid}^`);
  const all = await diffNameStatus(repoDir, parent ?? EMPTY_TREE, oid);
  if (view === "repo" || scope.root == null) {
    return { sha: oid, parent, files: all };
  }
  // A commit from before a rename: the app's files were in its old folder.
  const root =
    (all.some(f => f.path.startsWith(`${scope.root}/`))
      ? null
      : (await rootsAt(repoDir, scope, oid))?.root) ?? scope.root;
  const files = all
    .filter(f => f.path.startsWith(`${root}/`))
    .map(f => ({ ...f, path: f.path.slice(root.length + 1) }));
  return { sha: oid, parent, files };
}

/** One app file before and after a commit (null = absent on that side). */
export async function commitFileVersions(
  scope: RepoScope,
  sha: string,
  relPath: string,
): Promise<{ before: string | null; after: string | null; binary: boolean }> {
  const repoDir = await repoForWorkspace(scope.workspaceId);
  const oid = await resolveCommit(repoDir, sha);
  if (!oid) throw new Error(`No such commit: ${sha}`);
  const parent = await resolveCommit(repoDir, `${oid}^`);
  const safe = assertSafeRelPath(relPath);
  // A commit from before a rename reads the app's old folder — and the
  // commit that moved it reads the old folder before and the new after.
  const at = scope.root ? await rootsAt(repoDir, scope, oid) : null;
  const afterRoot = at?.root ?? scope.root;
  const beforeRoot = at?.previousRoot ?? afterRoot;
  const read = async (ref: string | null, root: string | null) => {
    if (!ref) return null;
    try {
      return await readBlob(repoDir, ref, root ? `${root}/${safe}` : safe);
    } catch {
      return null;
    }
  };
  const [before, after] = await Promise.all([
    read(parent, beforeRoot),
    read(oid, afterRoot),
  ]);
  return {
    before: before?.isBinary ? null : (before?.contents ?? null),
    after: after?.isBinary ? null : (after?.contents ?? null),
    binary: Boolean(before?.isBinary || after?.isBinary),
  };
}

/**
 * "Restore this version": set the app's folder back to its content at `sha`
 * and commit that as a NEW commit on the actor's branch (then push, like
 * every commit). History is append-only — the versions in between stay in
 * the log, which is what makes this safe to offer from a list of commits.
 */
export async function restoreWorktreeTo(
  handle: WorktreeHandle,
  sha: string,
  author?: GitAuthor,
): Promise<CommitResult> {
  const repoDir = handle.repoDir;
  const oid = await resolveCommit(repoDir, sha);
  if (!oid) throw new Error(`No such commit: ${sha}`);
  const [info] = await repoLog(repoDir, oid, 1);
  const ctx = await ensureBox(handle);
  await boxRestoreTreeFrom(ctx, oid, handle.appRoot);
  const subject = info?.subject ? ` "${info.subject}"` : "";
  return commitWorktree(
    handle,
    `Restore${subject} (${oid.slice(0, 7)})`,
    author,
  );
}

export async function fileVersions(
  handle: WorktreeHandle,
  relPath: string,
): Promise<BoxFileVersions> {
  // A read of the working copy: no configure, no pull, no hydration — the
  // box either has it or the diff cannot exist.
  const ctx = boxCtx(handle);
  if (!(await getSandboxProvider().hasSession(ctx))) {
    throw new Error(
      "The sandbox is not running; there is no working copy to diff.",
    );
  }
  return boxFileVersions(ctx, relPath);
}

/**
 * Commit the working copy and push it.
 *
 * `git commit && git push`, run in the sandbox, by the person or agent whose
 * box it is. The push is the durability guarantee — the job the WIP ref used
 * to do, done by the mechanism git already has for it.
 */
export async function commitWorktree(
  handle: WorktreeHandle,
  message: string,
  author?: GitAuthor,
  options: { stagedOnly?: boolean; paths?: string[] } = {},
): Promise<CommitResult> {
  const ctx = await ensureBox(handle);
  const result = await boxCommitAll({
    ctx,
    message,
    author,
    stagedOnly: options.stagedOnly,
    paths: options.paths,
  });
  if (!result.committed) return result;
  await syncBranchFromBox(handle);
  // No mirror queue and no poke here: boxCommitAll PUSHED, the push went
  // through the git endpoint, and the endpoint reacts (notifyRepoPushed).
  logger.info("Apps worktree committed", {
    branch: handle.doc.branch,
    commitOid: result.commitOid,
  });
  return result;
}

/**
 * Saving a file is a commit (apps.md §10 Block A).
 *
 * The squash-into-the-previous-save window that used to live here is gone. It
 * amended the branch head, which is fine while the branch exists only on the
 * server and is a force-push once the sandbox has the branch too — history
 * rewriting to save a line in a log. Consecutive saves now make consecutive
 * commits, which is what git does everywhere else.
 */
export async function autoCommitFileEdit(
  handle: WorktreeHandle,
  relPath: string,
  action: "edit" | "delete",
  author?: GitAuthor,
): Promise<CommitResult> {
  return commitWorktree(
    handle,
    `${action}: ${assertSafeRelPath(relPath)}`,
    author,
  );
}

/**
 * Commit whatever the agent left in the working copy at the end of a turn.
 *
 * One commit per turn is what makes a turn reviewable and revertable. Keyed by
 * ACTOR, not by chat: a conversation is not a line of work, so the agent
 * commits to the branch the person is on rather than one of its own.
 *
 * `touchedPaths` is what keeps concurrent chats out of each other's commits:
 * the sandbox is ONE working copy per (workspace, user), shared by every chat
 * that user runs, so an unscoped commit here swept whatever another chat had
 * in flight (apps.md §14.2 "commit only what it touched"). Callers pass the
 * repo-relative roots this turn's apps tools actually wrote to — empty means
 * the turn touched no app and there is nothing of OURS to commit, so we must
 * not commit at all. `undefined` keeps the old commit-everything behavior for
 * callers with no tracking (deliberate full sweeps).
 *
 * Never throws — finalization must not fail a turn. Nothing is lost by
 * failing: the work is in the working copy, exactly where it would be if a
 * person had written it and not committed yet.
 */
export async function commitAgentTurn(
  workspaceId: string,
  actorId: string,
  turnSummary?: string,
  touchedPaths?: string[],
): Promise<Array<{ commitOid?: string }>> {
  if (touchedPaths && touchedPaths.length === 0) return [];
  const doc = await AppWorktree.findOne({
    workspaceId: new Types.ObjectId(workspaceId),
    userId: actorId,
  });
  if (!doc) return [];

  const ctx: SandboxExecContext = {
    sessionKey: sessionKeyFor(doc.workspaceId, doc.userId),
  };
  try {
    // No sandbox means no uncommitted work to commit.
    if (!(await getSandboxProvider().hasSession(ctx))) return [];
    if (!(await boxHasRepo(ctx))) return [];

    const message = turnSummary?.trim()
      ? `Agent turn: ${turnSummary.trim().slice(0, 120)}`
      : `Agent turn (${new Date().toISOString()})`;
    // Authored by the human the agent acted for — blame and the git endpoint's
    // authorship check must both see the accountable person, not a bot — but
    // COMMITTED by "Mako Agent", so `git log --format='%an / %cn'` still shows
    // the change came from an agent turn. Falling back to the box's configured
    // identity (also the human) if the lookup misses.
    const human = await resolveActorIdentity(actorId);
    const result = await boxCommitAll({
      ctx,
      message,
      author: human,
      committer: { name: "Mako Agent", email: "agent@mako.ai" },
      paths: touchedPaths,
    });
    if (!result.committed) return [];
    // Mirror queue and window poke happen in the git endpoint's push
    // reaction, which this commit's own push just triggered.
    logger.info("Apps agent turn committed", {
      actorId,
      commitOid: result.commitOid,
    });
    return [{ commitOid: result.commitOid }];
  } catch (error) {
    logger.warn("Apps agent turn commit failed", {
      actorId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [{}];
  }
}

// ---------------------------------------------------------------------------
// Branches (list + merge to main)
// ---------------------------------------------------------------------------

export interface BranchInfo {
  name: string;
  head: string;
  isDefault: boolean;
  /** Commits ahead of the default branch (0 for the default itself). */
  aheadOfMain: number;
  lastCommit?: { subject: string; author: string; timestamp: number };
}

export async function listBranches(scope: RepoScope): Promise<BranchInfo[]> {
  const repoDir = await repoForWorkspace(scope.workspaceId);
  const { stdout } = await runGit([
    "-C",
    repoDir,
    "for-each-ref",
    "--format=%(refname:short)%00%(objectname)%00%(subject)%00%(authorname)%00%(authordate:unix)",
    "refs/heads/",
  ]);
  const defaultBranch = scope.defaultBranch;
  const branches: BranchInfo[] = [];
  for (const line of stdout.split("\n").filter(Boolean)) {
    const [name, head, subject, author, at] = line.split("\0");
    let aheadOfMain = 0;
    if (name !== defaultBranch) {
      try {
        const { stdout: count } = await runGit([
          "-C",
          repoDir,
          "rev-list",
          "--count",
          `refs/heads/${defaultBranch}..refs/heads/${name}`,
        ]);
        aheadOfMain = Number(count.trim()) || 0;
      } catch {
        aheadOfMain = 0;
      }
    }
    branches.push({
      name,
      head,
      isDefault: name === defaultBranch,
      aheadOfMain,
      lastCommit: subject
        ? { subject, author, timestamp: Number(at) * 1000 }
        : undefined,
    });
  }
  // Default branch first, then most recently committed.
  branches.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return (b.lastCommit?.timestamp ?? 0) - (a.lastCommit?.timestamp ?? 0);
  });
  return branches;
}

export interface MergeResult {
  merged: boolean;
  commitOid?: string;
  fastForward?: boolean;
  reason?: string;
}

/**
 * Merge a branch into the default branch, broker-side. Fast-forwards when
 * possible; otherwise builds a real merge commit with `git merge-tree`
 * (content-level three-way merge, no working tree needed). Conflicts abort
 * with a structured error — v0 has no in-product conflict resolution.
 */
export async function mergeBranchToMain(
  scope: RepoScope,
  branch: string,
  author?: GitAuthor,
): Promise<MergeResult> {
  const repoDir = await repoForWorkspace(scope.workspaceId);
  const defaultBranch = scope.defaultBranch;
  if (branch === defaultBranch) {
    return {
      merged: false,
      reason: "Cannot merge the default branch into itself",
    };
  }
  // Merge onto the mirror's main, not a stale cached tip (see
  // freshenBeforeMainWrite for why that would be unmirrorable).
  await freshenBeforeMainWrite(scope.workspaceId);
  const mainRef = `refs/heads/${defaultBranch}`;
  const branchHead = await resolveCommit(repoDir, `refs/heads/${branch}`);
  const mainHead = await resolveCommit(repoDir, mainRef);
  if (!branchHead || !mainHead) {
    return { merged: false, reason: "Branch not found" };
  }
  if (branchHead === mainHead) {
    return { merged: false, reason: "Already up to date" };
  }

  // Fast-forward when main is an ancestor of the branch.
  try {
    await runGit([
      "-C",
      repoDir,
      "merge-base",
      "--is-ancestor",
      mainHead,
      branchHead,
    ]);
    const swapped = await updateRefCas(repoDir, mainRef, branchHead, mainHead);
    if (!swapped) {
      throw new WorktreeConflictError("Main advanced concurrently; retry.");
    }
    queueMirrorPush(scope.workspaceId);
    pokeApp(scope.workspaceId, scope.projectId ?? null, "merge");
    invalidatePullThrottle();
    return { merged: true, commitOid: branchHead, fastForward: true };
  } catch (error) {
    if (error instanceof WorktreeConflictError) throw error;
    // Not an ancestor — fall through to a real merge.
  }

  const { stdout: mergeOut } = await runGit(
    ["-C", repoDir, "merge-tree", "--write-tree", mainHead, branchHead],
    // merge-tree exits 1 on conflicts; treat that as a structured failure.
  ).catch((e: unknown) => {
    throw new WorktreeConflictError(
      `Merge of ${branch} into ${defaultBranch} has conflicts — resolve them locally (clone the repo) or discard one side. ${e instanceof Error ? "" : ""}`.trim(),
    );
  });
  const mergedTree = mergeOut.trim().split("\n")[0];
  const commitOid = await commitTree(repoDir, {
    treeOid: mergedTree,
    parents: [mainHead, branchHead],
    message: `Merge ${branch} into ${defaultBranch}`,
    author,
  });
  const swapped = await updateRefCas(repoDir, mainRef, commitOid, mainHead);
  if (!swapped) {
    throw new WorktreeConflictError("Main advanced concurrently; retry.");
  }
  logger.info("Apps branch merged", {
    workspaceId: scope.workspaceId,
    branch,
    commitOid,
  });
  queueMirrorPush(scope.workspaceId);
  pokeApp(scope.workspaceId, scope.projectId ?? null, "merge");
  invalidatePullThrottle();
  return { merged: true, commitOid, fastForward: false };
}

/**
 * Point the actor's sandbox at a specific commit.
 *
 * Publishing uses this: the merge result is computed on the server, and the
 * build has to run against exactly that commit so the artifact is what would
 * ship — not against whatever the sandbox happened to have.
 */
export async function checkoutInBox(
  handle: WorktreeHandle,
  commitOid: string,
): Promise<void> {
  const ctx = await ensureBox(handle);
  const reset = await getSandboxProvider().exec(
    ctx,
    [
      // Fetch the COMMIT, by sha. A publish candidate is reachable from no
      // branch (that is the point — main has not moved yet), so "fetch the
      // branches" cannot bring it; the endpoint allows want-by-sha
      // (uploadpack.allowAnySHA1InWant) for exactly this call.
      `git -C ${sh(boxRoot(ctx))} fetch -q origin ${sh(commitOid)}`,
      `git -C ${sh(boxRoot(ctx))} reset -q --hard ${sh(commitOid)}`,
      `git -C ${sh(boxRoot(ctx))} clean -qfd`,
    ].join(" && "),
    { timeoutMs: 180_000 },
  );
  if (reset.exitCode !== 0) {
    throw new Error(
      `Could not check out ${commitOid.slice(0, 8)} in the sandbox: ${reset.stderr.slice(-300)}`,
    );
  }
}

/**
 * Switch branches — the same `git checkout` the terminal runs, as a button.
 *
 * Git decides the outcome: it carries uncommitted work across when the two
 * branches agree about the files you touched, and refuses, naming them, when
 * it would clobber something. A rule stricter than git's is what once made
 * branch switching impossible after a build wrote a lock file into the tree.
 */
export async function checkoutBranch(
  handle: WorktreeHandle,
  branch: string,
  options: { create?: boolean } = {},
): Promise<{ branch: string; head: string }> {
  const { doc, repoDir } = handle;
  const head = await resolveCommit(repoDir, `refs/heads/${branch}`);
  if (!head && !options.create) throw new Error(`No such branch: ${branch}`);
  if (head && options.create) {
    throw new Error(`Branch already exists: ${branch}`);
  }
  if (options.create && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) {
    throw new Error(`Not a valid branch name: ${branch}`);
  }

  const ctx = await ensureBox(handle);
  await boxCheckout(ctx, branch, { create: options.create });
  const after = await boxHead(ctx);

  doc.branch = after.branch;
  await doc.save();
  pokeApp(doc.workspaceId, null, "checkout", doc.userId);
  logger.info("Apps branch switched", { branch: after.branch });
  return { branch: after.branch, head: after.head };
}

/** Throw away uncommitted work — `git reset --hard && git clean -fd`. */
export async function discardWorktree(
  handle: WorktreeHandle,
): Promise<{ baseSha: string }> {
  const ctx = await ensureBox(handle);
  await boxDiscard(ctx);
  const after = await boxHead(ctx);
  pokeApp(handle.doc.workspaceId, null, "discard", handle.doc.userId);
  return { baseSha: after.head };
}

// ---------------------------------------------------------------------------
// Publish: trial merge, then promote (§13.3)
// ---------------------------------------------------------------------------

export interface TrialMergeResult {
  /** Commit that was built and would become the new `main`. */
  sha: string;
  /** False when the merge itself could not be performed. */
  ok: boolean;
  reason?: string;
}

/**
 * Merge `branch` into the publish worktree WITHOUT touching the real `main`.
 *
 * Publishing used to merge into `main` first and build afterwards, so a build
 * failure left `main` carrying the broken merge: production kept serving the
 * previous deployment, but the branch everyone publishes from was poisoned and
 * the next publish failed too. Building the merge result before `main` ever
 * moves means a failed publish changes nothing at all.
 *
 * Building the *merge result* rather than the branch also matters: if `main`
 * advanced since the branch forked, what lands is the merge, not the branch.
 */
export async function trialMerge(
  handle: WorktreeHandle,
  branch: string,
  author?: GitAuthor,
): Promise<TrialMergeResult> {
  const repoDir = handle.repoDir;
  const mainBranch = handle.project?.defaultBranch || DEFAULT_BRANCH;

  // A DISPOSABLE checkout, not a session. A merge needs a working directory,
  // but it does not need the actor's working copy and it certainly does not
  // need a sandbox — this is server-side git, run on a scratch clone that is
  // deleted when it is done. Nothing edits it, so it is not a second state.
  return scratchCheckout(repoDir, mainBranch, async dir => {
    if (branch !== mainBranch) {
      // No such branch means the caller has made no edits yet. Publishing then
      // is not an error — it deploys what `main` already holds. Distinguishing
      // this from a conflict matters: telling someone who has not changed
      // anything that their work "could not be merged" is simply a lie.
      const branchExists = await resolveCommit(repoDir, `refs/heads/${branch}`);
      if (!branchExists) {
        const head = await runGit(["-C", dir, "rev-parse", "HEAD"]);
        return { sha: head.stdout.trim(), ok: true };
      }
      try {
        await runGit(["-C", dir, "fetch", repoDir, branch], {
          timeoutMs: 60_000,
        });
        // Attribute the merge to whoever published it, not to the broker.
        const authorEnv = author
          ? {
              GIT_AUTHOR_NAME: author.name,
              GIT_AUTHOR_EMAIL: author.email,
              GIT_COMMITTER_NAME: author.name,
              GIT_COMMITTER_EMAIL: author.email,
            }
          : undefined;
        await runGit(["-C", dir, "merge", "--no-edit", "FETCH_HEAD"], {
          timeoutMs: 60_000,
          env: authorEnv,
        });
      } catch (error) {
        // Ask git whether this is a CONFLICT rather than pattern-matching a
        // message: it reports conflicts on stdout, so an error built from
        // stderr alone looks like any other failure — which is why the
        // actionable message below never fired. Unmerged index entries are
        // the authoritative signal.
        const unmerged = await runGit(["-C", dir, "ls-files", "-u"], {
          timeoutMs: 30_000,
        }).catch(() => ({ stdout: "" }));
        const conflicted = unmerged.stdout.trim().length > 0;
        return {
          sha: "",
          ok: false,
          reason: conflicted
            ? `Cannot publish: ${branch} conflicts with ${mainBranch}. Merge ${mainBranch} into it and resolve the conflicts first.`
            : `Could not merge ${branch} into ${mainBranch}: ${
                error instanceof Error ? error.message : String(error)
              }`,
        };
      }
    }

    const { stdout } = await runGit(["-C", dir, "rev-parse", "HEAD"]);
    const sha = stdout.trim();
    // Park the merge result in the repo so it survives the scratch dir, and so
    // the sandbox can be moved onto it to build exactly what would ship.
    //
    // FETCH the objects home first: the merge commit was born in this
    // scratch clone and the bare repo has never seen it. Writing the ref
    // directly failed with "nonexistent object" — but only for a TRUE merge,
    // which is why it survived so long: with main unmoved the merge
    // fast-forwards, the sha is a branch head the repo already has, and every
    // test and every manual publish happened to be that case.
    //
    // A fetch and not a push, because every repo's own config hides
    // refs/mako/* from transfer (initRepo) — receive-pack would refuse the
    // ref that this mechanism exists to write. Fetch runs no receive-pack and
    // no hooks; it just brings the objects, and the ref write stays the same
    // plain update it always was.
    await runGit(["-C", repoDir, "fetch", "-q", dir, "HEAD"], {
      timeoutMs: 60_000,
    });
    await updateRef(repoDir, PUBLISH_CANDIDATE_REF, sha);
    return { sha, ok: true };
  });
}

/**
 * Make the built candidate the new `main`.
 *
 * A compare-and-swap against the `main` the build started from, not a push
 * from a working copy: if someone else published while this build was running,
 * the artifact no longer corresponds to what `main` holds, and refusing is
 * correct. Doing it as a ref update also means the sandbox never needs
 * credentials for the repository — it built the tree, it does not publish it.
 */
export async function promoteToMain(
  handle: WorktreeHandle,
  input: { sha: string; expectedMain: string },
): Promise<void> {
  const mainBranch = handle.project?.defaultBranch || DEFAULT_BRANCH;
  const swapped = await updateRefCas(
    handle.repoDir,
    `refs/heads/${mainBranch}`,
    input.sha,
    input.expectedMain,
  );
  if (!swapped) {
    throw new Error(
      `${mainBranch} moved while the build was running; nothing was published. Try again.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Apps are folders (§13): the repo is the list, not the database
// ---------------------------------------------------------------------------

/** One app as the list knows it: an index row, by any other name. */
export type AppFolder = AppIndexRow & { id: string };

/**
 * Every app in a workspace, read from the repo (through the apps index).
 *
 * An app is a folder with a `mako.json`, anywhere under `apps/` or
 * `users/<id>/apps/`; that is the whole definition. It exists because the
 * folder exists, not because a row does — so pushing a folder from a local
 * checkout makes the app appear, and no registration step is needed.
 *
 * Mongo keeps only what genuinely cannot live in a repo the customer can
 * clone: who may see the app, what sha is deployed, and a share token with its
 * password hash. Those are server state ABOUT an app, not the app. The index
 * rows are a derived read model of the tree, rebuilt when main moves.
 */
export async function listAppFolders(
  workspaceId: string,
): Promise<AppFolder[]> {
  // A missing GitHub binding is an empty list, not a 412 (loadAppsIndex
  // answers EMPTY without a bound repo). Writes still 412 elsewhere.
  const snapshot = await loadAppsIndex(workspaceId);
  return snapshot.apps.map(app => ({ ...app, id: app.appId }));
}

/** The folders of both app trees, for the sidebar (empty ones included). */
export async function listAppFolderPaths(
  workspaceId: string,
): Promise<string[]> {
  return (await loadAppsIndex(workspaceId)).folders;
}

export type { AppSchedule };

/**
 * Persist the row for a folder-only app, keeping the DERIVED id so every
 * artifact key and worktree doc stays stable. The three row-creating acts
 * (§13.6: restrict, publish, share) all converge here; everything else keeps
 * reading the synthesized shape. Idempotent and race-safe: a concurrent
 * create loses the unique-index race and re-reads the winner.
 *
 * Publishing NEEDS this: `setPublishedSha` is an updateOne by _id, which
 * silently matches nothing for a synthesized project — the publish then
 * "succeeds" without persisting anything, and a reload shows the app
 * unpublished (found on prod with repo-imported apps, §13.22).
 */
export async function ensureProjectRow(
  project: IAppProject,
  actorId: string,
): Promise<IAppProject> {
  // Only a person can own an app. The push-deploy worker (PUBLISH_ACTOR), an
  // API key with no acting user ("") and similar sentinels create the row
  // ownerless; otherwise the auto-deploy of every repo-imported folder would
  // stamp the literal "publish" as owner_id, nobody could ever restrict or
  // share it, and a private access setting would lock out even admins.
  const owner = isUserActor(actorId) ? actorId : undefined;
  const existing = await AppProject.findOne({
    _id: project._id,
    workspaceId: project.workspaceId,
  });
  if (existing) {
    // First human to act on an ownerless row claims it (resource-acl reads
    // owner_id, then createdBy).
    if (owner && !existing.owner_id && !existing.createdBy) {
      await AppProject.updateOne(
        {
          _id: existing._id,
          workspaceId: project.workspaceId,
          owner_id: { $in: [null, ""] },
        },
        { $set: { owner_id: owner, createdBy: owner } },
      );
      return (
        (await AppProject.findOne({
          _id: existing._id,
          workspaceId: project.workspaceId,
        })) ?? existing
      );
    }
    return existing;
  }
  try {
    return await AppProject.create({
      _id: project._id,
      workspaceId: project.workspaceId,
      title: project.title,
      slug: project.slug,
      path: project.path ?? appRootFor(project),
      description: project.description,
      access: project.access ?? "workspace",
      createdBy: project.createdBy || owner || "",
      ...(owner ? { owner_id: owner } : {}),
      defaultBranch: project.defaultBranch || DEFAULT_BRANCH,
    });
  } catch {
    const winner = await AppProject.findOne({
      _id: project._id,
      workspaceId: project.workspaceId,
    });
    if (winner) return winner;
    throw new Error("Could not persist the app's project row");
  }
}

/**
 * An app that exists only as a folder, shaped like a project document so every
 * read path works unchanged. Never persisted — writing a row is what happens
 * when someone restricts, publishes, or shares the app, not when they open it.
 */
export async function synthesizeProjectFromFolder(
  workspaceId: string,
  ref: string,
  options: {
    /**
     * On a miss, force one mirror fetch and look again (default true). The
     * read-after-push contract for every app_* tool: a folder pushed a
     * moment ago to another API instance resolves here on the first call,
     * without every HIT paying a GitHub round trip.
     */
    fetchOnMiss?: boolean;
  } = {},
): Promise<IAppProject | null> {
  const folder = await resolveAppRef(workspaceId, ref, {
    fetchOnMiss: options.fetchOnMiss !== false,
  });
  if (!folder) return null;
  return projectFromIndexRow(workspaceId, folder);
}

/** An index row shaped like a project document, never persisted. */
export function projectFromIndexRow(
  workspaceId: string,
  folder: AppIndexRow,
): IAppProject {
  return {
    _id: new Types.ObjectId(folder.appId),
    workspaceId: new Types.ObjectId(workspaceId),
    title: folder.title,
    slug: folder.slug,
    path: folder.path,
    description: folder.description,
    // A folder under users/<id>/apps is that person's: private to them
    // until they share it, exactly like a private console.
    access: folder.scope === "private" ? "private" : "workspace",
    ...(folder.scope === "private" && folder.ownerId
      ? { owner_id: folder.ownerId }
      : {}),
    createdBy: "",
    defaultBranch: DEFAULT_BRANCH,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as IAppProject;
}

/**
 * Resolve an app by id, path or slug: the project row when one exists
 * (sharing, deployment, env — with its path kept current by the index), the
 * synthesized shape when the app is only a folder, and the bare row when the
 * folder has left main (a published app whose folder was deleted keeps its
 * row until someone deletes the app). This is THE resolver; every route and
 * tool goes through it so id, path and slug all mean the same app.
 *
 * Order: what is CURRENT first — the index (id, path, name as it is today),
 * then a row whose folder is no longer on main — and only then an alias
 * (a previous name of a live app). A deleted-folder app that still has
 * state keeps its name against any live app that merely used to have it.
 */
export async function resolveProjectRef(
  workspaceId: string,
  ref: string,
  options: { fetchOnMiss?: boolean } = {},
): Promise<IAppProject | null> {
  const ws = new Types.ObjectId(workspaceId);
  const clean = ref.trim().normalize("NFC").replace(/^\/+/, "");
  const found = await resolveAppRefVia(workspaceId, clean, options);
  const fromFolder = async (folder: AppIndexRow): Promise<IAppProject> => {
    const row = await AppProject.findOne({
      _id: new Types.ObjectId(folder.appId),
      workspaceId: ws,
    });
    if (row) {
      // The index is the truth about WHERE the app is; the row may lag a
      // push by the length of one sync.
      if (row.path !== folder.path || row.slug !== folder.slug) {
        row.path = folder.path;
        row.slug = folder.slug;
      }
      return row;
    }
    return projectFromIndexRow(workspaceId, folder);
  };
  if (found?.via === "current") return fromFolder(found.app);

  // Rows without a folder on main. Only those: a live app's row is reached
  // through the index above, and "whichever row Mongo returns first" for a
  // name the index refused (several nested apps share it) would edit,
  // publish or serve bindings for the wrong app.
  const snapshot = await loadAppsIndex(workspaceId, { freshen: false });
  const onMain = new Set(snapshot.apps.map(a => a.appId));
  const folderless = (row: IAppProject | null): IAppProject | null =>
    row && !onMain.has(row._id.toString()) ? row : null;
  if (Types.ObjectId.isValid(clean) && /^[0-9a-f]{24}$/i.test(clean)) {
    const byId = folderless(
      await AppProject.findOne({
        _id: new Types.ObjectId(clean),
        workspaceId: ws,
      }),
    );
    if (byId) return byId;
  } else {
    const byPath = folderless(
      await AppProject.findOne({ path: clean, workspaceId: ws }),
    );
    if (byPath) return byPath;
    const stripped = clean.replace(/^apps\//, "");
    // A bare name some live app holds is the index's to resolve (it did,
    // or refused it as ambiguous — final either way).
    if (
      (clean === stripped || clean.startsWith("apps/")) &&
      !snapshot.apps.some(a => a.slug === stripped)
    ) {
      const bySlug = folderless(
        await AppProject.findOne({ slug: stripped, workspaceId: ws }),
      );
      if (bySlug) return bySlug;
    }
  }
  return found ? fromFolder(found.app) : null;
}
