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
}): Promise<IDbtRun> {
  // Validate before persisting anything — bad commands never reach a run doc.
  parseDbtCommands(params.commands);

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
  });
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
