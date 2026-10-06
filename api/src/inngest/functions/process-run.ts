/**
 * Process runtime on Inngest.
 *
 * - processRunFunction: executes a run (see api/src/processes). Re-invoked by
 *   Inngest after every step; memoized steps return instantly.
 * - processSignalRedeliveryFunction: re-sends every signal ~20s later. Inngest
 *   waitForEvent has no lookback, so a signal sent in the gap between a run's
 *   "check" step and its wait registering would otherwise only be noticed at
 *   the wait's timeout.
 * - processSchedulerFunction: starts due `trigger.schedule()` runs.
 */
import { inngest } from "../client";
import { loggers } from "../../logging";
import { ensureProcessRuntime } from "../../processes";
import { executeRun } from "../../processes/runtime/executor";
import { ProcessRun } from "../../processes/runtime/models";
import {
  InngestDriver,
  MAX_STEP_RETRIES,
  PROCESS_EVENTS,
} from "../../processes/runtime/inngest-engine";
import { runDueSchedules } from "../../processes/service";

const log = loggers.inngest("process-run");

export const processRunFunction = inngest.createFunction(
  {
    id: "process-run",
    name: "Process Run",
    retries: MAX_STEP_RETRIES,
    // One execution per run at a time; runs of different processes and
    // workspaces proceed in parallel.
    concurrency: [{ key: "event.data.runId", limit: 1 }],
    cancelOn: [
      {
        event: PROCESS_EVENTS.cancel,
        if: "async.data.runId == event.data.runId",
      },
    ],
    triggers: { event: PROCESS_EVENTS.runRequested },
  },
  async ({ event, step, attempt }) => {
    ensureProcessRuntime();
    const runId = String(event.data.runId);
    const outcome = await executeRun(
      runId,
      new InngestDriver(step as never, attempt, runId),
    );
    if (outcome === "failed") {
      log.warn("Process run failed", { runId });
    }
    return { runId, outcome };
  },
);

export const processSignalRedeliveryFunction = inngest.createFunction(
  {
    id: "process-signal-redelivery",
    name: "Process Signal Redelivery",
    retries: 2,
    triggers: {
      event: PROCESS_EVENTS.signal,
      if: "event.data.redelivery != true",
    },
  },
  async ({ event, step }) => {
    await step.sleep("let-wait-register", "20s");
    const stillWaiting = await step.run("still-waiting", async () => {
      const run = await ProcessRun.findById(String(event.data.runId))
        .select("status")
        .lean();
      return run?.status === "waiting";
    });
    if (!stillWaiting) return { redelivered: false };
    await step.sendEvent("redeliver", {
      name: PROCESS_EVENTS.signal,
      data: { ...event.data, redelivery: true },
    });
    return { redelivered: true };
  },
);

export const processSchedulerFunction = inngest.createFunction(
  {
    id: "process-scheduler",
    name: "Process Scheduler",
    retries: 1,
    concurrency: { limit: 1 },
    triggers: { cron: "*/5 * * * *" },
  },
  async ({ step }) => {
    const started = await step.run("start-due-schedules", async () => {
      ensureProcessRuntime();
      return runDueSchedules();
    });
    return { started };
  },
);
