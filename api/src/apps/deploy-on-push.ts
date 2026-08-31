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
  ensureWorktree,
  execInWorktree,
  listAppFolders,
  repoForWorkspace,
  synthesizeProjectFromFolder,
} from "./worktree.service";
import {
  buildApp,
  deployBuild,
  deploymentExists,
  setPublishedSha,
} from "./deployment.service";
import { getMakoCloudRepoPrefix } from "../integrations/github/cloud-app-auth";
import { Types } from "mongoose";

const logger = loggers.api("apps-deploy-on-push");

/**
 * Recover the workspace from a pushed repository name.
 *
 * Cloud repos are named `<prefix>-<workspaceId>`, so the id is right there.
 * BYO repos are matched through the workspace's own binding instead.
 */
export function workspaceIdFromCloudRepo(repo: string): string | null {
  const prefix = `${getMakoCloudRepoPrefix()}-`;
  if (!repo.startsWith(prefix)) return null;
  const candidate = repo.slice(prefix.length);
  return Types.ObjectId.isValid(candidate) ? candidate : null;
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
  const project =
    (await AppProject.findOne({
      slug,
      workspaceId: new Types.ObjectId(workspaceId),
    })) ?? (await synthesizeProjectFromFolder(workspaceId, slug));
  // The folder may have been deleted in this very push.
  if (!project) return { slug, sha, outcome: "gone" };

  const handle = await ensureWorktree(project as IAppProject, PUBLISH_ACTOR, {
    branch: project.defaultBranch || "main",
  });
  if (await deploymentExists(project._id.toString(), sha)) {
    await setPublishedSha(project as IAppProject, sha);
    return { slug, sha, outcome: "already-built" };
  }
  const build = await buildApp(handle, execInWorktree);
  if (!build.ok) throw new Error(build.output);
  await deployBuild(project as IAppProject, sha, handle);
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
