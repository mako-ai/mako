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
  DbtRun,
  type IDbtJob,
  type IDbtRun,
} from "../database/workspace-schema";
import { parseDbtCommands } from "./commands";
import { loggers } from "../logging";

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
): Promise<T> {
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
): Promise<T[]> {
  return Promise.all(
    runs.map(run => (isStaleQueued(run) ? reconcileStaleQueuedRun(run) : run)),
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

export async function triggerDbtRun(params: {
  workspaceId: string;
  projectId: string;
  jobId?: string;
  environment: string;
  commands: string[];
  trigger: "schedule" | "manual" | "agent";
  triggeredBy: string;
  /**
   * When set (scheduled runs), collapse onto an already-active run for the
   * same job instead of stacking a new one — the executor only runs one run
   * per project at a time, so overlapping schedule ticks would otherwise queue
   * up redundant work (dbt Cloud skips overlapping scheduled runs likewise).
   */
  skipIfActive?: boolean;
}): Promise<IDbtRun> {
  // Validate before persisting anything — bad commands never reach a run doc.
  parseDbtCommands(params.commands);

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

export async function requestDbtRunCancel(params: {
  workspaceId: string;
  runId: string;
}): Promise<boolean> {
  const run = await DbtRun.findOne({
    _id: new Types.ObjectId(params.runId),
    workspaceId: new Types.ObjectId(params.workspaceId),
  });
  if (!run) return false;
  if (run.status !== "queued" && run.status !== "running") return false;

  // cancelOn match in the executor; queued runs are finalized directly since
  // the executor may not have started yet.
  await inngest.send({
    name: "dbt/run.cancel",
    data: { runId: params.runId },
  });

  await DbtRun.updateOne(
    { _id: run._id, status: "queued" },
    { $set: { status: "cancelled", completedAt: new Date() } },
  );
  return true;
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
