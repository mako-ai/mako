// Owner: WP2 (notifications).

import { Types } from "mongoose";
import { DbtJob, DbtRun } from "../database/workspace-schema";
import { inngest } from "../inngest/client";
import { loggers } from "../logging";
import {
  boundErrorMessage,
  boundFailedSteps,
  dbtRunDeepLink,
} from "../services/flow-run-notification.helpers";
import type { FlowRunTerminalEventData } from "../services/flow-run-notification.types";

const logger = loggers.inngest("notification");

function clientUrl(): string {
  return (process.env.CLIENT_URL || process.env.PUBLIC_URL || "").replace(
    /\/+$/,
    "",
  );
}

/** Inngest drops a second event with the same id, so a retry posts once. */
export function dbtRunTerminalEventId(runId: string): string {
  return `dbt-run-terminal:${runId}`;
}

/**
 * Build the terminal event of a dbt job run. Null when the run notifies
 * nobody: unknown run, no job, cancelled, or still queued or running.
 */
export async function buildDbtRunTerminalEvent(
  runId: string,
): Promise<FlowRunTerminalEventData | null> {
  if (!Types.ObjectId.isValid(runId)) return null;
  const run = await DbtRun.findById(runId).select("-logs -output").lean();
  if (!run?.jobId) return null;
  if (run.status !== "success" && run.status !== "error") return null;

  const [job, previous] = await Promise.all([
    DbtJob.findById(run.jobId).select("name").lean(),
    // One job runs one run at a time, so creation order is completion order.
    DbtRun.findOne({
      jobId: run.jobId,
      _id: { $ne: run._id },
      status: { $in: ["success", "error"] },
      createdAt: { $lt: run.createdAt },
    })
      .sort({ createdAt: -1 })
      .select("status")
      .lean(),
  ]);

  const success = run.status === "success";
  const jobId = run.jobId.toString();
  const projectId = run.projectId.toString();
  const { failedSteps, failedStepCount } = boundFailedSteps(
    run.stepResults ?? [],
  );

  return {
    workspaceId: run.workspaceId.toString(),
    resourceType: "dbt_job",
    resourceId: jobId,
    resourceName: job?.name || "dbt job",
    projectId,
    environment: run.environment,
    runId: run._id.toString(),
    status: run.status,
    success,
    triggerType: run.trigger === "ci" ? undefined : run.trigger,
    completedAt: (run.completedAt ?? new Date()).toISOString(),
    durationMs: run.durationMs,
    errorMessage: success ? undefined : boundErrorMessage(run.error),
    previousStatus:
      previous?.status === "success" || previous?.status === "error"
        ? previous.status
        : undefined,
    ...(success ? {} : { failedSteps, failedStepCount }),
    deepLink: dbtRunDeepLink({
      baseUrl: clientUrl(),
      projectId,
      jobId,
      runId: run._id.toString(),
    }),
  };
}

/**
 * Emit `flow.run.terminal` for a finished dbt job run so `dbt_job` and
 * `dbt_project` notification rules fan out. Call after the terminal status is
 * persisted. Reads the run itself; no-op for runs without a job, cancelled
 * runs and non-terminal runs. Never throws: failures are logged.
 */
export async function emitDbtRunTerminalEvent(runId: string): Promise<void> {
  try {
    const data = await buildDbtRunTerminalEvent(runId);
    if (!data) return;
    await inngest.send({
      id: dbtRunTerminalEventId(data.runId),
      name: "flow.run.terminal",
      data,
    });
  } catch (error) {
    logger.error("dbt run notification event failed", {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** One announcement per run that disabled its job, whatever retries. */
export function dbtJobAutoDisabledEventId(runId: string): string {
  return `dbt-job-auto-disabled:${runId}`;
}

/**
 * Announce that a job was auto-disabled after `consecutiveFailures` failed
 * runs in a row. `runId` is the failed run that tripped the threshold.
 *
 * It travels the same `flow.run.terminal` path as the run's own event, with
 * `jobDisabled` set: every enabled rule with the failure trigger on the job
 * or its project gets it once, whatever its cadence, under an idempotency
 * key of its own. Without it a job on the default cadence goes silent: its
 * rules heard the first failure and nothing after. Never throws.
 */
export async function emitDbtJobAutoDisabledEvent(
  runId: string,
  consecutiveFailures: number,
): Promise<void> {
  try {
    const data = await buildDbtRunTerminalEvent(runId);
    // Only a failed run disables a job.
    if (!data || data.success) return;
    await inngest.send({
      id: dbtJobAutoDisabledEventId(data.runId),
      name: "flow.run.terminal",
      data: {
        ...data,
        jobDisabled: { consecutiveFailures },
      } satisfies FlowRunTerminalEventData,
    });
  } catch (error) {
    logger.error("dbt job auto-disabled notification event failed", {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
