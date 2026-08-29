/**
 * Deploy on push to `main` (apps-v2.md §13).
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
import { AppProjectV2, type IAppProjectV2 } from "../database/workspace-schema";
import { loggers } from "../logging";
import { runGit } from "./git";
import {
  PUBLISH_ACTOR,
  ensureWorktree,
  execInWorktree,
  listAppFolders,
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

const logger = loggers.api("apps-v2-deploy-on-push");

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
export async function deployAppsForPush(input: {
  workspaceId: string;
  repoDir: string;
  before?: string;
  after: string;
}): Promise<string[]> {
  const { workspaceId, repoDir, before, after } = input;
  const slugs = await changedApps(workspaceId, repoDir, before, after);
  if (slugs.length === 0) return [];

  const deployed: string[] = [];
  for (const slug of slugs) {
    try {
      const project =
        (await AppProjectV2.findOne({
          slug,
          workspaceId: new Types.ObjectId(workspaceId),
        })) ?? (await synthesizeProjectFromFolder(workspaceId, slug));
      // The folder may have been deleted in this very push.
      if (!project) continue;

      const handle = await ensureWorktree(
        project as IAppProjectV2,
        PUBLISH_ACTOR,
        { branch: project.defaultBranch || "main" },
      );

      // Already built this commit (the Publish button gets here first when it
      // is the one that moved main) — just make sure it is the live one.
      if (await deploymentExists(project._id.toString(), after)) {
        await setPublishedSha(project as IAppProjectV2, after);
        deployed.push(slug);
        continue;
      }

      const build = await buildApp(handle, execInWorktree);
      if (!build.ok) {
        // main is NOT reverted: it already moved, and rewriting a branch
        // someone pushed to would be worse than serving the previous build.
        throw new Error(build.output);
      }
      await deployBuild(project as IAppProjectV2, after, handle);
      deployed.push(slug);
      logger.info("Deployed app from push to main", {
        workspaceId,
        slug,
        sha: after,
      });
    } catch (error) {
      // One app failing must not stop the others: a push can touch several,
      // and a broken one should not hold back the rest.
      logger.error("Deploy from push failed", {
        workspaceId,
        slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return deployed;
}
