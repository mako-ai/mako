/**
 * The published pointer (`publishedSha`) and the deploy error beside it.
 */
import { commitIsAncestor, isOid } from "../git";
import { repoDirFor } from "../repository.service";
import { type IAppProject } from "../../database/workspace-schema";
import { appsMetadataRepo } from "../../repositories/apps-metadata";
import { clearDeployProgress } from "../deploy-progress";
import { loggers } from "../../logging";
import { existingDeploymentAsset } from "./store";
import { queueBindingRefreshes } from "./bindings";

const logger = loggers.api("apps-deployment");

/**
 * Clear a recorded failure this repoint answers: one of this commit or of an
 * ancestor. A failure of a newer commit stays, whoever landed in between, and
 * so does one git cannot place. Best effort: the repoint already happened.
 */
async function clearAnsweredDeployError(
  project: IAppProject,
  sha: string,
): Promise<void> {
  const workspaceId = project.workspaceId?.toString() ?? "";
  const projectId = project._id.toString();
  try {
    const row = await appsMetadataRepo.findProjectById(
      projectId,
      workspaceId || undefined,
    );
    const failedSha = row?.lastDeployError?.sha;
    if (!failedSha) return;
    const answered =
      failedSha === sha ||
      (Boolean(workspaceId) &&
        isOid(failedSha) &&
        isOid(sha) &&
        (await commitIsAncestor(repoDirFor(workspaceId), failedSha, sha)));
    if (!answered) return;
    await appsMetadataRepo.clearLastDeployErrorIfSha(
      workspaceId,
      projectId,
      failedSha,
    );
  } catch (error) {
    logger.warn("Could not clear a recorded deploy failure", {
      projectId,
      sha,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Point the app at a deployment. Also how rollback works.
 *
 * `expected` makes the repoint conditional on the live pointer still being
 * that value: the check and the write are one update, so a deploy that was
 * overtaken while it worked loses instead of moving the app back. Returns
 * whether the pointer moved. `refreshing` names the stale artifacts this
 * release goes live on: their rebuilds are queued once it is live, because
 * the refresh skips a commit that is not live.
 */
export async function setPublishedSha(
  project: IAppProject,
  sha: string,
  options: { expected?: string | null; refreshing?: string[] } = {},
): Promise<boolean> {
  const workspaceId = project.workspaceId?.toString() ?? "";
  const projectId = project._id.toString();
  const result = await appsMetadataRepo.setPublishedSha(
    workspaceId,
    projectId,
    sha,
    new Date(),
    options.expected,
  );
  if (options.expected !== undefined && !result.matched) {
    logger.info("Apps deployment overtaken: the live pointer moved", {
      projectId,
      sha,
      expected: options.expected,
    });
    await clearDeployProgress(project, sha);
    return false;
  }
  await clearAnsweredDeployError(project, sha);
  await clearDeployProgress(project, sha);
  await queueBindingRefreshes(project, sha, options.refreshing ?? []);
  return true;
}

/**
 * Unpublish: the folder is gone from `main`, so nothing should serve. The
 * row stays (env vars, sharing, history); only the live pointer clears, and
 * with it the hourly reconcile's reason to keep re-enqueuing the app.
 */
export async function clearPublishedSha(project: IAppProject): Promise<void> {
  await appsMetadataRepo.clearPublishedSha(
    project.workspaceId?.toString() ?? "",
    project._id.toString(),
  );
}

const DEPLOY_ERROR_MAX_CHARS = 8_000;

/** A pointer moved this recently probably overtook a deploy git cannot place. */
const RECENT_REPOINT_MS = 60 * 60 * 1000;

/**
 * Should this deploy's failure go on the row? No when the deploy was
 * overtaken: a run that kept going after cancellation must not report a
 * failure against an app already live on something newer.
 */
async function deployFailureStillApplies(
  project: IAppProject,
  sha: string,
): Promise<boolean> {
  const workspaceId = project.workspaceId?.toString() ?? "";
  const projectId = project._id.toString();
  try {
    const row = await appsMetadataRepo.findProjectById(
      projectId,
      workspaceId || undefined,
    );
    if (!row?.publishedSha) return true;
    if (row.publishedSha === sha) return false;
    if (row.deployProgress?.sha === sha) return true;
    try {
      if (!workspaceId) return true;
      return !(await commitIsAncestor(
        repoDirFor(workspaceId),
        sha,
        row.publishedSha,
      ));
    } catch {
      const publishedAt = row.publishedAt
        ? new Date(row.publishedAt).getTime()
        : 0;
      return Date.now() - publishedAt > RECENT_REPOINT_MS;
    }
  } catch {
    return true;
  }
}

/**
 * Remember why a deploy did not go live, on the row every status reader
 * already loads. Replaces shelling into the publish sandbox to append a
 * log line — which booted a box on the repoint path that needs none, and
 * wrote to a file the next build truncates anyway.
 */
export async function recordDeployFailure(
  project: IAppProject,
  sha: string,
  stage: "bindings" | "build" | "publish",
  error: unknown,
): Promise<void> {
  const full = error instanceof Error ? error.message : String(error);
  const message =
    full.length > DEPLOY_ERROR_MAX_CHARS
      ? `…${full.slice(-DEPLOY_ERROR_MAX_CHARS)}`
      : full;
  if (await deployFailureStillApplies(project, sha)) {
    await appsMetadataRepo
      .setLastDeployError(
        project.workspaceId?.toString() ?? "",
        project._id.toString(),
        {
          sha,
          stage,
          message,
          at: new Date(),
        },
      )
      .catch(err => {
        logger.warn("Could not record apps deploy failure", {
          projectId: project._id.toString(),
          sha,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
  // The deploy is over; lastDeployError now says why.
  await clearDeployProgress(project, sha);
}

/** Whether a given sha's deployment still exists in the store. */
export async function deploymentExists(
  projectId: string,
  sha: string,
): Promise<boolean> {
  return (await existingDeploymentAsset(projectId, sha, "index.html")) !== null;
}
