/**
 * A console's schedule: set / clear it (authored — it lives in the file's
 * front-matter, so both commit), trigger a run now, and list past runs.
 * Callers have checked the id is a valid ObjectId and the caller is a
 * workspace admin. `null` means the console does not exist.
 */
import { consolesChartsRepo } from "../../repositories/consoles-charts";
import { inngest } from "../../inngest";
import { commitConsoleState } from "../../apps/workspace-consoles.service";
import {
  getNextScheduledConsoleRunAt,
  resumedScheduledRun,
  validateScheduledConsoleSchedule,
} from "../scheduled-query-schedule.service";

/** Throws when the cron or timezone is invalid. */
export async function setConsoleSchedule(input: {
  workspaceId: string;
  consoleId: string;
  cron?: string | null;
  timezone?: string | null;
  actorUserId: string | undefined;
}) {
  const savedConsole = await consolesChartsRepo.findConsoleById(
    input.workspaceId,
    input.consoleId,
    { excludeDeleted: true },
  );
  if (!savedConsole) return null;

  const schedule = validateScheduledConsoleSchedule({
    cron: input.cron,
    timezone: input.timezone,
  });
  const nextAt = getNextScheduledConsoleRunAt(schedule);

  // Setting the schedule resumes one Mako paused (schedule-pause.ts).
  const scheduledRun = resumedScheduledRun(savedConsole.scheduledRun, nextAt);
  const nextRow = {
    ...savedConsole,
    schedule,
    scheduledRun,
    isSaved: true,
  };
  // The schedule is authored: it lives in the file's front-matter.
  const committed = await commitConsoleState({
    row: nextRow,
    previousPath: savedConsole.path,
    actorUserId: input.actorUserId,
    message: `schedule: ${savedConsole.name}`,
  });

  await consolesChartsRepo.updateConsole(input.workspaceId, savedConsole.id, {
    schedule,
    scheduledRun,
    isSaved: true,
    path: committed.path,
    sourceBlobSha: committed.sourceBlobSha,
  });

  return {
    schedule,
    scheduledRun,
  };
}

/** False when the console does not exist. */
export async function clearConsoleSchedule(input: {
  workspaceId: string;
  consoleId: string;
  actorUserId: string | undefined;
}): Promise<boolean> {
  const current = await consolesChartsRepo.findConsoleById(
    input.workspaceId,
    input.consoleId,
  );
  if (!current) return false;
  const unscheduledSet: { path?: string; sourceBlobSha?: string } = {};
  if (current.isSaved) {
    const committed = await commitConsoleState({
      row: { ...current, schedule: undefined },
      previousPath: current.path,
      actorUserId: input.actorUserId,
      message: `unschedule: ${current.name}`,
    });
    unscheduledSet.path = committed.path;
    unscheduledSet.sourceBlobSha = committed.sourceBlobSha;
  }
  await consolesChartsRepo.clearConsoleSchedule(
    input.workspaceId,
    current.id,
    Object.keys(unscheduledSet).length ? unscheduledSet : undefined,
  );
  return true;
}

/** Queue a manual run; the Inngest event id, or null for no such console. */
export async function triggerConsoleRun(input: {
  workspaceId: string;
  consoleId: string;
  triggeredBy: string | undefined;
}) {
  const savedConsole = await consolesChartsRepo.findConsoleById(
    input.workspaceId,
    input.consoleId,
  );
  if (!savedConsole) return null;

  return inngest.send({
    name: "scheduled_query/execute",
    data: {
      workspaceId: input.workspaceId,
      consoleId: input.consoleId,
      triggerType: "manual",
      triggeredBy: input.triggeredBy,
    },
  });
}

/** Newest first, with the console's schedule state. */
export async function listScheduledRuns(input: {
  workspaceId: string;
  consoleId: string;
  limit: number;
}) {
  const [runs, consoleDoc] = await Promise.all([
    consolesChartsRepo.listScheduledQueryRuns(
      input.workspaceId,
      input.consoleId,
      input.limit,
    ),
    consolesChartsRepo.findConsoleById(input.workspaceId, input.consoleId),
  ]);

  return {
    scheduledRun: consoleDoc?.scheduledRun,
    runs: runs.map(run => ({
      id: run.id,
      triggeredAt: run.triggeredAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      status: run.status,
      triggerType: run.triggerType,
      triggeredBy: run.triggeredBy,
      durationMs: run.durationMs,
      rowsAffected: run.rowsAffected,
      rowCount: run.rowCount,
      error: run.error,
      inngestRunId: run.inngestRunId,
    })),
  };
}
