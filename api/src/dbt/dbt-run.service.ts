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

  await inngest.send({
    name: "dbt/run.requested",
    data: {
      workspaceId: params.workspaceId,
      projectId: params.projectId,
      runId: run._id.toString(),
      jobId: params.jobId,
    },
  });

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

  await inngest.send({
    name: "dbt/run.requested",
    data: {
      workspaceId: params.workspaceId,
      projectId: source.projectId.toString(),
      runId: run._id.toString(),
      jobId: source.jobId?.toString(),
    },
  });

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
