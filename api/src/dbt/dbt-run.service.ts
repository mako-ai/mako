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
import { getCheckoutBranch } from "./dbt-working-tree.service";
import { parseDbtCommands } from "./commands";
import { cancelLocalRun } from "./dbt-run-registry";
import type { AdhocDbtResult } from "./dbt-project.service";
import { loggers } from "../logging";

const TERMINAL_DBT_RUN_STATUSES: ReadonlySet<DbtRunStatus> = new Set([
  "success",
  "error",
  "cancelled",
]);

export function isTerminalDbtRunStatus(status: DbtRunStatus): boolean {
  return TERMINAL_DBT_RUN_STATUSES.has(status);
}

const logger = loggers.api("dbt-run");

/**
 * How long an ad-hoc run may sit in "queued" before the read-side watchdog
 * declares it failed. With no sibling run executing for the project, the
 * executor claims a run within seconds, so anything still queued past this
 * window (and with nothing running ahead of it) means the event was never
 * delivered — worker down, or events not routed to this env (branch/preview).
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
 *  - **No sibling executing.** The executor serializes per project
 *    (concurrency limit 1 / projectId), so a queued run with a peer already
 *    `running` is legitimately waiting its turn — never fail those.
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
  // Still waiting behind the per-project concurrency lock? Not a lost event.
  if (run.projectId) {
    const peerRunning = await DbtRun.exists({
      projectId: run.projectId,
      status: "running",
      _id: { $ne: run._id },
    });
    if (peerRunning) return run;
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
   * no prod manifest yet. Job/CI runs configure defer on the job / CI config
   * instead of here.
   */
  deferToProduction?: boolean;
  /** PR context for CI runs (trigger === "ci"). */
  ci?: DbtRunCiContext;
  /**
   * When set (scheduled runs), collapse onto an already-active run for the
   * same job instead of stacking a new one — the executor only runs one run
   * per project at a time, so overlapping schedule ticks would otherwise queue
   * up redundant work (dbt Cloud skips overlapping scheduled runs likewise).
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
    params.gitBranch ??
    (project
      ? await getCheckoutBranch(project, params.workingTreeUserId)
      : undefined);

  if (params.skipIfActive && params.jobId) {
    const active = await DbtRun.findOne({
      jobId: new Types.ObjectId(params.jobId),
      status: { $in: ["queued", "running"] },
    }).sort({ createdAt: -1 });
    if (active) return active;
  }

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
    deferToProduction: params.deferToProduction,
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

export async function triggerDbtJobRun(params: {
  workspaceId: string;
  job: IDbtJob;
  trigger: "schedule" | "manual" | "agent";
  triggeredBy: string;
}): Promise<IDbtRun> {
  return triggerDbtRun({
    workspaceId: params.workspaceId,
    projectId: params.job.projectId.toString(),
    jobId: params.job._id.toString(),
    environment: params.job.environment,
    commands: params.job.commands,
    trigger: params.trigger,
    triggeredBy: params.triggeredBy,
    // Scheduled ticks must not stack behind a still-running run.
    skipIfActive: params.trigger === "schedule",
  });
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
    // Resume the same source tree the failed run built.
    gitBranch: source.gitBranch,
    workingTreeUserId: source.workingTreeUserId,
    sourceBranch: source.sourceBranch,
    deferToProduction: source.deferToProduction,
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
  await DbtRun.updateOne({ _id, status: { $in: ["queued", "running"] } }, [
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
  ]);
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
    { new: true },
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

/** Recompute a job's next scheduled run after a schedule edit. */
export async function applyJobScheduleChange(job: IDbtJob): Promise<void> {
  if (job.schedule?.cron && job.enabled) {
    const { getNextScheduledConsoleRunAt } = await import(
      "../services/scheduled-query-schedule.service"
    );
    const nextAt = getNextScheduledConsoleRunAt({
      cron: job.schedule.cron,
      timezone: job.schedule.timezone || "UTC",
    });
    await DbtJob.updateOne(
      { _id: job._id },
      { $set: { "scheduledRun.nextAt": nextAt } },
    );
  } else {
    await DbtJob.updateOne(
      { _id: job._id },
      { $unset: { "scheduledRun.nextAt": "" } },
    );
  }
}
