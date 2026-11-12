/**
 * dbt run lifecycle helpers shared by the routes, the Inngest scheduler,
 * and the agent's server tools. The trigger path always creates the run
 * document first (so callers get a runId immediately) and then hands
 * execution to the Inngest executor via "dbt/run.requested".
 */

import { Types } from "mongoose";
import { inngest } from "../inngest/client";
import {
  DbtJob,
  DbtProject,
  DbtRun,
  type DbtRunStatus,
  type IDbtJob,
  type IDbtRun,
} from "../database/workspace-schema";
import { assertAdhocDbtRunAllowed } from "./dbt-environments.service";
import {
  getCheckoutBranch,
  resolveWorkingTreeCommit,
} from "./dbt-working-tree.service";
import { parseDbtCommands } from "./commands";
import { readJobDefinitionAtCommit } from "./dbt-job-at-commit";
import { DbtJobDefinitionMissingError } from "./dbt-run-errors";
import {
  applyFullRefresh,
  DbtRunOverridesError,
  validateRunOverrides,
  type DbtRunOverrides,
} from "./dbt-run-overrides";
import {
  dbtProjectRunConcurrency,
  dbtRunLane,
  dbtRunLaneFilter,
  dbtRunQueueKeys,
} from "./dbt-run-queue";
import { cancelLocalRun } from "./dbt-run-registry";
import type { AdhocDbtResult } from "./dbt-project.service";
import { loggers } from "../logging";

const TERMINAL_DBT_RUN_STATUSES: ReadonlySet<DbtRunStatus> = new Set([
  "success",
  "error",
  "cancelled",
]);

/**
 * May this finished run's manifest become the project's prod state (the
 * `--defer` / Slim CI baseline)? Only when it built the COMMITTED default
 * branch into the prod-like environment. A laptop overlay, an agent's
 * working tree or a PR head is not what prod runs, even when it ran against
 * the prod environment (a read-only `dbt test --env prod` is allowed).
 */
export function promotesProdManifest(
  run: Pick<IDbtRun, "gitBranch" | "workingTreeUserId" | "localOverlay">,
  ranInProdLikeEnvironment: boolean,
): boolean {
  if (!ranInProdLikeEnvironment) return false;
  if (run.localOverlay || run.workingTreeUserId) return false;
  return !run.gitBranch || run.gitBranch === "main";
}

export function isTerminalDbtRunStatus(status: DbtRunStatus): boolean {
  return TERMINAL_DBT_RUN_STATUSES.has(status);
}

const logger = loggers.api("dbt-run");

/**
 * How long an ad-hoc run may sit in "queued" before the read-side watchdog
 * declares it failed. With a free slot in its lane, the executor claims a run
 * within seconds, so anything still queued past this window (and with its
 * lane not full) means the event was never delivered — worker down, or
 * events not routed to this env (branch/preview).
 *
 * This is a fast, interactive complement to the cron `dbtRunSweeperFunction`,
 * which is the authoritative backstop (6h) and the only path that finalizes
 * *scheduled* job runs (it also mirrors job-health stats). We intentionally do
 * NOT fast-fail job runs here to avoid that stat drift.
 */
const QUEUE_TIMEOUT_MS = Number(process.env.DBT_QUEUE_TIMEOUT_MS) || 5 * 60_000;

type ReconcilableRun = {
  _id: Types.ObjectId;
  projectId?: Types.ObjectId;
  jobId?: Types.ObjectId;
  status: string;
  /** Executor lane; unset on runs that predate lanes (= "job"). */
  lane?: string;
  createdAt?: Date;
  startedAt?: Date;
  error?: string;
  completedAt?: Date;
};

export function isStaleQueued(
  run: ReconcilableRun,
  now: number = Date.now(),
  timeoutMs: number = QUEUE_TIMEOUT_MS,
): boolean {
  if (run.status !== "queued" || run.startedAt) return false;
  const created = run.createdAt ? new Date(run.createdAt).getTime() : 0;
  return created > 0 && now - created > timeoutMs;
}

/**
 * Finalize an ad-hoc run stuck in "queued" past QUEUE_TIMEOUT_MS as an error,
 * so the run card / Runs view never spin forever on a lost event. Guards:
 *
 *  - **Ad-hoc only.** Scheduled job runs (jobId set) are left to the cron
 *    sweeper, which mirrors job-health stats; failing them here would drift.
 *  - **Lane not full.** The executor runs up to
 *    `DBT_PROJECT_RUN_CONCURRENCY` runs per project and lane, so a queued run
 *    whose lane is full is legitimately waiting its turn — never fail those.
 *    A run in the other lane does not hold it back and does not excuse it.
 *  - **Guarded write** on `status: "queued"`, mutually exclusive with the
 *    executor's `mark-running` claim, so a last-moment pickup is never clobbered.
 *
 * Returns the (possibly patched) run for immediate display.
 */
export async function reconcileStaleQueuedRun<T extends ReconcilableRun>(
  run: T,
  opts: { persist?: boolean } = {},
): Promise<T> {
  // `persist: false` makes this a read-only projection for GET responses — it
  // computes the terminal status to display but performs no write. Mutating on
  // a read path is surprising and means read-only viewers would trigger writes;
  // the cron sweeper is the single writer for stale runs.
  const persist = opts.persist ?? true;
  if (!isStaleQueued(run)) return run;
  // Scheduled job runs are the cron sweeper's responsibility (+ stat mirroring).
  if (run.jobId) return run;
  // Still waiting for a slot of its own lane? Not a lost event.
  if (run.projectId) {
    const peersRunning = await DbtRun.countDocuments({
      projectId: run.projectId,
      status: "running",
      _id: { $ne: run._id },
      ...dbtRunLaneFilter(run.lane === "interactive" ? "interactive" : "job"),
    });
    if (peersRunning >= dbtProjectRunConcurrency()) return run;
  }

  const completedAt = new Date();
  const error =
    `Run timed out in "queued" after ${Math.round(QUEUE_TIMEOUT_MS / 1000)}s — ` +
    `the dbt worker never picked it up. The Inngest worker may be unavailable, ` +
    `or "dbt/run.requested" events are not being routed to this environment.`;

  if (!persist) {
    return { ...run, status: "error", error, completedAt } as T;
  }

  const res = await DbtRun.updateOne(
    { _id: run._id, status: "queued" },
    { $set: { status: "error", error, completedAt } },
  );

  // modifiedCount === 0 means the executor claimed it first; leave it alone.
  if (res.modifiedCount !== 1) return run;

  logger.warn("dbt run timed out in queued; finalized as error", {
    event: "dbt.run.queue_timeout",
    runId: run._id.toString(),
    queueTimeoutMs: QUEUE_TIMEOUT_MS,
  });
  return { ...run, status: "error", error, completedAt } as T;
}

/** Batch variant — only touches the DB for runs that are actually stale. */
export async function reconcileStaleQueuedRuns<T extends ReconcilableRun>(
  runs: T[],
  opts: { persist?: boolean } = {},
): Promise<T[]> {
  return Promise.all(
    runs.map(run =>
      isStaleQueued(run) ? reconcileStaleQueuedRun(run, opts) : run,
    ),
  );
}

/**
 * Mark a freshly-created run as failed when we cannot even hand it to the
 * executor (e.g. inngest.send throws). Guarded on "queued" so it never clobbers
 * a run that somehow already started.
 */
async function failUnenqueuedRun(
  runId: Types.ObjectId,
  cause: unknown,
): Promise<void> {
  const message = cause instanceof Error ? cause.message : String(cause);
  await DbtRun.updateOne(
    { _id: runId, status: "queued" },
    {
      $set: {
        status: "error",
        error: `Failed to enqueue dbt run: ${message}`,
        completedAt: new Date(),
      },
    },
  ).catch(() => {
    /* best-effort: the original send error is what we surface */
  });
}

export interface DbtRunCiContext {
  prNumber: number;
  headSha: string;
  headRef: string;
  baseRef: string;
  owner: string;
  repo: string;
  installationId?: number;
}

/** A scheduled tick that started no run, and why. */
type SkippedTickReason = "active_run" | "definition_missing";

/**
 * Count a scheduled tick that started no run. Without this the tick leaves
 * no trace: an hourly job stuck behind a long build reads as "ran 87 times"
 * with nothing saying 69 more ticks were dropped.
 */
async function recordSkippedTick(
  jobId: Types.ObjectId,
  reason: SkippedTickReason,
  details: Record<string, unknown> = {},
): Promise<void> {
  await DbtJob.updateOne(
    { _id: jobId },
    {
      $inc: { "scheduledRun.skippedCount": 1 },
      $set: { "scheduledRun.lastSkippedAt": new Date() },
    },
  ).catch(error => {
    logger.warn("Failed to count skipped dbt job tick", {
      jobId: jobId.toString(),
      error,
    });
  });
  logger.info("dbt job scheduled tick skipped", {
    event: "dbt.job.tick_skipped",
    jobId: jobId.toString(),
    reason,
    ...details,
  });
}

/**
 * The queued or running run of this job a scheduled tick collapses onto, if
 * any. Counts the tick as skipped when it does.
 */
async function collapseOntoActiveJobRun(
  jobId: Types.ObjectId,
): Promise<IDbtRun | null> {
  const active = await DbtRun.findOne({
    jobId,
    status: { $in: ["queued", "running"] },
  }).sort({ createdAt: -1 });
  if (!active) return null;
  await recordSkippedTick(jobId, "active_run", {
    activeRunId: active._id.toString(),
    activeRunStatus: active.status,
  });
  return active;
}

export async function triggerDbtRun(params: {
  workspaceId: string;
  projectId: string;
  jobId?: string;
  environment: string;
  commands: string[];
  trigger: "schedule" | "manual" | "agent" | "ci";
  triggeredBy: string;
  /**
   * Branch whose committed base tree the run builds (repo-bound projects).
   * Defaults to the project default branch; CI runs pass the PR head.
   */
  gitBranch?: string;
  /**
   * Build this user's working tree (checkout + drafts) instead of a
   * committed base tree — agent verification builds of uncommitted work.
   */
  workingTreeUserId?: string;
  /**
   * Ad-hoc/agent runs: execute with `--defer --state <last prod manifest>`
   * so unselected refs resolve to the production build instead of requiring
   * the whole upstream DAG in the target schema. No-op when the project has
   * no prod manifest yet. Job runs pass the flag of the job definition they
   * resolved (triggerDbtJobRun); CI runs configure defer on the CI config.
   */
  deferToProduction?: boolean;
  /**
   * The commit to build, when the caller already resolved it (job runs read
   * their definition at that same commit). Null = resolved, nothing to pin.
   * Omitted = resolve it here.
   */
  sourceSha?: string | null;
  /** Job runs: the commit the job definition was read from. */
  definitionSha?: string;
  /**
   * Per-run inputs ALREADY validated by `validateRunOverrides`; `commands`
   * must already hold the final list. Only triggerDbtJobRun passes this.
   */
  overrides?: DbtRunOverrides;
  /**
   * A laptop checkout (`mako dbt run`): build the stored overlay over its
   * base commit instead of any branch. `label` is the display-only source
   * ("local checkout on feat/x").
   */
  localOverlay?: {
    key: string;
    baseSha?: string;
    files: number;
    deletes: number;
    label: string;
  };
  /** PR context for CI runs (trigger === "ci"). */
  ci?: DbtRunCiContext;
  /**
   * When set (scheduled runs), collapse onto an already-active run for the
   * same job instead of stacking a new one — a job runs one run at a time, so
   * overlapping schedule ticks would otherwise queue up redundant work (dbt
   * Cloud skips overlapping scheduled runs likewise). The tick is counted on
   * the job (`scheduledRun.skippedCount`).
   */
  skipIfActive?: boolean;
}): Promise<IDbtRun> {
  // Validate before persisting anything — bad commands never reach a run doc.
  const parsedCommands = parseDbtCommands(params.commands);

  const project = await DbtProject.findOne({
    _id: new Types.ObjectId(params.projectId),
    workspaceId: new Types.ObjectId(params.workspaceId),
  })
    .select("workspaceId environments defaultEnvironment prodEnvironment")
    .lean();

  // Ad-hoc (non-job, non-CI) runs on repo-connected projects build a
  // working tree — refuse warehouse writes into the protected prod-like
  // environment so uncommitted drafts can never deploy to prod. Jobs and CI
  // (which build committed trees) are the only paths allowed to write there.
  const isAdhocRun =
    !params.jobId && params.trigger !== "ci" && params.trigger !== "schedule";
  if (isAdhocRun && project) {
    assertAdhocDbtRunAllowed(project, params.environment, parsedCommands);
  }

  // Display-only provenance: which git branch this run's source tree comes
  // from. Working-tree runs (workingTreeUserId) record that user's session
  // branch; explicit-branch runs record it directly; everything else (jobs,
  // deploys) builds the default branch of the workspace repo.
  const sourceBranch =
    params.localOverlay?.label ??
    params.gitBranch ??
    (project
      ? await getCheckoutBranch(project, params.workingTreeUserId)
      : undefined);

  if (params.skipIfActive && params.jobId) {
    const active = await collapseOntoActiveJobRun(
      new Types.ObjectId(params.jobId),
    );
    if (active) return active;
  }

  // Pin the tree now: building "the branch" per command would build whatever
  // the executing instance last fetched, and could change between commands.
  let sourceSha: string | undefined;
  if (params.sourceSha !== undefined) {
    sourceSha = params.sourceSha ?? undefined;
  } else if (project && !params.localOverlay) {
    sourceSha =
      (await resolveWorkingTreeCommit(project, {
        branch: params.gitBranch,
        userId: params.workingTreeUserId,
      })) ?? undefined;
  }

  const lane = dbtRunLane({
    jobId: params.jobId,
    trigger: params.trigger,
    subcommands: parsedCommands.map(command => command.subcommand),
  });

  const run = await DbtRun.create({
    workspaceId: new Types.ObjectId(params.workspaceId),
    projectId: new Types.ObjectId(params.projectId),
    jobId: params.jobId ? new Types.ObjectId(params.jobId) : undefined,
    environment: params.environment,
    commands: params.commands,
    status: "queued",
    trigger: params.trigger,
    triggeredBy: params.triggeredBy,
    gitBranch: params.gitBranch,
    workingTreeUserId: params.workingTreeUserId,
    sourceBranch,
    sourceSha,
    deferToProduction: params.deferToProduction,
    definitionSha: params.definitionSha,
    lane,
    ...(params.overrides ? { overrides: params.overrides } : {}),
    ...(params.localOverlay
      ? {
          localOverlay: {
            key: params.localOverlay.key,
            baseSha: params.localOverlay.baseSha,
            files: params.localOverlay.files,
            deletes: params.localOverlay.deletes,
          },
        }
      : {}),
    ci: params.ci,
  });

  try {
    await inngest.send({
      name: "dbt/run.requested",
      data: {
        workspaceId: params.workspaceId,
        projectId: params.projectId,
        runId: run._id.toString(),
        jobId: params.jobId,
        ...dbtRunQueueKeys({
          projectId: params.projectId,
          runId: run._id.toString(),
          jobId: params.jobId,
          lane,
        }),
      },
    });
  } catch (sendError) {
    await failUnenqueuedRun(run._id, sendError);
    throw sendError;
  }

  return run;
}

/** Log lines kept when persisting a completed sync ad-hoc run (mirrors the
 * executor's MAX_LOG_LINES cap in inngest/functions/dbt-run.ts). */
const ADHOC_RECORD_MAX_LOG_LINES = 5000;

/**
 * Persist a COMPLETED synchronous ad-hoc command (IDE Run button / command
 * bar) into dbt_runs so editor runs share the same history, run detail, and
 * provenance UI as agent/job runs. Written post-hoc with a terminal status —
 * it never goes through the executor, so there is no queued/running state,
 * no cancel plumbing, and no sweeper interaction. Best-effort: a write
 * failure must never fail the run the user already got results for.
 */
export async function recordCompletedAdhocDbtRun(params: {
  workspaceId: string;
  projectId: string;
  environment: string;
  command: string;
  triggeredBy: string;
  /** Caller whose working tree the command built (repo-bound projects). */
  workingTreeUserId?: string;
  /** Caller's checkout branch at run time (display-only provenance). */
  sourceBranch?: string;
  deferToProduction?: boolean;
  startedAt: Date;
  result: Pick<AdhocDbtResult, "success" | "exitCode" | "logs" | "stepResults">;
}): Promise<IDbtRun | null> {
  try {
    const completedAt = new Date();
    return await DbtRun.create({
      workspaceId: new Types.ObjectId(params.workspaceId),
      projectId: new Types.ObjectId(params.projectId),
      environment: params.environment,
      commands: [params.command],
      status: params.result.success ? "success" : "error",
      trigger: "manual",
      triggeredBy: params.triggeredBy,
      workingTreeUserId: params.workingTreeUserId,
      sourceBranch: params.sourceBranch,
      deferToProduction: params.deferToProduction,
      startedAt: params.startedAt,
      completedAt,
      durationMs: completedAt.getTime() - params.startedAt.getTime(),
      ...(params.result.success
        ? {}
        : {
            error: `dbt command "${params.command}" exited with code ${params.result.exitCode}`,
          }),
      logs: params.result.logs.slice(-ADHOC_RECORD_MAX_LOG_LINES).map(line => ({
        ts: line.ts,
        level: line.level,
        // dbt emits blank spacer lines; `create` runs full validation (unlike
        // the executor's $push), and a required String path rejects "".
        line: line.line.slice(0, 2000) || " ",
      })),
      stepResults: params.result.stepResults,
    });
  } catch (error) {
    logger.warn("Failed to record completed ad-hoc dbt run", {
      error,
      projectId: params.projectId,
    });
    return null;
  }
}

export { DbtJobDefinitionMissingError };

export async function triggerDbtJobRun(params: {
  workspaceId: string;
  job: IDbtJob;
  trigger: "schedule" | "manual" | "agent";
  triggeredBy: string;
  /**
   * Manual/agent triggers only: per-run vars and full refresh. Validated here
   * with `validateRunOverrides`; throws DbtRunOverridesError on bad input.
   */
  overrides?: DbtRunOverrides;
}): Promise<IDbtRun> {
  const { job } = params;
  if (params.overrides && params.trigger === "schedule") {
    throw new DbtRunOverridesError(
      "Scheduled runs take no vars or fullRefresh; change the job instead",
    );
  }
  // Scheduled ticks must not stack behind a still-active run of the job.
  // Checked before the commit is resolved: a collapsed tick costs no fetch.
  if (params.trigger === "schedule") {
    const active = await collapseOntoActiveJobRun(job._id);
    if (active) return active;
  }

  const definition = await resolveJobDefinition(params.workspaceId, job);
  if (definition.kind === "missing") {
    if (params.trigger === "schedule") {
      await recordSkippedTick(job._id, "definition_missing", {
        slug: job.slug,
        sourceSha: definition.sourceSha,
      });
    }
    throw new DbtJobDefinitionMissingError(job, definition.sourceSha);
  }

  // Per-run inputs apply to this run only: nothing here writes to the job
  // row or its yml. Skipped when absent so a plain trigger never depends on
  // the validator.
  const overrides = params.overrides
    ? validateRunOverrides(params.overrides, definition.commands)
    : undefined;
  const commands = overrides?.fullRefresh
    ? applyFullRefresh(definition.commands)
    : definition.commands;

  return triggerDbtRun({
    workspaceId: params.workspaceId,
    projectId: job.projectId.toString(),
    jobId: job._id.toString(),
    environment: definition.environment,
    commands,
    trigger: params.trigger,
    triggeredBy: params.triggeredBy,
    sourceSha: definition.sourceSha,
    definitionSha: definition.definitionSha,
    deferToProduction: definition.deferToProduction,
    overrides,
  });
}

type ResolvedJobDefinition =
  | {
      kind: "resolved";
      environment: string;
      commands: string[];
      deferToProduction: boolean;
      /** The commit the run builds. Null when there is no tree to pin. */
      sourceSha: string | null;
      /** Set only when the fields above came from the file at `sourceSha`. */
      definitionSha?: string;
    }
  | { kind: "missing"; sourceSha: string };

/** Push-sync the job index, detached: a trigger never waits on it. */
function requestDbtConfigSync(workspaceId: string): void {
  void import("./dbt-config.service")
    .then(m => m.syncDbtConfigFromRepo(workspaceId))
    .catch(error => {
      logger.warn("dbt config sync requested by a job trigger failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

/**
 * What a run of this job triggered now executes, and the commit it builds.
 *
 * The commit is resolved ONCE and the job file is read at that commit, so
 * the commands and the code can never come from two different commits. The
 * row is used only when there is no file to read (no repo, a pre-adoption
 * row) or the file at that commit is one the sync would refuse, in which
 * case the row is the last good definition.
 */
async function resolveJobDefinition(
  workspaceId: string,
  job: IDbtJob,
): Promise<ResolvedJobDefinition> {
  const fromRow = (sourceSha: string | null): ResolvedJobDefinition => ({
    kind: "resolved",
    environment: job.environment,
    commands: job.commands,
    deferToProduction: !!job.deferToProduction,
    sourceSha,
  });

  const project = await DbtProject.findOne({
    _id: job.projectId,
    workspaceId: new Types.ObjectId(workspaceId),
  })
    .select("workspaceId environments")
    .lean();
  if (!project) return fromRow(null);

  // Jobs build the default branch.
  const sourceSha = await resolveWorkingTreeCommit(project);
  if (!sourceSha || !job.slug) return fromRow(sourceSha);

  const atCommit = await readJobDefinitionAtCommit(
    workspaceId,
    job.slug,
    sourceSha,
  );
  if (atCommit.kind === "missing") {
    // The sync removes the row, so the scheduler stops finding it.
    requestDbtConfigSync(workspaceId);
    return { kind: "missing", sourceSha };
  }
  // The row is behind (or ahead of) this commit: let it catch up. A lost or
  // late push webhook is otherwise never replayed.
  if (atCommit.blobSha !== job.sourceBlobSha) requestDbtConfigSync(workspaceId);

  if (atCommit.kind === "invalid") {
    logger.warn("dbt job file unparseable at the run commit; using the row", {
      event: "dbt.job.definition_fallback",
      jobId: job._id.toString(),
      slug: job.slug,
      sourceSha,
      reason: "unparseable job file",
    });
    return fromRow(sourceSha);
  }
  const { jobApplyFailure } = await import("./dbt-config.service");
  const failure = jobApplyFailure(project, atCommit.file);
  if (failure) {
    logger.warn(
      "dbt job file does not apply at the run commit; using the row",
      {
        event: "dbt.job.definition_fallback",
        jobId: job._id.toString(),
        slug: job.slug,
        sourceSha,
        reason: failure,
      },
    );
    return fromRow(sourceSha);
  }
  return {
    kind: "resolved",
    environment: atCommit.file.environment,
    commands: atCommit.file.commands,
    deferToProduction: atCommit.file.deferToProduction,
    sourceSha,
    definitionSha: sourceSha,
  };
}

/**
 * Retry a failed run from its point of failure. Creates a new run that runs
 * `dbt retry`, seeding the source run's run_results.json into target/ so dbt
 * resumes at the failed/skipped nodes. Requires the source run to have a
 * persisted run_results.json artifact.
 */
export async function triggerDbtRunRetry(params: {
  workspaceId: string;
  runId: string;
  triggeredBy: string;
}): Promise<IDbtRun | null> {
  const source = await DbtRun.findOne({
    _id: new Types.ObjectId(params.runId),
    workspaceId: new Types.ObjectId(params.workspaceId),
  }).lean();
  if (!source) return null;
  if (source.status !== "error") return null;
  if (!source.artifactKeys?.runResults) return null;

  const run = await DbtRun.create({
    workspaceId: source.workspaceId,
    projectId: source.projectId,
    jobId: source.jobId,
    environment: source.environment,
    commands: ["retry"],
    status: "queued",
    trigger: "manual",
    triggeredBy: params.triggeredBy,
    // Resume the same source tree the failed run built — a laptop run's
    // uploaded overlay included (without it the retry would build the
    // default branch under a "local checkout" label).
    gitBranch: source.gitBranch,
    workingTreeUserId: source.workingTreeUserId,
    sourceBranch: source.sourceBranch,
    sourceSha: source.sourceSha,
    ...(source.localOverlay
      ? {
          localOverlay: {
            key: source.localOverlay.key,
            baseSha: source.localOverlay.baseSha,
            files: source.localOverlay.files,
            deletes: source.localOverlay.deletes,
          },
        }
      : {}),
    deferToProduction: source.deferToProduction,
    // `dbt retry` replays the prior argv, vars included: keep the record
    // honest about what this run executes.
    definitionSha: source.definitionSha,
    ...(source.overrides ? { overrides: source.overrides } : {}),
    lane: "job",
    retryOfRunId: source._id,
    restoreArtifactKeys: {
      runResults: source.artifactKeys.runResults,
      manifest: source.artifactKeys.manifest,
    },
  });

  try {
    await inngest.send({
      name: "dbt/run.requested",
      data: {
        workspaceId: params.workspaceId,
        projectId: source.projectId.toString(),
        runId: run._id.toString(),
        jobId: source.jobId?.toString(),
        ...dbtRunQueueKeys({
          projectId: source.projectId.toString(),
          runId: run._id.toString(),
          jobId: source.jobId?.toString(),
          lane: "job",
        }),
      },
    });
  } catch (sendError) {
    await failUnenqueuedRun(run._id, sendError);
    throw sendError;
  }

  return run;
}

/**
 * Flip a run that is still queued/running to the terminal "cancelled" status.
 * Shared by the executor (when its subprocess was aborted) and the
 * `dbt/run.cancel` finalizer so a cancel always lands exactly one terminal
 * write. Idempotent (guarded on a non-terminal status) and an aggregation
 * pipeline so it can preserve an already-staged cancelledBy/cancelledAt and
 * compute durationMs from startedAt in a single atomic update.
 */
export async function finalizeCancelledDbtRun(
  runId: Types.ObjectId | string,
  fallbackCancelledBy?: string,
): Promise<void> {
  const _id = typeof runId === "string" ? new Types.ObjectId(runId) : runId;
  await DbtRun.updateOne(
    { _id, status: { $in: ["queued", "running"] } },
    [
      {
        $set: {
          status: "cancelled",
          completedAt: "$$NOW",
          cancelledAt: { $ifNull: ["$cancelledAt", "$$NOW"] },
          cancelledBy: {
            $ifNull: ["$cancelledBy", fallbackCancelledBy ?? "user"],
          },
          error: { $ifNull: ["$error", "Cancelled"] },
          durationMs: {
            $cond: [
              { $ifNull: ["$startedAt", false] },
              {
                $dateDiff: {
                  startDate: "$startedAt",
                  endDate: "$$NOW",
                  unit: "millisecond",
                },
              },
              "$durationMs",
            ],
          },
        },
      },
    ],
    // Mongoose 9 rejects pipeline updates unless they opt in.
    { updatePipeline: true },
  );
}

export interface DbtRunCancelResult {
  /** The run's status after the cancel attempt (may already be terminal). */
  status: DbtRunStatus;
  cancelledAt?: Date;
  cancelledBy?: string;
}

/**
 * Cancel a queued or running dbt run.
 *
 *  - **queued** → finalized to `cancelled` immediately (guarded on `queued`),
 *    so the executor's `mark-running` claim no-ops and it never executes.
 *  - **running** → stage the cancel attribution on the doc, then (a) abort the
 *    local subprocess + best-effort cancel its BigQuery jobs via the in-process
 *    registry and (b) emit `dbt/run.cancel` so Inngest `cancelOn` frees the
 *    concurrency slot and the finalizer flips the status (covers the
 *    cross-instance case where the worker runs elsewhere).
 *  - **terminal** (success/error/cancelled) → idempotent no-op; returns the
 *    current status with no side effects.
 *
 * Returns `null` only when the run does not exist. Otherwise returns the
 * run's status; in the race where the run finishes just as cancel arrives, the
 * real terminal status (e.g. `success`) is returned rather than an error.
 */
export async function requestDbtRunCancel(params: {
  workspaceId: string;
  runId: string;
  /** User id, or "agent" for automated cancels. */
  cancelledBy?: string;
}): Promise<DbtRunCancelResult | null> {
  const run = await DbtRun.findOne({
    _id: new Types.ObjectId(params.runId),
    workspaceId: new Types.ObjectId(params.workspaceId),
  })
    .select("status cancelledAt cancelledBy")
    .lean();
  if (!run) return null;

  // Idempotent: a terminal run is a no-op that echoes the current status.
  if (isTerminalDbtRunStatus(run.status)) {
    return {
      status: run.status,
      cancelledAt: run.cancelledAt,
      cancelledBy: run.cancelledBy,
    };
  }

  const cancelledBy = params.cancelledBy ?? "user";
  const now = new Date();

  // Queued runs are finalized synchronously (never start). Guarded on "queued"
  // so a last-moment executor pickup (queued→running race) is never clobbered.
  const queued = await DbtRun.findOneAndUpdate(
    { _id: run._id, status: "queued" },
    {
      $set: {
        status: "cancelled",
        completedAt: now,
        cancelledAt: now,
        cancelledBy,
      },
    },
    { returnDocument: "after" },
  )
    .select("status cancelledAt cancelledBy")
    .lean();

  // Always emit the cancel event: frees the Inngest concurrency slot (cancelOn)
  // so the next queued run starts, and runs the finalizer as a cross-instance
  // backstop. Carries cancelledBy so the finalizer can attribute it.
  await inngest
    .send({
      name: "dbt/run.cancel",
      data: { runId: params.runId, cancelledBy },
    })
    .catch(error => {
      logger.warn("Failed to emit dbt/run.cancel event", {
        error,
        runId: params.runId,
      });
    });

  if (queued) {
    return {
      status: "cancelled",
      cancelledAt: queued.cancelledAt ?? now,
      cancelledBy: queued.cancelledBy ?? cancelledBy,
    };
  }

  // Not queued anymore → running (or it just finished). Stage attribution so
  // the finalizer + UI can show who/when, then kill the local subprocess.
  await DbtRun.updateOne(
    { _id: run._id, status: "running" },
    { $set: { cancelledAt: now, cancelledBy } },
  );
  cancelLocalRun(params.runId, `Cancelled by ${cancelledBy}`);

  // Re-read for the authoritative current status (handles the finish-just-as-
  // cancel-arrives race: return the real terminal status, not an error).
  const fresh = await DbtRun.findById(run._id)
    .select("status cancelledAt cancelledBy")
    .lean();
  return {
    status: fresh?.status ?? "running",
    cancelledAt: fresh?.cancelledAt,
    cancelledBy: fresh?.cancelledBy,
  };
}

/**
 * Auto-disable a scheduled job after this many consecutive failures so a
 * persistently broken job stops re-running on every tick. 0 disables the
 * behavior. Override with DBT_AUTO_DISABLE_AFTER_FAILURES.
 */
export const DBT_AUTO_DISABLE_AFTER_FAILURES = Number(
  process.env.DBT_AUTO_DISABLE_AFTER_FAILURES ?? "10",
);

/**
 * Filter matching an enabled job whose failure count already reached the
 * auto-disable threshold. Only a job someone re-enabled after an auto-disable
 * can be in that state, and it must start a fresh count: otherwise its very
 * next failure disables it again.
 */
export function reenabledAfterAutoDisableFilter(
  jobId: Types.ObjectId,
  threshold = DBT_AUTO_DISABLE_AFTER_FAILURES,
): Record<string, unknown> | null {
  if (!(threshold > 0)) return null;
  return {
    _id: jobId,
    enabled: true,
    "scheduledRun.consecutiveFailures": { $gte: threshold },
  };
}

/**
 * Disable a scheduled job that kept failing. The ROW flips first: it is what
 * the scheduler scans, so the job stops even when the yml write-through
 * fails (no repo access, a rejected push, a git lock). Committing first left
 * a failed commit with the job still enabled and failing on every tick.
 *
 * A failed write-through leaves `enabled: true` in the file while the row is
 * disabled; the row keeps its `sourceBlobSha`, so the sync sees it as level
 * and does not re-enable it. The next edit of the file decides again.
 */
export async function autoDisableDbtJob(
  job: IDbtJob,
  failures: number,
  lastError?: string,
): Promise<void> {
  await DbtJob.updateOne(
    { _id: job._id },
    {
      $set: {
        enabled: false,
        "scheduledRun.lastError": `Auto-disabled after ${failures} consecutive failures. Last error: ${lastError ?? "unknown"}`,
      },
      $unset: { "scheduledRun.nextAt": "" },
    },
  );
  logger.warn("Auto-disabled dbt job after repeated failures", {
    jobId: job._id.toString(),
    consecutiveFailures: failures,
  });
  try {
    const { commitDbtJobFile } = await import("./dbt-config.service");
    job.enabled = false;
    await commitDbtJobFile(
      { workspaceId: job.workspaceId },
      job,
      undefined,
      `dbt: auto-disable job "${job.name}" after ${failures} failures`,
    );
  } catch (error) {
    logger.warn("Auto-disable file write-through failed", {
      jobId: job._id.toString(),
      slug: job.slug,
      error,
    });
  }
}

/** Recompute a job's next scheduled run after a schedule edit. */
export async function applyJobScheduleChange(job: IDbtJob): Promise<void> {
  if (job.schedule?.cron && job.enabled) {
    const { getNextScheduledConsoleRunAt } =
      await import("../services/scheduled-query-schedule.service");
    const nextAt = getNextScheduledConsoleRunAt({
      cron: job.schedule.cron,
      timezone: job.schedule.timezone || "UTC",
    });
    await DbtJob.updateOne(
      { _id: job._id },
      { $set: { "scheduledRun.nextAt": nextAt } },
    );
    const reenabled = reenabledAfterAutoDisableFilter(job._id);
    if (reenabled) {
      await DbtJob.updateOne(reenabled, {
        $set: { "scheduledRun.consecutiveFailures": 0 },
      });
    }
  } else {
    await DbtJob.updateOne(
      { _id: job._id },
      { $unset: { "scheduledRun.nextAt": "" } },
    );
  }
}
