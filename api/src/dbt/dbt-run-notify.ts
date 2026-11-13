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
 *
 * "Previous" and "streak" are defined on completion order (`completedAt`).
 * Runs of one job execute one at a time, so they complete one after another
 * and that order is exact. Creation order is not: Inngest gives no FIFO
 * inside a concurrency key, so a run queued later can start, and finish,
 * first.
 */
export async function buildDbtRunTerminalEvent(
  runId: string,
): Promise<FlowRunTerminalEventData | null> {
  if (!Types.ObjectId.isValid(runId)) return null;
  const run = await DbtRun.findById(runId).select("-logs -output").lean();
  if (!run?.jobId) return null;
  if (run.status !== "success" && run.status !== "error") return null;

  const completedAt = run.completedAt ?? new Date();
  // Terminal runs of the same job, in the same workspace, completed before
  // this one. Both lookups are one seek on { jobId, status, completedAt }.
  const earlier = {
    workspaceId: run.workspaceId,
    jobId: run.jobId,
    _id: { $ne: run._id },
    completedAt: { $lt: completedAt },
  };
  const [job, previous, lastSuccess] = await Promise.all([
    DbtJob.findOne({ _id: run.jobId, workspaceId: run.workspaceId })
      .select("name")
      .lean(),
    DbtRun.findOne({ ...earlier, status: { $in: ["success", "error"] } })
      .sort({ completedAt: -1 })
      .select("status")
      .lean(),
    // Where the current failure streak starts. A success needs none.
    run.status === "error"
      ? DbtRun.findOne({ ...earlier, status: "success" })
          .sort({ completedAt: -1 })
          .select("completedAt")
          .lean()
      : null,
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
    completedAt: completedAt.toISOString(),
    durationMs: run.durationMs,
    errorMessage: success ? undefined : boundErrorMessage(run.error),
    previousStatus:
      previous?.status === "success" || previous?.status === "error"
        ? previous.status
        : undefined,
    ...(lastSuccess?.completedAt
      ? { lastSuccessAt: new Date(lastSuccess.completedAt).toISOString() }
      : {}),
    ...(success ? {} : { failedSteps, failedStepCount }),
    deepLink: dbtRunDeepLink({
      baseUrl: clientUrl(),
      projectId,
      jobId,
      runId: run._id.toString(),
    }),
  };
}

/** How an emit retries: attempts in all, and the first wait, doubled each time. */
export interface DbtRunEmitRetry {
  attempts?: number;
  baseDelayMs?: number;
}

/** 4 attempts, waiting 500 ms, 1 s and 2 s: 3.5 s at most inside the step. */
const EMIT_ATTEMPTS = 4;
const EMIT_BASE_DELAY_MS = 500;

/**
 * Run `emit` until it succeeds, with exponential backoff. The executor runs
 * with `retries: 0`, so a throw here would not be retried by Inngest: one
 * failed send (a network blip, an Inngest 5xx) would lose the alert. Every
 * event carries an id Inngest deduplicates on, so sending twice posts once.
 * Returns false when every attempt failed; the last error is logged.
 */
async function emitWithRetry(
  what: string,
  runId: string,
  emit: () => Promise<void>,
  retry: DbtRunEmitRetry = {},
): Promise<boolean> {
  const attempts = Math.max(1, retry.attempts ?? EMIT_ATTEMPTS);
  const baseDelayMs = retry.baseDelayMs ?? EMIT_BASE_DELAY_MS;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await emit();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === attempts) {
        logger.error(`${what} failed; the notification is lost`, {
          event: "dbt.run.notification_lost",
          runId,
          attempts,
          error: message,
        });
        return false;
      }
      logger.warn(`${what} failed; retrying`, {
        runId,
        attempt,
        error: message,
      });
      await new Promise(resolve =>
        setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)),
      );
    }
  }
  return false;
}

/**
 * Emit `flow.run.terminal` for a finished dbt job run so `dbt_job` and
 * `dbt_project` notification rules fan out. Call after the terminal status is
 * persisted. Reads the run itself; no-op for runs without a job, cancelled
 * runs and non-terminal runs. A failed read or send is retried with backoff.
 * Never throws: when every attempt fails the loss is logged as an error.
 */
export async function emitDbtRunTerminalEvent(
  runId: string,
  retry?: DbtRunEmitRetry,
): Promise<void> {
  await emitWithRetry(
    "dbt run notification event",
    runId,
    async () => {
      const data = await buildDbtRunTerminalEvent(runId);
      if (!data) return;
      await inngest.send({
        id: dbtRunTerminalEventId(data.runId),
        name: "flow.run.terminal",
        data,
      });
    },
    retry,
  );
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
 * rules heard the first failure and nothing after. Retried like the run's
 * own event. Never throws.
 */
export async function emitDbtJobAutoDisabledEvent(
  runId: string,
  consecutiveFailures: number,
  retry?: DbtRunEmitRetry,
): Promise<void> {
  await emitWithRetry(
    "dbt job auto-disabled notification event",
    runId,
    async () => {
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
    },
    retry,
  );
}
