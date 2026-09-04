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
 */
import { AppProject, type IAppProject } from "../database/workspace-schema";
import { loggers } from "../logging";
import { runGit } from "./git";
import {
  PUBLISH_ACTOR,
  checkoutInBox,
  ensureProjectRow,
  ensureWorktree,
  execInWorktree,
  listAppFolders,
  repoForWorkspace,
  synthesizeProjectFromFolder,
} from "./worktree.service";
import {
  buildApp,
  buildLogPath,
  deployBuild,
  deploymentExists,
  ensureDeploymentBindings,
  setPublishedSha,
} from "./deployment.service";
import { Types } from "mongoose";
import { freshenForServe } from "./cloud-repo.service";

const logger = loggers.api("apps-deploy-on-push");

/** Put data-readiness failures where app_build_log already tells agents to look. */
async function ensureBindingsForDeploy(
  project: IAppProject,
  sha: string,
  handle: Awaited<ReturnType<typeof ensureWorktree>>,
): Promise<void> {
  try {
    await ensureDeploymentBindings(project, sha);
  } catch (error) {
    const message = `\nBinding readiness failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`;
    const encoded = Buffer.from(message).toString("base64");
    await execInWorktree(
      handle,
      `printf %s ${encoded} | base64 -d >> ${buildLogPath(handle)}`,
      { timeoutMs: 15_000 },
    ).catch(() => undefined);
    throw error;
  }
}

/** App folders touched between two commits. */
async function changedApps(
  workspaceId: string,
  repoDir: string,
  before: string | undefined,
  after: string,
): Promise<string[]> {
  const range =
    before && /^[0-9a-f]{40}$/.test(before) && !/^0+$/.test(before)
      ? `${before}..${after}`
      : // First push, or a force-push we cannot diff against: treat every app
        // as changed rather than silently deploying none.
        null;
  if (!range) {
    return (await listAppFolders(workspaceId)).map(f => f.slug);
  }
  const { stdout } = await runGit(
    ["-C", repoDir, "diff", "--name-only", range],
    { timeoutMs: 60_000 },
  );
  const slugs = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = /^apps\/([^/]+)\//.exec(line.trim());
    if (match) slugs.add(match[1]);
  }
  return [...slugs];
}

/**
 * Handle a push to a workspace repo's default branch.
 *
 * Returns the apps it deployed. Safe to call for pushes that touch no app —
 * it simply does nothing.
 */
/**
 * Did `apps/<slug>/` change between two commits? The one question both the
 * webhook and the hourly reconcile ask.
 */
export async function appFolderChanged(
  workspaceId: string,
  slug: string,
  from: string,
  to: string,
): Promise<boolean> {
  const repoDir = await repoForWorkspace(workspaceId);
  const { stdout } = await runGit(
    [
      "-C",
      repoDir,
      "diff",
      "--name-only",
      `${from}..${to}`,
      "--",
      `apps/${slug}/`,
    ],
    { timeoutMs: 60_000 },
  );
  return stdout.trim().length > 0;
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
  slug: string,
  sha: string,
): Promise<{
  slug: string;
  sha: string;
  outcome: "built" | "already-built" | "gone";
}> {
  // Inngest can run on a different instance from the webhook or manual tool
  // that enqueued this sha. Fetch here as well: the durable worker must not
  // depend on the request-serving instance's local mirror being warm.
  await freshenForServe(workspaceId, 0);
  const discovered =
    (await AppProject.findOne({
      slug,
      workspaceId: new Types.ObjectId(workspaceId),
    })) ?? (await synthesizeProjectFromFolder(workspaceId, slug));
  // The folder may have been deleted in this very push.
  if (!discovered) return { slug, sha, outcome: "gone" };
  // Auto-deploying a repo-imported folder is a publish action, so materialize
  // its derived project row before setPublishedSha. Otherwise updateOne
  // matches nothing and the deploy reports success without staying live.
  const project = await ensureProjectRow(discovered, PUBLISH_ACTOR);

  const handle = await ensureWorktree(project as IAppProject, PUBLISH_ACTOR, {
    branch: project.defaultBranch || "main",
  });
  if (await deploymentExists(project._id.toString(), sha)) {
    // A code artifact alone is not a deployable app: bindings may have been
    // absent when this immutable frontend was uploaded, or their definitions
    // may resolve to artifacts that have not been built yet. Do the same data
    // gate on reuse as on a fresh build before moving the live pointer.
    await ensureBindingsForDeploy(project as IAppProject, sha, handle);
    await setPublishedSha(project as IAppProject, sha);
    return { slug, sha, outcome: "already-built" };
  }
  // Build THIS commit. The publish route pins the box the same way, and for
  // the same reason: ensureBox catches a box up with a throttled pull
  // (60s), so a push soon after another one rebuilt the PREVIOUS state and
  // stored it under this sha — the app then served a build nobody made,
  // while the UI reported the new commit as live. Observed on three
  // consecutive pushes to one app, each deployment holding the content of
  // the push before it.
  await checkoutInBox(handle, sha);
  const build = await buildApp(handle, execInWorktree);
  if (!build.ok) throw new Error(build.output);
  // Keep publishing atomic from a viewer's perspective: only upload/repoint
  // after every parquet binding required by this exact commit can be served.
  // A warehouse failure leaves the previous deployment live and lets the
  // Inngest job retry with a precise binding error.
  await ensureBindingsForDeploy(project as IAppProject, sha, handle);
  await deployBuild(project as IAppProject, sha, handle, {
    bindingsReady: true,
  });
  logger.info("Deployed app from main", { workspaceId, slug, sha });
  return { slug, sha, outcome: "built" };
}

/**
 * A push to `main` arrived: decide which apps it touched and hand each one to
 * the `apps-deploy` Inngest function. Returns the slugs enqueued. Nothing is
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
  const slugs = await changedApps(workspaceId, repoDir, before, after);
  if (slugs.length === 0) return [];
  const { requestAppDeploys } = await import(
    "../inngest/functions/apps-deploy"
  );
  await requestAppDeploys(workspaceId, slugs, after, "push");
  logger.info("Apps deploys requested from push", {
    workspaceId,
    sha: after,
    apps: slugs.length,
  });
  return slugs;
}
