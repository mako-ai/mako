/**
 * Deploy on push to `main` (apps.md §13).
 *
 * `main` is production, so the act that makes something live should be the act
 * of putting it on `main` — `git push` from a checkout, a merge on GitHub, the
 * Publish button, anything. GitHub is where every one of those paths
 * converges: a local clone pushes straight there, and Mako mirrors its own
 * commits there too. So one webhook covers all of them, and a person working
 * the way §11.3 describes never has to open a browser to ship.
 *
 * `publishedSha` stops being a pointer somebody sets and becomes what it
 * always meant: the last commit of `main` that built.
 *
 * "Changed" is decided by the app folder's git TREE oid, not by which paths a
 * diff lists: a folder moved to another place has the same tree, so filing an
 * app under `apps/sales/` rebuilds nothing — the deployment is keyed by the
 * app's id, which the manifest carries along.
 */
import { loggers } from "../logging";
import { runGit } from "./git";
import {
  PUBLISH_ACTOR,
  appRootFor,
  checkoutInBox,
  ensureProjectRow,
  ensureWorktree,
  execInWorktree,
  repoForWorkspace,
  resolveProjectRef,
} from "./worktree.service";
import { assignAppIds, loadAppsIndex, readAppsAt } from "./app-index.service";
import {
  buildApp,
  clearPublishedSha,
  deployBuild,
  deploymentExists,
  ensureDeploymentBindings,
  recordDeployFailure,
  setPublishedSha,
} from "./deployment.service";
import { ensureCommitLocally } from "./cloud-repo.service";

const logger = loggers.api("apps-deploy-on-push");

/**
 * Is the app's folder present in the tree at `sha`? Throws when the commit
 * itself is not here — that is a fetch problem to retry, never "the app is
 * gone" (which would unpublish a live app over a stale mirror).
 */
async function appFolderExistsAt(
  repoDir: string,
  appPath: string,
  sha: string,
): Promise<boolean> {
  await runGit(["-C", repoDir, "cat-file", "-e", `${sha}^{commit}`]);
  return runGit(["-C", repoDir, "cat-file", "-e", `${sha}:${appPath}`])
    .then(() => true)
    .catch(() => false);
}

/** The folder's tree oid at a commit, or null when it is not there. */
async function treeOidAt(
  repoDir: string,
  sha: string,
  appPath: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit([
      "-C",
      repoDir,
      "rev-parse",
      "--verify",
      "--quiet",
      `${sha}:${appPath}`,
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Apps whose content differs between two commits, by id. An app that only
 * moved keeps its tree oid and is not listed; an app whose folder vanished IS
 * listed, so the deploy can unpublish it.
 */
async function changedApps(
  workspaceId: string,
  repoDir: string,
  before: string | undefined,
): Promise<string[]> {
  // The index describes main's current head, which is `after` for a push
  // this instance just fetched (and anything newer is still what to deploy).
  const now = await loadAppsIndex(workspaceId);
  const range =
    before && /^[0-9a-f]{40}$/.test(before) && !/^0+$/.test(before)
      ? before
      : // First push, or a force-push we cannot diff against: treat every app
        // as changed rather than silently deploying none.
        null;
  if (!range) return now.apps.map(a => a.appId);

  // The same identity rules at `before` as the index applied at `after`, so
  // a moved app matches itself across the two commits.
  const was = await readAppsAt(repoDir, range);
  const ids = assignAppIds(
    workspaceId,
    was.apps.map(a => ({
      path: a.path,
      declaredId: was.manifests.get(a.path)?.id,
    })),
    new Map(now.apps.map(a => [a.appId, a.path])),
  );
  const oidBefore = new Map<string, string>();
  for (const app of was.apps) {
    const id = ids.get(app.path)?.appId;
    if (id) oidBefore.set(id, app.treeOid);
  }
  const changed = new Set<string>();
  for (const app of now.apps) {
    if (oidBefore.get(app.appId) !== app.treeOid) changed.add(app.appId);
  }
  // Gone: present before, absent now.
  for (const id of oidBefore.keys()) {
    if (!now.apps.some(a => a.appId === id)) changed.add(id);
  }
  return [...changed];
}

/**
 * Did the app's folder change between two commits? Tree oids, so a move
 * reads as unchanged. The one question both the webhook and the hourly
 * reconcile ask.
 */
export async function appFolderChanged(
  repoDir: string,
  appPath: string,
  from: string,
  to: string,
): Promise<boolean> {
  const [a, b] = await Promise.all([
    treeOidAt(repoDir, from, appPath),
    treeOidAt(repoDir, to, appPath),
  ]);
  return a !== b;
}

/**
 * The deploy stopped because a data binding could not be materialized — a
 * warehouse query that failed or timed out, not a flaky build. Retrying it
 * immediately re-runs the same query against the same warehouse; the caller
 * treats it as final and the hourly reconcile backs off from it.
 */
export class DeployBindingsError extends Error {
  constructor(
    message: string,
    /** The app ref the deploy was asked for (its id, or a legacy slug). */
    readonly slug: string,
    readonly sha: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DeployBindingsError";
  }
}

/**
 * Build one app at `sha` and make it the live deployment. Idempotent: a
 * commit already built (the Publish button got there first) is just made
 * live. Throws on a failed build so Inngest retries and records it; `main`
 * is NOT reverted — it already moved, and rewriting a branch someone pushed
 * to would be worse than serving the previous build.
 */
export async function deployOneApp(
  workspaceId: string,
  appRef: string,
  sha: string,
): Promise<{
  app: string;
  sha: string;
  outcome: "built" | "already-built" | "gone";
}> {
  // Inngest can run on a different instance from the webhook or manual tool
  // that enqueued this sha. Make sure THIS commit is here — a no-op when it
  // is, one coalesced fetch when it is not — rather than an unconditional
  // mirror fetch per app per attempt (a 58-folder push fetched the same sha
  // 58 times, after the webhook had already fetched it once).
  await ensureCommitLocally(workspaceId, sha);
  const discovered = await resolveProjectRef(workspaceId, appRef);
  if (!discovered) return { app: appRef, sha, outcome: "gone" };
  const appPath = appRootFor(discovered);
  // The folder may have been deleted in this very push. A row that survived
  // its folder (auto-deploy created it) must be UNPUBLISHED, not built: the
  // build would fail on a missing cwd, Inngest would retry it, and the
  // hourly reconcile — seeing publishedSha != head and the folder "changed"
  // (deleted) — would re-enqueue the same failure forever.
  const repoDir = await repoForWorkspace(workspaceId);
  if (!(await appFolderExistsAt(repoDir, appPath, sha))) {
    if (discovered.publishedSha) {
      await clearPublishedSha(discovered);
      logger.info("Unpublished app whose folder left main", {
        workspaceId,
        app: appPath,
        sha,
      });
    }
    return { app: appRef, sha, outcome: "gone" };
  }
  // Auto-deploying a repo-imported folder is a publish action, so materialize
  // its derived project row before setPublishedSha. Otherwise updateOne
  // matches nothing and the deploy reports success without staying live.
  const project = await ensureProjectRow(discovered, PUBLISH_ACTOR);

  // Data first, and sandbox-free: binding definitions are read from the bare
  // repo at `sha` and their artifacts are content-addressed, so this gate
  // costs nothing when nothing changed and never needs a box. Running it
  // BEFORE the build means a warehouse failure is reported without booting
  // a sandbox or paying for a vite build that could not go live anyway —
  // and the previous deployment keeps serving while Inngest retries.
  try {
    await ensureDeploymentBindings(project, sha);
  } catch (error) {
    await recordDeployFailure(project, sha, "bindings", error);
    throw new DeployBindingsError(
      error instanceof Error ? error.message : String(error),
      appRef,
      sha,
      { cause: error },
    );
  }
  if (await deploymentExists(project._id.toString(), sha)) {
    // The frontend was already uploaded (the Publish button got there
    // first, or a retry after a binding failure); it is just made live.
    await setPublishedSha(project, sha);
    return { app: appRef, sha, outcome: "already-built" };
  }

  const handle = await ensureWorktree(project, PUBLISH_ACTOR, {
    branch: project.defaultBranch || "main",
  });
  // Build THIS commit. The publish route pins the box the same way, and for
  // the same reason: ensureBox catches a box up with a throttled pull
  // (60s), so a push soon after another one rebuilt the PREVIOUS state and
  // stored it under this sha — the app then served a build nobody made,
  // while the UI reported the new commit as live. Observed on three
  // consecutive pushes to one app, each deployment holding the content of
  // the push before it.
  await checkoutInBox(handle, sha);
  const build = await buildApp(handle, execInWorktree);
  if (!build.ok) {
    await recordDeployFailure(project, sha, "build", build.output);
    throw new Error(build.output);
  }
  await deployBuild(project, sha, handle, { bindingsReady: true });
  logger.info("Deployed app from main", { workspaceId, app: appPath, sha });
  return { app: appRef, sha, outcome: "built" };
}

/**
 * A push to `main` arrived: decide which apps it touched and hand each one to
 * the `apps-deploy` Inngest function. Returns the app ids enqueued. Nothing is
 * built here — the webhook delivery must return quickly, and on Cloud Run
 * work detached from a request does not reliably run to completion.
 */
export async function deployAppsForPush(input: {
  workspaceId: string;
  repoDir: string;
  before?: string;
  after: string;
}): Promise<string[]> {
  const { workspaceId, repoDir, before, after } = input;
  const appIds = await changedApps(workspaceId, repoDir, before);
  if (appIds.length === 0) return [];
  const { requestAppDeploys } = await import(
    "../inngest/functions/apps-deploy"
  );
  await requestAppDeploys(workspaceId, appIds, after, "push");
  logger.info("Apps deploys requested from push", {
    workspaceId,
    sha: after,
    apps: appIds.length,
  });
  return appIds;
}
