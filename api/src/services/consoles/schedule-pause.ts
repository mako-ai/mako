/**
 * A scheduled console that fails for a reason only a person can fix (Mako
 * refused the write, the database denied permission) stops running instead
 * of failing every hour forever.
 *
 * Each run's outcome goes through recordScheduledRunOutcome. Failures with
 * one permanent cause count up in `scheduledRun.permanentFailures`. The
 * PAUSE_AFTER_PERMANENT_FAILURES-th pauses the schedule: `nextAt` is unset,
 * so the scheduler skips the console, and `pausedAt` / `pausedReason` say
 * why. The cron stays in the console's front-matter. Setting the schedule
 * again resumes it with fresh counts (resumedScheduledRun, in
 * scheduled-query-schedule.service.ts so the repo sync can import it light).
 *
 * Notices: a transient failure notifies on every run, as before. A permanent
 * cause notifies on its first failure and on the pause, never in between.
 */
import { isWriteRefusal } from "../../access/connection-writes";
import { consolesChartsRepo } from "../../repositories/consoles-charts";
import { emitScheduledQueryTerminalEvent } from "../flow-run-notification.emit";
import { classifyError } from "../console-execution.service";

export const PAUSE_AFTER_PERMANENT_FAILURES = 3;

/**
 * What a person must do about `message`, or null when the failure may
 * clear by itself (a timeout, a dropped connection) and the schedule keeps
 * running.
 */
export function permanentFailureFix(
  message: string | undefined,
): string | null {
  if (!message) return null;
  if (isWriteRefusal(message)) {
    return "Ask an admin to add the console's owner as a writer in the connection's Access tab, then resume the schedule.";
  }
  if (classifyError(message).errorType === "permission") {
    return "Ask an admin to grant the console's owner access in the database, then resume the schedule.";
  }
  return null;
}

export interface ScheduledRunOutcome {
  /** Whether this run sends the terminal run notification. */
  notify: boolean;
  /** Set when this run paused the schedule: the notice text. */
  pausedReason?: string;
}

/**
 * Write a finished run onto its console's `scheduledRun` and decide whether
 * it notifies and whether it pauses the schedule. `fields` are the other
 * `scheduledRun.*` values to set (lastAt, lastDurationMs, nextAt, …).
 */
export async function recordScheduledRunOutcome(input: {
  workspaceId?: string;
  consoleId: string;
  error?: string;
  fields: Record<string, unknown>;
  now?: Date;
}): Promise<ScheduledRunOutcome> {
  const lastAt =
    input.fields["scheduledRun.lastAt"] instanceof Date
      ? (input.fields["scheduledRun.lastAt"] as Date)
      : (input.now ?? new Date());
  const lastDurationMs =
    typeof input.fields["scheduledRun.lastDurationMs"] === "number"
      ? (input.fields["scheduledRun.lastDurationMs"] as number)
      : undefined;
  const lastRowCount =
    typeof input.fields["scheduledRun.lastRowCount"] === "number"
      ? (input.fields["scheduledRun.lastRowCount"] as number)
      : undefined;
  const lastRowsAffected =
    typeof input.fields["scheduledRun.lastRowsAffected"] === "number"
      ? (input.fields["scheduledRun.lastRowsAffected"] as number)
      : undefined;
  const nextAt =
    input.fields["scheduledRun.nextAt"] instanceof Date
      ? (input.fields["scheduledRun.nextAt"] as Date)
      : undefined;

  if (input.error === undefined) {
    let workspaceId = input.workspaceId;
    if (!workspaceId) {
      const existing = await consolesChartsRepo.findConsoleByIdGlobal(
        input.consoleId,
      );
      workspaceId = existing?.workspaceId;
    }
    if (workspaceId) {
      await consolesChartsRepo.updateConsoleScheduleOutcome({
        workspaceId,
        consoleId: input.consoleId,
        isError: false,
        lastAt,
        lastDurationMs,
        lastRowCount,
        lastRowsAffected,
        nextAt,
        permanentFailures: 0,
      });
    }
    return { notify: true };
  }

  // The executor runs one console at a time (concurrency key consoleId), so
  // read-then-write cannot race another run of the same console.
  const previous = input.workspaceId
    ? await consolesChartsRepo.findConsoleById(
        input.workspaceId,
        input.consoleId,
      )
    : await consolesChartsRepo.findConsoleByIdGlobal(input.consoleId);

  const fix = permanentFailureFix(input.error);
  const sameCause =
    fix !== null && previous?.scheduledRun?.lastError === input.error;
  const permanentFailures = fix
    ? sameCause
      ? (previous?.scheduledRun?.permanentFailures ?? 0) + 1
      : 1
    : 0;
  const pause =
    fix !== null &&
    permanentFailures >= PAUSE_AFTER_PERMANENT_FAILURES &&
    Boolean(previous?.schedule?.cron) &&
    !previous?.scheduledRun?.pausedAt;

  let pausedReason: string | undefined;
  if (pause) {
    pausedReason = `Mako paused this schedule after ${permanentFailures} runs failed the same way: ${input.error} ${fix}`;
  }

  const workspaceId = input.workspaceId ?? previous?.workspaceId;
  if (workspaceId) {
    await consolesChartsRepo.updateConsoleScheduleOutcome({
      workspaceId,
      consoleId: input.consoleId,
      isError: true,
      lastAt,
      lastDurationMs,
      lastRowCount,
      lastRowsAffected,
      nextAt: pause ? undefined : nextAt,
      clearNextAt: pause,
      // The pause notice replaces the error, so the console shows it.
      lastError: pausedReason ?? input.error,
      permanentFailures,
      pausedAt: pause ? (input.now ?? new Date()) : undefined,
      pausedReason,
    });
  }

  return { notify: !fix || permanentFailures === 1 || pause, pausedReason };
}

/** Send the run's terminal notification when the outcome says so. */
export async function notifyScheduledRunOutcome(
  outcome: ScheduledRunOutcome,
  params: {
    workspaceId: string;
    consoleId: string;
    runId: string;
    triggerType: "schedule" | "manual";
  },
): Promise<void> {
  if (!outcome.notify) return;
  await emitScheduledQueryTerminalEvent({
    ...params,
    errorMessage: outcome.pausedReason,
  });
}
