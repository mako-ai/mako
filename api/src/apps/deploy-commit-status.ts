/**
 * Make an app deploy's outcome visible where the push happened: a GitHub
 * commit status on the deployed sha, one context per app.
 *
 * A deploy from `main` that failed used to be silent. The app kept serving
 * its previous build and the only trace was `lastDeployError` on the row —
 * which nobody opens after a merge. The commit on GitHub is what the person
 * who merged is looking at, so that is where the red cross belongs.
 *
 * Best effort by construction: a missing permission ("Commit statuses:
 * write" not granted to the GitHub App), a network blip or an unbound repo is
 * logged and swallowed. Reporting must never fail, retry or slow a deploy.
 */
import { postCommitStatus } from "../integrations/github/github-api";
import { resolveRepoToken } from "../integrations/github/app-auth";
import { publishRealtimeEvent } from "../services/realtime.service";
import { loggers } from "../logging";
import { AppProject } from "../database/workspace-schema";
import { resolveMirrorTarget } from "./cloud-repo.service";
import { appRootFor, resolveProjectRef } from "./worktree.service";

const logger = loggers.api("apps-deploy-status");

export type AppDeployStatusState = "pending" | "success" | "failure";

/** GitHub caps a status description at 140 characters. */
const DESCRIPTION_MAX_CHARS = 140;

/** One status line per app, so a push touching three apps shows three. */
export function appDeployStatusContext(appPath: string): string {
  return `mako/app-deploy: ${appPath}`;
}

function clip(text: string, max = DESCRIPTION_MAX_CHARS): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * "bindings failed: Name call_source not found inside calls …": the stage
 * first, because it says where to look (a dbt model, the vite build), then
 * the line of the error that names the problem. A build failure is stored
 * as the TAIL of the build log, so its first line is noise: the first line
 * that says "error" or "failed" is the one worth 140 characters.
 */
export function describeDeployFailure(
  stage: string | undefined,
  message: string,
): string {
  const lines = message
    .split("\n")
    .map(line => line.replace(/^…/, "").trim())
    .filter(line => line.length > 0);
  let index = lines.findIndex(line => /error|failed|not found/i.test(line));
  if (index < 0) index = 0;
  let headline = lines[index] ?? "unknown error";
  // "error during build:" says nothing on its own; the next line is the cause.
  if (headline.endsWith(":") && lines[index + 1]) {
    headline = `${headline} ${lines[index + 1]}`;
  }
  return clip(stage ? `${stage} failed: ${headline}` : headline);
}

export type AppDeployOutcome =
  | "built"
  | "already-built"
  | "gone"
  | "superseded";

export function describeDeployOutcome(outcome: AppDeployOutcome): {
  state: AppDeployStatusState;
  description: string;
} {
  switch (outcome) {
    case "built":
    case "already-built":
      return { state: "success", description: "Live: this commit is deployed" };
    case "gone":
      return {
        state: "success",
        description: "App folder not on main at this commit: nothing to deploy",
      };
    case "superseded":
      return {
        state: "success",
        description: "Skipped: a newer commit of this app is deployed instead",
      };
  }
}

/** Where the status links to: the app in Mako, whose chip shows the error. */
export function appDeployTargetUrl(appId: string): string | undefined {
  const base = (process.env.CLIENT_URL || process.env.PUBLIC_URL || "").replace(
    /\/+$/,
    "",
  );
  return base ? `${base}/apps/${encodeURIComponent(appId)}` : undefined;
}

// Workspaces already warned about a permission problem, so one whose GitHub
// App lacks "Commit statuses: write" logs it once per process, not three
// times per deploy.
const warnedWorkspaces = new Set<string>();

function isPermissionError(message: string): boolean {
  return (
    /GitHub 40[34]\b/.test(message) ||
    /Resource not accessible by integration/i.test(message)
  );
}

export interface ReportAppDeployStatusInput {
  workspaceId: string;
  /** The app's id (or the legacy slug an older event carried). */
  appRef: string;
  sha: string;
  state: AppDeployStatusState;
  description: string;
}

/**
 * Post the deploy status for one app on one commit, and poke open windows
 * so the app's published chip refetches. Never throws.
 */
export async function reportAppDeployStatus(
  input: ReportAppDeployStatusInput,
): Promise<{ posted: boolean; reason?: string }> {
  const { workspaceId, appRef, sha, state } = input;
  let appId = appRef;
  try {
    const project = await resolveProjectRef(workspaceId, appRef);
    if (!project) return { posted: false, reason: "app-not-found" };
    appId = project._id.toString();
    if (state !== "pending") {
      publishRealtimeEvent(workspaceId, {
        type: "app.updated",
        appId,
        origin: "deploy",
      });
    }
    // Same gate as every other write to the customer repo: production (or
    // the explicit opt-in). A preview or a laptop never marks real commits.
    const target = await resolveMirrorTarget(workspaceId);
    if (!target) return { posted: false, reason: "no-connected-repo" };
    const token = await resolveRepoToken(target.installationId);
    if (!token) return { posted: false, reason: "no-token" };
    const post = (commit: string, state: AppDeployStatusState, text: string) =>
      postCommitStatus(
        target.owner,
        target.repo,
        commit,
        {
          state,
          description: clip(text),
          context: appDeployStatusContext(appRootFor(project)),
          targetUrl: appDeployTargetUrl(appId),
        },
        token,
      );
    const filter = { _id: project._id, workspaceId: project.workspaceId };

    if (state === "pending") {
      // A newer push cancels the running deploy (singleton "cancel"), and a
      // cancelled run never reports: resolve its commit here.
      const previous = project.deployStatusPendingSha;
      if (previous && previous !== sha) {
        await post(
          previous,
          "success",
          `Skipped: superseded by ${sha.slice(0, 7)}`,
        ).catch(error =>
          logger.info("Could not resolve a superseded deploy status", {
            workspaceId,
            appId,
            sha: previous,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      await post(sha, state, input.description);
      await AppProject.updateOne(filter, {
        $set: { deployStatusPendingSha: sha },
      });
      return { posted: true };
    }

    await post(sha, state, input.description);
    await AppProject.updateOne(
      { ...filter, deployStatusPendingSha: sha },
      { $unset: { deployStatusPendingSha: 1 } },
    );
    return { posted: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const permission = isPermissionError(message);
    if (!permission || !warnedWorkspaces.has(workspaceId)) {
      if (permission) warnedWorkspaces.add(workspaceId);
      logger.warn("Could not post app deploy commit status", {
        workspaceId,
        appId,
        sha,
        state,
        error: message,
        ...(permission
          ? {
              hint: 'Grant the GitHub App "Commit statuses: Read and write" and accept it on the installation',
            }
          : {}),
      });
    }
    return { posted: false, reason: permission ? "permission" : "error" };
  }
}

/** Test seam: forget which workspaces were already warned about. */
export function resetDeployStatusWarningsForTest(): void {
  warnedWorkspaces.clear();
}
