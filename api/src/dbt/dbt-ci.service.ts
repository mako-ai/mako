/**
 * GitHub-driven dbt automation: continuous sync on push and Slim CI on pull
 * requests. Mirrors dbt Cloud's repo caching + CI jobs.
 *
 * Mako's branch-tracking model makes CI natural: a project tracks one branch
 * (the dev's working branch in the IDE). On a PR *from that branch*, we pull
 * the head into the working tree and run `build --select state:modified+`
 * deferring to the stored prod manifest, then post a GitHub commit status.
 */
import {
  DbtProject,
  type IDbtProject,
  type IDbtRun,
} from "../database/workspace-schema";
import { resolveRepoToken } from "../integrations/github/app-auth";
import {
  getPullRequestFiles,
  postCommitStatus,
} from "../integrations/github/github-api";
import { loggers } from "../logging";
import { syncProjectFromRepo } from "./dbt-github-sync.service";
import { triggerDbtRun } from "./dbt-run.service";

const logger = loggers.api("dbt-ci");

const CI_STATUS_CONTEXT = "mako/ci";

/**
 * Find repo-bound projects matching an (owner, repo), optionally a branch.
 *
 * SECURITY: when the delivering installation id is known (webhook payloads
 * carry it), we scope to projects bound to that SAME installation. An org has a
 * single App installation, so this still matches every workspace that
 * legitimately connected the repo, while refusing to drive a project that was
 * bound to a *different* installation — so a stray/foreign binding can't be
 * actioned by an unrelated installation's webhook.
 */
async function findProjectsForRepo(
  owner: string,
  repo: string,
  branch?: string,
  installationId?: number,
): Promise<IDbtProject[]> {
  const query: Record<string, unknown> = {
    "repo.owner": owner,
    "repo.repo": repo,
  };
  if (branch) query["repo.branch"] = branch;
  if (installationId) query["repo.installationId"] = installationId;
  return DbtProject.find(query);
}

/**
 * push event → pull the latest branch state into Mongo for every project that
 * tracks that branch (continuous sync, like dbt Cloud's managed repo cache).
 */
export async function handlePushEvent(params: {
  owner: string;
  repo: string;
  branch: string;
  installationId?: number;
}): Promise<{ synced: number }> {
  const projects = await findProjectsForRepo(
    params.owner,
    params.repo,
    params.branch,
    params.installationId,
  );
  let synced = 0;
  for (const project of projects) {
    try {
      await syncProjectFromRepo(project, "github-webhook");
      synced++;
    } catch (error) {
      logger.warn("push auto-sync failed", {
        projectId: project._id.toString(),
        error: String(error),
      });
    }
  }
  if (synced > 0) {
    logger.info("push auto-synced dbt projects", {
      owner: params.owner,
      repo: params.repo,
      branch: params.branch,
      synced,
    });
  }
  return { synced };
}

/** Map changed repo paths to dbt model selectors (basename without .sql). */
export function changedModelSelectors(
  files: string[],
  subdirectory?: string,
): string[] {
  const prefix = subdirectory
    ? `${subdirectory.replace(/^\/+|\/+$/g, "")}/`
    : "";
  const names = new Set<string>();
  for (const file of files) {
    const rel =
      prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file;
    if (!rel.startsWith("models/") || !rel.endsWith(".sql")) continue;
    const base = rel.split("/").pop() ?? "";
    const name = base.replace(/\.sql$/, "");
    if (name) names.add(name);
  }
  // Downstream closure of each changed model (dbt Cloud Slim CI shape).
  return [...names].map(name => `${name}+`);
}

interface PullRequestInfo {
  action: string;
  number: number;
  headRef: string;
  baseRef: string;
  headSha: string;
  owner: string;
  repo: string;
  installationId?: number;
}

const CI_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

/**
 * pull_request event → for each project tracking the PR's head branch, sync it
 * to the head, choose a Slim-CI selection, trigger a CI run, and post a
 * `pending` commit status. Completion status is posted by the executor.
 */
export async function handlePullRequestEvent(
  pr: PullRequestInfo,
): Promise<{ triggered: number }> {
  if (!CI_ACTIONS.has(pr.action)) return { triggered: 0 };

  const projects = await findProjectsForRepo(
    pr.owner,
    pr.repo,
    pr.headRef,
    pr.installationId,
  );
  let triggered = 0;

  for (const project of projects) {
    // CI is opt-in per project (a dbt Cloud "CI job"). Connecting a repo never
    // silently runs warehouse jobs.
    if (!project.ci?.enabled) continue;
    try {
      // Pull the head into the working tree so the run reflects the PR.
      await syncProjectFromRepo(project, "github-webhook");

      // Slim CI selection: state:modified+ when a prod manifest exists,
      // otherwise the downstream closure of the PR's changed models.
      let select: string[];
      if (project.lastProdManifestKey) {
        select = ["state:modified+"];
      } else {
        const token = await resolveRepoToken(project.repo?.installationId);
        const files = await getPullRequestFiles(
          pr.owner,
          pr.repo,
          pr.number,
          token,
        );
        select = changedModelSelectors(files, project.repo?.subdirectory);
      }

      if (select.length === 0) {
        // Nothing dbt-relevant changed — report success without a run.
        await postCiStatus(project, pr, {
          state: "success",
          description: "No dbt changes to test",
        });
        continue;
      }

      const environment =
        (project.ci?.environment &&
          project.environments.find(e => e.name === project.ci?.environment)
            ?.name) ??
        project.environments.find(e => e.name === "ci")?.name ??
        project.defaultEnvironment;

      const run = await triggerDbtRun({
        workspaceId: project.workspaceId.toString(),
        projectId: project._id.toString(),
        environment,
        commands: [`build --select ${select.join(" ")}`],
        trigger: "ci",
        triggeredBy: "ci-webhook",
        ci: {
          prNumber: pr.number,
          headSha: pr.headSha,
          headRef: pr.headRef,
          baseRef: pr.baseRef,
          owner: pr.owner,
          repo: pr.repo,
          installationId: project.repo?.installationId,
        },
      });

      await postCiStatus(project, pr, {
        state: "pending",
        description: "dbt build running…",
        runId: run._id.toString(),
      });
      triggered++;
    } catch (error) {
      logger.warn("CI trigger failed", {
        projectId: project._id.toString(),
        prNumber: pr.number,
        error: String(error),
      });
      await postCiStatus(project, pr, {
        state: "error",
        description: "Mako CI failed to start",
      }).catch(() => {});
    }
  }

  return { triggered };
}

function clientUrl(): string {
  return process.env.CLIENT_URL || "http://localhost:5173";
}

async function postCiStatus(
  project: IDbtProject,
  pr: Pick<PullRequestInfo, "owner" | "repo" | "headSha" | "installationId">,
  params: {
    state: "pending" | "success" | "failure" | "error";
    description: string;
    runId?: string;
  },
): Promise<void> {
  const token = await resolveRepoToken(
    project.repo?.installationId ?? pr.installationId,
  );
  await postCommitStatus(
    pr.owner,
    pr.repo,
    pr.headSha,
    {
      state: params.state,
      description: params.description,
      context: CI_STATUS_CONTEXT,
      targetUrl: params.runId
        ? `${clientUrl()}/?transform=run&runId=${params.runId}`
        : `${clientUrl()}/`,
    },
    token,
  );
}

/**
 * Post the terminal commit status for a finished CI run. Called by the
 * executor's finalize step (where success/failure is known).
 */
export async function postCiRunResult(
  run: Pick<IDbtRun, "_id" | "ci">,
  success: boolean,
): Promise<void> {
  if (!run.ci) return;
  try {
    const token = await resolveRepoToken(run.ci.installationId);
    await postCommitStatus(
      run.ci.owner,
      run.ci.repo,
      run.ci.headSha,
      {
        state: success ? "success" : "failure",
        description: success ? "dbt build passed" : "dbt build failed",
        context: CI_STATUS_CONTEXT,
        targetUrl: `${clientUrl()}/?transform=run&runId=${run._id.toString()}`,
      },
      token,
    );
  } catch (error) {
    logger.warn("Failed to post CI commit status", {
      runId: run._id.toString(),
      error: String(error),
    });
  }
}
