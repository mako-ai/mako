/**
 * Apps v2 worktree service.
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
import { createHash } from "node:crypto";
import path from "node:path";
import { Types } from "mongoose";
import {
  AppProjectV2,
  AppWorktreeV2,
  type IAppProjectV2,
  type IAppWorktreeV2,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import {
  boxCheckout,
  boxCommitAll,
  boxDiscard,
  boxGlob,
  boxGrep,
  boxHasRepo,
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
  workspaceRootGitignore,
  boxGitPaths,
  boxFileVersions,
  boxPorcelain,
  type BoxFileVersions,
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
  APPS_V2_MAX_FILE_BYTES,
  appsV2GitOriginBase,
  appsV2SessionsRoot,
} from "./config";
import { assertSafeRelPath, runGit, ZERO_OID } from "./git";
import {
  DEFAULT_BRANCH,
  commitTree,
  globTree,
  grepTree,
  initRepo,
  listTree,
  log as repoLog,
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
import { appSdkFiles } from "./app-sdk-package";
import { createAppsV2Scaffold } from "./scaffold";
import {
  ensureCloudRepo,
  ensureLocalRepo,
  mirrorPushNow,
  queueMirrorPush,
} from "./cloud-repo.service";

/**
 * Local repo dir for a project, restoring it from the cloud mirror first
 * when the cache is cold (serverless hosts start with an empty
 * APPS_V2_GIT_ROOT — see ensureLocalRepo).
 */
async function repoFor(project: IAppProjectV2): Promise<string> {
  return repoForWorkspace(project.workspaceId.toString());
}

/** §10 monorepo: the ONE bare repo per workspace (clone-on-miss). */
async function repoForWorkspace(workspaceId: string): Promise<string> {
  await ensureLocalRepo(workspaceId);
  return repoDirFor(workspaceId);
}

/** Repo-relative folder an app's content lives under (§10: apps/<slug>). */
export function appRootFor(project: IAppProjectV2): string {
  return `apps/${project.slug ?? project._id.toString()}`;
}

/** Prefix an app-relative path into its repo-relative form. */
function appPath(project: IAppProjectV2, relPath: string): string {
  return `${appRootFor(project)}/${assertSafeRelPath(relPath)}`;
}
import {
  getSandboxProvider,
  type SandboxExecContext,
  type SandboxExecOptions,
  type SandboxExecResult,
} from "./sandbox/provider";

const logger = loggers.api("apps-v2");

/** Poke open windows to refetch this app's git-backed state. */
function pokeAppV2(
  workspaceId: { toString(): string },
  appId: { toString(): string } | null | undefined,
  origin: "commit" | "merge" | "discard" | "checkout" | "lifecycle" | "push",
  updatedBy?: string,
): void {
  publishRealtimeEvent(workspaceId.toString(), {
    type: "app-v2.updated",
    // "" = workspace-wide (a workspace worktree changed; may span apps).
    appId: appId?.toString() ?? "",
    updatedBy,
    origin,
  });
}

/**
 * React to commits reaching this server's bare repo over the git endpoint.
 *
 * Called by routes/apps-v2-git.ts after every completed receive-pack. This is
 * the ONE place push-shaped side effects live, because every path commits take
 * to the server — the commit button, the agent's end-of-turn commit, `git
 * push` typed in a terminal — converges on that endpoint. The commit
 * functions below deliberately do not queue the mirror or poke windows
 * themselves; doing it both here and there meant every button-press push did
 * its bookkeeping twice, and a terminal push did it zero times.
 */
export function notifyRepoPushed(workspaceId: string, userId: string): void {
  queueMirrorPush(workspaceId);
  pokeAppV2(workspaceId, null, "push", userId);
  // Another box on the same branch is now behind; let it pull on next touch.
  invalidatePullThrottle();
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
  doc: IAppWorktreeV2;
  project: IAppProjectV2;
  repoDir: string;
  /** Repo-relative root of the app this handle was opened for. */
  appRoot: string;
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
export async function rehydrateBox(
  handle: WorktreeHandle,
  ctx: SandboxExecContext,
): Promise<void> {
  logger.warn("Apps v2 box missing its working copy; rehydrating", {
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
    });
    await ensureBoxAgent(ctx, { force: true });
    lastPull.set(ctx.sessionKey, Date.now());
    lastConfigured.set(ctx.sessionKey, {
      at: Date.now(),
      base: appsV2GitOriginBase(),
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
  if (await boxHasRepo(ctx)) {
    // Reconfigure when the token is due for a refresh OR when the origin the
    // box should point at has changed (a tunnel restart in development). The
    // record is written only after configure SUCCEEDS: recording first meant
    // a failed configure was remembered as done for the whole interval.
    const base = appsV2GitOriginBase();
    const last = lastConfigured.get(ctx.sessionKey);
    if (
      !last ||
      last.base !== base ||
      Date.now() - last.at > RECONFIGURE_INTERVAL_MS
    ) {
      await configureBoxRemote({ ctx, workspaceId, userId });
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
  });
  await ensureBoxAgent(ctx, { force: true });
  lastPull.set(ctx.sessionKey, Date.now());
  lastConfigured.set(ctx.sessionKey, {
    at: Date.now(),
    base: appsV2GitOriginBase(),
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

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return base || "app";
}

async function uniqueSlug(workspaceId: string, title: string): Promise<string> {
  const base = slugify(title);
  const taken = new Set(
    (
      await AppProjectV2.find({
        workspaceId: new Types.ObjectId(workspaceId),
        slug: { $exists: true },
      })
        .select("slug")
        .lean()
    ).map(d => d.slug as string),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Commit a mutation (writes and/or prefix deletions) directly onto a branch
 * of the bare repo via a throwaway clone. Used for app lifecycle commits
 * (scaffold, delete) and by the v1→v2 migrator — actor worktrees are not
 * involved.
 */
export async function commitFilesOnBranch(
  repoDir: string,
  branch: string,
  mutation: { writes?: Record<string, string>; deletePrefixes?: string[] },
  options: { message: string; author?: GitAuthor },
): Promise<{ commitOid: string; previousHead: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const head = await resolveCommit(repoDir, `refs/heads/${branch}`);
    if (!head) throw new Error(`Branch ${branch} is missing`);
    await fs.mkdir(appsV2SessionsRoot(), { recursive: true });
    const tmp = await fs.mkdtemp(path.join(appsV2SessionsRoot(), "lifecycle-"));
    try {
      await runGit(["clone", "--branch", branch, repoDir, tmp], {
        timeoutMs: 120_000,
      });
      for (const prefix of mutation.deletePrefixes ?? []) {
        await fs.rm(path.join(tmp, assertSafeRelPath(prefix)), {
          recursive: true,
          force: true,
        });
      }
      for (const [rel, contents] of Object.entries(mutation.writes ?? {})) {
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
      const swapped = await updateRefCas(
        repoDir,
        `refs/heads/${branch}`,
        commitOid,
        head,
      );
      if (swapped) return { commitOid, previousHead: head };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
  throw new WorktreeConflictError(
    `Branch ${branch} kept advancing during a lifecycle commit; retry.`,
  );
}

const WORKSPACE_README = `# Mako workspace

Managed by Mako. Apps live under apps/<name>; consoles, skills and dbt
content will join as sibling folders (apps-v2.md §10).
`;

export async function createProject(input: {
  workspaceId: string;
  title: string;
  description?: string;
  userId?: string;
  author?: GitAuthor;
}): Promise<IAppProjectV2> {
  const title = input.title.trim() || "Untitled app";
  const slug = await uniqueSlug(input.workspaceId, title);
  const project = await AppProjectV2.create({
    workspaceId: new Types.ObjectId(input.workspaceId),
    title,
    slug,
    description: input.description,
    access: "private",
    owner_id: input.userId,
    createdBy: input.userId ?? "system",
    defaultBranch: DEFAULT_BRANCH,
  });

  // §10 monorepo: ensure the ONE workspace repo, then commit the scaffold
  // under apps/<slug>/ onto main.
  const repoDir = await repoForWorkspace(input.workspaceId);
  let scaffoldCommit: { commitOid: string; previousHead: string } | null = null;
  try {
    if (!(await repoExists(repoDir))) {
      await initRepo(
        repoDir,
        {
          "README.md": WORKSPACE_README,
          // The @mako/app-sdk package, so `import { useQuery } from
          // "@mako/app-sdk"` resolves in every app via a file: dependency —
          // in vite dev, in npm run build, and in a laptop clone alike.
          ...appSdkFiles(),
          // The root .gitignore is the guarantee that EVERY app — scaffolded,
          // hand-built by an agent, or pushed from a laptop — ignores what
          // must never be committed. Per-app .gitignores and the sandbox's
          // info/exclude are refinements; this is the one that is versioned.
          ".gitignore": workspaceRootGitignore(),
        },
        { message: "Initialize workspace repository", author: input.author },
      );
    }
    const scaffold = createAppsV2Scaffold({
      title: project.title,
      description: input.description,
    });
    const prefixed: Record<string, string> = {};
    for (const [rel, contents] of Object.entries(scaffold)) {
      prefixed[`apps/${slug}/${rel}`] = contents;
    }
    scaffoldCommit = await commitFilesOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { writes: prefixed },
      { message: `Create app "${title}" (apps/${slug})`, author: input.author },
    );
  } catch (error) {
    // Don't leave a content-less project behind.
    await AppProjectV2.deleteOne({ _id: project._id });
    throw error;
  }
  // Cloud tier: mirror the workspace repo to Mako's org. When the cloud app
  // is configured, the durable push is REQUIRED — on serverless hosts the
  // local repo is an ephemeral cache. Hosts without cloud config (pure local
  // dev) keep working local-only.
  try {
    if (await ensureCloudRepo(input.workspaceId)) {
      await mirrorPushNow(input.workspaceId);
    }
  } catch (error) {
    await AppProjectV2.deleteOne({ _id: project._id });
    // Roll the scaffold commit back so the repo matches the docs.
    await updateRefCas(
      repoDir,
      `refs/heads/${DEFAULT_BRANCH}`,
      scaffoldCommit.previousHead,
      scaffoldCommit.commitOid,
    ).catch(() => undefined);
    logger.error("Apps v2 creation aborted: durable push failed", {
      projectId: project._id.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(
      `Could not store the app durably (GitHub push failed): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  logger.info("Apps v2 project created", {
    projectId: project._id.toString(),
    workspaceId: input.workspaceId,
    slug,
  });
  pokeAppV2(project.workspaceId, project._id, "lifecycle", input.userId);
  return project;
}

export async function deleteProject(project: IAppProjectV2): Promise<void> {
  // §10 monorepo: deleting an app is a COMMIT removing its folder — the
  // workspace repo (and other apps, worktrees, history) are untouched.
  const repoDir = await repoForWorkspace(project.workspaceId.toString());
  if (await repoExists(repoDir)) {
    await commitFilesOnBranch(
      repoDir,
      project.defaultBranch || DEFAULT_BRANCH,
      { deletePrefixes: [appRootFor(project)] },
      { message: `Delete app "${project.title}" (${appRootFor(project)})` },
    );
    queueMirrorPush(project.workspaceId.toString());
  }
  await AppProjectV2.deleteOne({ _id: project._id });
  pokeAppV2(project.workspaceId, project._id, "lifecycle");
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

/**
 * Which branch an actor starts on when the caller does not name one: the
 * default branch, like a fresh clone on a laptop.
 *
 * Actors used to be forced onto a personal `user/<id>` branch ("you do not
 * edit production"). That guarded the wrong thing: publish deploys a PINNED
 * sha, so a commit on `main` moves the branch but ships nothing — exactly
 * like committing to main of a repo whose releases are tagged. Meanwhile the
 * forced branch made the everyday experience alien: everyone lived on a
 * branch named after their user id, and "just commit it" needed a merge
 * ceremony. Now the working copy is unrestricted, git-native; whoever wants
 * main protected does it at the remote (the git endpoint's pre-receive hook
 * carries GitHub's defaults — no force-push, no delete — and a mirrored
 * GitHub repo can layer its own rules).
 */
export function defaultBranchForActor(_actorId: string): string {
  return DEFAULT_BRANCH;
}

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
  project: IAppProjectV2,
  actorId: string,
  options: { branch?: string } = {},
): Promise<WorktreeHandle> {
  const repoDir = await repoFor(project);
  if (!(await repoExists(repoDir))) {
    throw new Error("Project repository is missing");
  }

  const mainHead = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!mainHead) throw new Error("Project branch is missing");

  // The doc remembers which branch this actor is on (checkoutBranch writes
  // it); an actor with no doc yet starts on the default branch, like a fresh
  // clone. options.branch overrides both (publish pins main explicitly).
  const existing = await AppWorktreeV2.findOne({
    workspaceId: project.workspaceId,
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
    logger.info("Apps v2 actor branch created", {
      projectId: project._id.toString(),
      branch,
    });
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
  const doc = await AppWorktreeV2.findOneAndUpdate(
    { workspaceId: project.workspaceId, userId: actorId },
    { $setOnInsert: { branch } },
    { new: true, upsert: true },
  );

  return {
    doc,
    project,
    repoDir,
    appRoot: appRootFor(project),
  };
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
      logger.info("Apps v2 following a branch switch made in the sandbox", {
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
      logger.warn("Apps v2 could not push commits made in the shell", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  return result;
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
  project: IAppProjectV2,
  userId: string | undefined,
): Promise<
  | { kind: "box"; ctx: SandboxExecContext; handle: WorktreeHandle }
  | { kind: "repo"; repoDir: string; ref: string }
> {
  const repoDir = await repoFor(project);
  const branchRef = `refs/heads/${project.defaultBranch || DEFAULT_BRANCH}`;
  if (!userId) return { kind: "repo", repoDir, ref: branchRef };

  const doc = await AppWorktreeV2.findOne({
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
  project: IAppProjectV2,
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
  project: IAppProjectV2,
  relPath: string,
  userId?: string,
): Promise<{
  path: string;
  contents: string;
  isBinary: boolean;
  size: number;
}> {
  const safe = assertSafeRelPath(relPath);
  const source = await readSource(project, userId);
  if (source.kind === "box") {
    const blob = await boxReadFile(source.ctx, appPath(project, safe));
    return { path: safe, ...blob };
  }
  const blob = await readBlob(
    source.repoDir,
    source.ref,
    appPath(project, safe),
  );
  return { path: safe, ...blob };
}

/** Search file contents at whatever the actor is actually looking at. */
export async function grepFiles(
  project: IAppProjectV2,
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
  project: IAppProjectV2,
  glob: string,
  userId?: string,
  limit?: number,
): Promise<string[]> {
  const source = await readSource(project, userId);
  const root = appRootFor(project);
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
  const safe = appPath(handle.project, relPath);
  if (Buffer.byteLength(contents, "utf8") > APPS_V2_MAX_FILE_BYTES) {
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
  const blob = await boxReadFile(ctx, appPath(handle.project, relPath));
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
  project: IAppProjectV2,
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
    logger.warn("Apps v2 live-box catch-up failed", {
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
    const doc = await AppWorktreeV2.findOne({
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
      logger.info("Apps v2 following a branch switch made in the terminal", {
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
    logger.warn("Apps v2 terminal settle-up failed", {
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
  project: IAppProjectV2,
  userId: string,
): Promise<WorktreeStatus | null> {
  const repoDir = await repoFor(project);
  const doc = await AppWorktreeV2.findOne({
    workspaceId: project.workspaceId,
    userId,
  });
  if (!doc) return null;

  const handle: WorktreeHandle = {
    doc,
    project,
    repoDir,
    appRoot: appRootFor(project),
  };
  const ctx = boxCtx(handle);

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
      logger.info("Apps v2 following a branch switch reported by the box", {
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
    const prefix = `${appRootFor(project)}/`;
    return {
      branch: snapshot.branch,
      baseSha: snapshot.head ?? branchHead ?? "",
      branchHead,
      ahead: snapshot.ahead ?? 0,
      changes: snapshot.changes
        .filter(ch => ch.path.startsWith(prefix))
        .map(ch => ({ ...ch, path: ch.path.slice(prefix.length) })),
      repoChanges: snapshot.changes,
      offline: false,
    };
  }

  const live =
    (await getSandboxProvider()
      .hasSession(ctx)
      .catch(() => false)) && (await boxHasRepo(ctx).catch(() => false));

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
  const prefix = `${appRootFor(project)}/`;
  return {
    branch: status.branch,
    baseSha: status.head,
    branchHead,
    ahead: status.ahead,
    changes: status.changes
      .filter(ch => ch.path.startsWith(prefix))
      .map(ch => ({ ...ch, path: ch.path.slice(prefix.length) })),
    repoChanges: status.changes,
    offline: false,
  };
}

/**
 * Commit sha at the tip of the project's default branch — what a publish
 * deploys, and the identity an immutable deployment is keyed by (§13.3).
 */
export async function defaultBranchSha(
  project: IAppProjectV2,
): Promise<string> {
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
  project: IAppProjectV2,
  limit = 20,
  ref?: string,
  scope: "app" | "repo" = "app",
) {
  const repoDir = await repoFor(project);
  // History follows the branch the caller is actually on (VS Code semantics),
  // falling back to the default branch when the ref is absent or bogus. The
  // shape check keeps user input out of argv option position; show-ref
  // verifies existence without ever resolving arbitrary expressions.
  let target = `refs/heads/${project.defaultBranch || DEFAULT_BRANCH}`;
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
  return repoLog(
    repoDir,
    target,
    limit,
    scope === "repo" ? undefined : appRootFor(project),
  );
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
    logger.warn("Apps v2 could not push status after a git action", {
      action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** HEAD / index / working-tree contents of one repo-relative path, for diffs. */
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
  options: { stagedOnly?: boolean } = {},
): Promise<CommitResult> {
  const ctx = await ensureBox(handle);
  const result = await boxCommitAll({
    ctx,
    message,
    author,
    stagedOnly: options.stagedOnly,
  });
  if (!result.committed) return result;
  await syncBranchFromBox(handle);
  // No mirror queue and no poke here: boxCommitAll PUSHED, the push went
  // through the git endpoint, and the endpoint reacts (notifyRepoPushed).
  logger.info("Apps v2 worktree committed", {
    branch: handle.doc.branch,
    commitOid: result.commitOid,
  });
  return result;
}

/**
 * Saving a file is a commit (apps-v2.md §10 Block A).
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
 * Never throws — finalization must not fail a turn. Nothing is lost by
 * failing: the work is in the working copy, exactly where it would be if a
 * person had written it and not committed yet.
 */
export async function commitAgentTurn(
  workspaceId: string,
  actorId: string,
  turnSummary?: string,
): Promise<Array<{ commitOid?: string }>> {
  const doc = await AppWorktreeV2.findOne({
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
    const result = await boxCommitAll({
      ctx,
      message,
      author: { name: "Mako Agent", email: "agent@mako.ai" },
    });
    if (!result.committed) return [];
    // Mirror queue and window poke happen in the git endpoint's push
    // reaction, which this commit's own push just triggered.
    logger.info("Apps v2 agent turn committed", {
      actorId,
      commitOid: result.commitOid,
    });
    return [{ commitOid: result.commitOid }];
  } catch (error) {
    logger.warn("Apps v2 agent turn commit failed", {
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

export async function listBranches(
  project: IAppProjectV2,
): Promise<BranchInfo[]> {
  const repoDir = await repoFor(project);
  const { stdout } = await runGit([
    "-C",
    repoDir,
    "for-each-ref",
    "--format=%(refname:short)%00%(objectname)%00%(subject)%00%(authorname)%00%(authordate:unix)",
    "refs/heads/",
  ]);
  const defaultBranch = project.defaultBranch || DEFAULT_BRANCH;
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
  project: IAppProjectV2,
  branch: string,
  author?: GitAuthor,
): Promise<MergeResult> {
  const repoDir = await repoFor(project);
  const defaultBranch = project.defaultBranch || DEFAULT_BRANCH;
  if (branch === defaultBranch) {
    return {
      merged: false,
      reason: "Cannot merge the default branch into itself",
    };
  }
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
    queueMirrorPush(project.workspaceId.toString());
    pokeAppV2(project.workspaceId, project._id, "merge");
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
  logger.info("Apps v2 branch merged", {
    projectId: project._id.toString(),
    branch,
    commitOid,
  });
  queueMirrorPush(project.workspaceId.toString());
  pokeAppV2(project.workspaceId, project._id, "merge");
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
  pokeAppV2(doc.workspaceId, null, "checkout", doc.userId);
  logger.info("Apps v2 branch switched", { branch: after.branch });
  return { branch: after.branch, head: after.head };
}

/** Throw away uncommitted work — `git reset --hard && git clean -fd`. */
export async function discardWorktree(
  handle: WorktreeHandle,
): Promise<{ baseSha: string }> {
  const ctx = await ensureBox(handle);
  await boxDiscard(ctx);
  const after = await boxHead(ctx);
  pokeAppV2(handle.doc.workspaceId, null, "discard", handle.doc.userId);
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
  const mainBranch = handle.project.defaultBranch || DEFAULT_BRANCH;

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
  const mainBranch = handle.project.defaultBranch || DEFAULT_BRANCH;
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

export interface AppFolder {
  /** Folder name under `apps/` — the app's identity. */
  slug: string;
  title: string;
  description?: string;
}

/**
 * Every app in a workspace, read from the repo.
 *
 * An app is `apps/<name>/` with a `mako.json`; that is the whole definition.
 * It exists because the folder exists, not because a row does — so pushing a
 * folder from a local checkout makes the app appear, and no registration step
 * is needed anywhere.
 *
 * Mongo keeps only what genuinely cannot live in a repo the customer can
 * clone: who may see the app, what sha is deployed, and a share token with its
 * password hash. Those are server state ABOUT an app, not the app.
 */
export async function listAppFolders(
  workspaceId: string,
): Promise<AppFolder[]> {
  const repoDir = await repoForWorkspace(workspaceId);
  const entries = await listTree(repoDir, DEFAULT_BRANCH).catch(() => []);
  const manifests = entries.filter(e =>
    /^apps\/[^/]+\/mako\.json$/.test(e.path),
  );

  const folders: AppFolder[] = [];
  for (const entry of manifests) {
    const slug = entry.path.split("/")[1];
    let title = slug;
    let description: string | undefined;
    try {
      const blob = await readBlob(repoDir, DEFAULT_BRANCH, entry.path);
      const manifest = JSON.parse(blob.contents) as {
        title?: unknown;
        description?: unknown;
      };
      if (typeof manifest.title === "string" && manifest.title.trim()) {
        title = manifest.title;
      }
      if (typeof manifest.description === "string") {
        description = manifest.description;
      }
    } catch {
      // An unreadable or malformed manifest must not hide the app: the folder
      // is the app, and a broken mako.json is something the user needs to SEE
      // in order to fix.
    }
    folders.push({ slug, title, description });
  }
  return folders.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Stable id for an app that has no database row.
 *
 * Downstream keys — deployment prefixes, binding artifacts, sandbox session
 * affinity — are all built from a project id, and they must not move when a
 * row happens to appear later. Deriving the id from (workspace, folder) makes
 * it a function of the app's identity rather than a second identity of its
 * own, so a folder-only app keys the same artifacts before and after any state
 * record is written for it.
 *
 * Apps that predate this keep their original random id: their existing
 * artifacts are already keyed by it.
 */
export function derivedAppId(
  workspaceId: string,
  slug: string,
): Types.ObjectId {
  const digest = createHash("sha1")
    .update(`apps-v2:${workspaceId}:${slug}`)
    .digest("hex");
  return new Types.ObjectId(digest.slice(0, 24));
}

/**
 * An app that exists only as a folder, shaped like a project document so every
 * read path works unchanged. Never persisted — writing a row is what happens
 * when someone restricts, publishes, or shares the app, not when they open it.
 */
export async function synthesizeProjectFromFolder(
  workspaceId: string,
  slug: string,
): Promise<IAppProjectV2 | null> {
  const folder = (await listAppFolders(workspaceId)).find(f => f.slug === slug);
  if (!folder) return null;
  return {
    _id: derivedAppId(workspaceId, slug),
    workspaceId: new Types.ObjectId(workspaceId),
    title: folder.title,
    slug: folder.slug,
    description: folder.description,
    access: "workspace",
    createdBy: "",
    defaultBranch: DEFAULT_BRANCH,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as IAppProjectV2;
}
