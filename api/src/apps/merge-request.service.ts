/**
 * Merge requests for guarded callers (default-branch-guard.ts).
 *
 * A guarded MCP or API-key caller never writes to the default branch. Its
 * `*_merge_to_main` tool lands here instead:
 *
 *   1. read what the branch changes against the default branch;
 *   2. run the workspace's CI-equivalent check for each kind of change
 *      (dbt parse for `dbt/`, check_flow_files for `flows/`, an app build for
 *      `apps/<slug>/`);
 *   3. a failing check stops here, a check still running reports `pending`;
 *   4. a workspace mirrored to GitHub gets a pull request: the branch is
 *      pushed and a PR opened (or the open one returned), and the merge
 *      stays a person's click on GitHub. A workspace with no GitHub mirror
 *      has no reviewer to hand the change to, so it merges directly through
 *      the same `mergeBranchToMain` the editor uses.
 *
 * The checks are injectable so each family's behaviour tests without a
 * warehouse, a sandbox or GitHub.
 */
import { Types } from "mongoose";
import { loggers } from "../logging";
import { DbtProject, DbtRun } from "../database/workspace-schema";
import {
  createPullRequest,
  listPullRequests,
} from "../integrations/github/github-api";
import { runGit } from "./git";
import {
  resolveMirrorTarget,
  mirrorPushNow,
  type MirrorTarget,
} from "./cloud-repo.service";
import { tokenFor } from "./cloud-repo/target";
import { DEFAULT_BRANCH, readBlob, resolveCommit } from "./repository.service";
import {
  mergeBranchToMain,
  repoForWorkspace,
  type MergeResult,
} from "./worktree.service";

const logger = loggers.api("merge-request");

/** What a check says about one kind of change. */
export interface MergeCheckResult {
  /** `dbt parse`, `check_flow_files` or `app build`. */
  name: string;
  status: "passed" | "failed" | "pending";
  /** Problems on a failure, the run id on pending. */
  detail?: string;
  runId?: string;
}

export interface ChangedPath {
  path: string;
  status: "added" | "modified" | "deleted";
}

export interface MergeCheckContext {
  workspaceId: string;
  userId?: string;
  branch: string;
  changed: ChangedPath[];
}

/** One runner per kind of change; each is given only what it concerns. */
export interface MergeCheckRunners {
  dbtParse(ctx: MergeCheckContext): Promise<MergeCheckResult>;
  flowFiles(
    ctx: MergeCheckContext & {
      files: Array<{ path: string; contents: string }>;
      deletedPaths: string[];
    },
  ): Promise<MergeCheckResult>;
  appBuild(
    ctx: MergeCheckContext & { appRoot: string },
  ): Promise<MergeCheckResult>;
}

export interface MergeRequestDeps {
  checks: MergeCheckRunners;
  mirror: (workspaceId: string) => Promise<MirrorTarget | null>;
  openPullRequest: (input: {
    workspaceId: string;
    target: MirrorTarget;
    branch: string;
    title: string;
    body: string;
  }) => Promise<{ number: number; url: string; existing: boolean }>;
  merge: (input: {
    workspaceId: string;
    branch: string;
    userId?: string;
  }) => Promise<MergeResult>;
}

export type MergeRequestOutcome =
  | { status: "nothing_to_merge"; branch: string }
  | {
      status: "checks_failed" | "checks_pending";
      branch: string;
      checks: MergeCheckResult[];
      message: string;
    }
  | {
      status: "pull_request";
      branch: string;
      checks: MergeCheckResult[];
      pullRequest: { number: number; url: string; existing: boolean };
      message: string;
    }
  | {
      status: "merged" | "merge_refused";
      branch: string;
      checks: MergeCheckResult[];
      merge: MergeResult;
      message: string;
    };

const APP_ROOT = /^((?:users\/[^/]+\/)?apps\/[^/]+)\//;

/** What `branch` changes against the default branch (three dots: since it left). */
export async function changedPathsOnBranch(
  repoDir: string,
  branch: string,
): Promise<ChangedPath[]> {
  const { stdout } = await runGit([
    "-C",
    repoDir,
    "diff",
    "--name-status",
    "--no-renames",
    `refs/heads/${DEFAULT_BRANCH}...refs/heads/${branch}`,
  ]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map(line => {
      const [code, ...rest] = line.split("\t");
      return {
        path: rest.join("\t"),
        status:
          code === "A"
            ? ("added" as const)
            : code === "D"
              ? ("deleted" as const)
              : ("modified" as const),
      };
    });
}

/** The checks a set of changed paths calls for, as runner invocations. */
async function runChecks(
  repoDir: string,
  base: MergeCheckContext,
  runners: MergeCheckRunners,
): Promise<MergeCheckResult[]> {
  const { changed, branch } = base;
  const results: MergeCheckResult[] = [];

  if (changed.some(c => c.path.startsWith("dbt/"))) {
    results.push(await runners.dbtParse(base));
  }

  const flowChanges = changed.filter(c => /^flows\/[^/]+\.ya?ml$/.test(c.path));
  if (flowChanges.length > 0) {
    const files: Array<{ path: string; contents: string }> = [];
    for (const change of flowChanges.filter(c => c.status !== "deleted")) {
      const blob = await readBlob(repoDir, `refs/heads/${branch}`, change.path);
      files.push({ path: change.path, contents: blob.contents });
    }
    results.push(
      await runners.flowFiles({
        ...base,
        files,
        deletedPaths: flowChanges
          .filter(c => c.status === "deleted")
          .map(c => c.path),
      }),
    );
  }

  const appRoots = new Set<string>();
  for (const change of changed) {
    const match = APP_ROOT.exec(change.path);
    if (match) appRoots.add(match[1]);
  }
  for (const appRoot of appRoots) {
    results.push(await runners.appBuild({ ...base, appRoot }));
  }
  return results;
}

/**
 * Open a merge request for `branch`. Never moves the default branch when the
 * workspace has a GitHub mirror; moves it only after every check passed when
 * it has none.
 */
export async function openMergeRequest(
  input: {
    workspaceId: string;
    branch: string;
    userId?: string;
    title?: string;
    body?: string;
  },
  deps: MergeRequestDeps = defaultMergeRequestDeps,
): Promise<MergeRequestOutcome> {
  const { workspaceId, branch, userId } = input;
  const repoDir = await repoForWorkspace(workspaceId);
  const head = await resolveCommit(repoDir, `refs/heads/${branch}`);
  if (!head) return { status: "nothing_to_merge", branch };
  const changed = await changedPathsOnBranch(repoDir, branch);
  if (changed.length === 0) return { status: "nothing_to_merge", branch };

  const checks = await runChecks(
    repoDir,
    { workspaceId, userId, branch, changed },
    deps.checks,
  );
  const failed = checks.filter(c => c.status === "failed");
  if (failed.length > 0) {
    return {
      status: "checks_failed",
      branch,
      checks,
      message:
        `Not merged: ${failed.map(c => c.name).join(", ")} failed on ${branch}. ` +
        "Fix the files on the same branch and call this tool again.",
    };
  }
  const pending = checks.filter(c => c.status === "pending");
  if (pending.length > 0) {
    return {
      status: "checks_pending",
      branch,
      checks,
      message:
        `${pending.map(c => c.name).join(", ")} still running on ${branch}. ` +
        "Call this tool again in a minute; nothing is merged until it passed.",
    };
  }

  const target = await deps.mirror(workspaceId);
  if (target) {
    const title =
      input.title ??
      `${branch}: ${changed.length} file${changed.length === 1 ? "" : "s"} from MCP`;
    const body =
      input.body ??
      [
        `Opened from a Mako MCP merge request for \`${branch}\`.`,
        "",
        `Changed files (${changed.length}):`,
        ...changed.slice(0, 50).map(c => `- ${c.status}: \`${c.path}\``),
        ...(changed.length > 50 ? [`- and ${changed.length - 50} more`] : []),
        "",
        `Checks passed in Mako: ${checks.map(c => c.name).join(", ") || "none needed"}.`,
      ].join("\n");
    const pullRequest = await deps.openPullRequest({
      workspaceId,
      target,
      branch,
      title,
      body,
    });
    return {
      status: "pull_request",
      branch,
      checks,
      pullRequest,
      message: `${pullRequest.existing ? "Pull request already open" : "Pull request opened"}: ${pullRequest.url}. A person merges it on GitHub.`,
    };
  }

  const merge = await deps.merge({ workspaceId, branch, userId });
  return {
    status: merge.merged ? "merged" : "merge_refused",
    branch,
    checks,
    merge,
    message: merge.merged
      ? `Merged ${branch} into ${DEFAULT_BRANCH}: no GitHub repo is connected, so there is no pull request to open.`
      : `Not merged: ${merge.reason ?? "unknown reason"}.`,
  };
}

// ---------------------------------------------------------------------------
// Default dependencies
// ---------------------------------------------------------------------------

/** How long one tool call waits on a dbt parse (an MCP call is cut at 60 s). */
export const DBT_PARSE_WAIT_MS = 40_000;
const DBT_PARSE_POLL_MS = 1_500;

const dbtParseCheck: MergeCheckRunners["dbtParse"] = async ctx => {
  const name = "dbt parse";
  const projects = await DbtProject.find({
    workspaceId: new Types.ObjectId(ctx.workspaceId),
  }).lean();
  if (projects.length === 0) {
    return { name, status: "passed", detail: "no dbt project to parse" };
  }
  // Imported late: the run service pulls in the whole dbt runner.
  const { triggerDbtRun } = await import("../dbt/dbt-run.service");
  const repoDir = await repoForWorkspace(ctx.workspaceId);
  const sha = await resolveCommit(repoDir, `refs/heads/${ctx.branch}`);
  const runs: Array<{ id: string; project: string }> = [];
  for (const project of projects) {
    // A run of this exact tip that already finished is the answer; the
    // caller's second call after a `pending` finds it instead of queueing
    // another.
    const prior = sha
      ? await DbtRun.findOne({
          projectId: project._id,
          gitBranch: ctx.branch,
          sourceSha: sha,
          commands: ["parse"],
        }).sort({ createdAt: -1 })
      : null;
    const run =
      prior && prior.status !== "cancelled"
        ? prior
        : await triggerDbtRun({
            workspaceId: ctx.workspaceId,
            projectId: project._id.toString(),
            environment: project.defaultEnvironment,
            commands: ["parse"],
            trigger: "ci",
            triggeredBy: `merge-request:${ctx.userId ?? "api-key"}`,
            gitBranch: ctx.branch,
          });
    runs.push({ id: run._id.toString(), project: project.name });
  }

  const deadline = Date.now() + DBT_PARSE_WAIT_MS;
  for (;;) {
    const rows = await DbtRun.find({
      _id: { $in: runs.map(r => new Types.ObjectId(r.id)) },
    }).lean();
    const failedRun = rows.find(r => r.status === "error");
    if (failedRun) {
      const label = runs.find(r => r.id === failedRun._id.toString())?.project;
      return {
        name,
        status: "failed",
        runId: failedRun._id.toString(),
        detail: `dbt parse failed on project ${label}; read it with dbt_get_run (runId ${failedRun._id}).`,
      };
    }
    if (rows.every(r => r.status === "success")) {
      return { name, status: "passed" };
    }
    if (Date.now() >= deadline) {
      return { name, status: "pending", runId: runs[0]?.id };
    }
    await new Promise(resolve => setTimeout(resolve, DBT_PARSE_POLL_MS));
  }
};

const flowFilesCheck: MergeCheckRunners["flowFiles"] = async ctx => {
  const name = "check_flow_files";
  const { checkFlowFiles } = await import("../agent-lib/tools/flow-file-tools");
  const result = await checkFlowFiles({
    workspaceId: ctx.workspaceId,
    files: ctx.files,
    deletedPaths: ctx.deletedPaths,
  });
  if (result.ok) return { name, status: "passed", detail: result.summary };
  return {
    name,
    status: "failed",
    detail:
      result.problems
        .slice(0, 10)
        .map(p => `${p.path}: ${p.reason}`)
        .join("; ") || result.summary,
  };
};

const appBuildCheck: MergeCheckRunners["appBuild"] = async ctx => {
  const name = "app build";
  // The publish path's own build, on the merge result, in the publisher's
  // box: the checkout of the person who owns the branch is never touched.
  const {
    resolveProjectRef,
    ensureWorktree,
    trialMerge,
    checkoutInBox,
    execInWorktree,
    PUBLISH_ACTOR,
  } = await import("./worktree.service");
  const { buildApp } = await import("./deployment.service");
  const project = await resolveProjectRef(ctx.workspaceId, ctx.appRoot, {
    fetchOnMiss: true,
  });
  if (!project) {
    return {
      name,
      status: "failed",
      detail: `${ctx.appRoot} is not an app of this workspace`,
    };
  }
  const main = project.defaultBranch || DEFAULT_BRANCH;
  const handle = await ensureWorktree(project, PUBLISH_ACTOR, { branch: main });
  const trial = await trialMerge(handle, ctx.branch);
  if (!trial.ok) {
    return {
      name,
      status: "failed",
      detail: trial.reason ?? `${ctx.branch} does not merge into ${main}`,
    };
  }
  await checkoutInBox(handle, trial.sha);
  const build = await buildApp(handle, execInWorktree);
  return build.ok
    ? { name, status: "passed" }
    : { name, status: "failed", detail: build.output.slice(-1500) };
};

export const defaultMergeRequestDeps: MergeRequestDeps = {
  checks: {
    dbtParse: dbtParseCheck,
    flowFiles: flowFilesCheck,
    appBuild: appBuildCheck,
  },
  mirror: workspaceId => resolveMirrorTarget(workspaceId),
  openPullRequest: async ({ workspaceId, target, branch, title, body }) => {
    const token = await tokenFor(target);
    // The pull request needs the branch on GitHub first.
    await mirrorPushNow(workspaceId);
    const open = await listPullRequests(
      target.owner,
      target.repo,
      { state: "open", head: `${target.owner}:${branch}` },
      token,
    );
    if (open[0]) {
      return { number: open[0].number, url: open[0].htmlUrl, existing: true };
    }
    const created = await createPullRequest(
      target.owner,
      target.repo,
      { title, head: branch, base: DEFAULT_BRANCH, body },
      token,
    );
    logger.info("MCP merge request opened", {
      owner: target.owner,
      repo: target.repo,
      branch,
      number: created.number,
    });
    return { number: created.number, url: created.htmlUrl, existing: false };
  },
  merge: async ({ workspaceId, branch, userId }) =>
    mergeBranchToMain(
      { workspaceId, root: null, defaultBranch: DEFAULT_BRANCH },
      branch,
      undefined,
      userId,
    ),
};
