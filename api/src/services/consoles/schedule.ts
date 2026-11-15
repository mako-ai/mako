/**
 * A console's schedule: set / clear it (authored — it lives in the file's
 * front-matter, so both commit), trigger a run now, and list past runs.
 * Callers have checked the id is a valid ObjectId and the caller is a
 * workspace admin. `null` means the console does not exist.
 */
import { Types } from "mongoose";
import {
  SavedConsole,
  ScheduledQueryRun,
} from "../../database/workspace-schema";
import { inngest } from "../../inngest";
import { commitConsoleState } from "../../apps/workspace-consoles.service";
import {
  getNextScheduledConsoleRunAt,
  validateScheduledConsoleSchedule,
} from "../scheduled-query-schedule.service";

function inWorkspace(workspaceId: string, consoleId: string) {
  return {
    _id: new Types.ObjectId(consoleId),
    workspaceId: new Types.ObjectId(workspaceId),
  };
}

/** Throws when the cron or timezone is invalid. */
export async function setConsoleSchedule(input: {
  workspaceId: string;
  consoleId: string;
  cron?: string | null;
  timezone?: string | null;
  actorUserId: string | undefined;
}) {
  const savedConsole = await SavedConsole.findOne({
    ...inWorkspace(input.workspaceId, input.consoleId),
    $or: [{ is_deleted: { $ne: true } }, { is_deleted: { $exists: false } }],
  });
  if (!savedConsole) return null;

  const schedule = validateScheduledConsoleSchedule({
    cron: input.cron,
    timezone: input.timezone,
  });
  const nextAt = getNextScheduledConsoleRunAt(schedule);
  const previous = savedConsole.scheduledRun;

  savedConsole.schedule = schedule;
  savedConsole.scheduledRun = {
    nextAt,
    lastAt: previous?.lastAt,
    lastStatus: previous?.lastStatus,
    lastError: previous?.lastError,
    lastDurationMs: previous?.lastDurationMs,
    lastRowsAffected: previous?.lastRowsAffected,
    lastRowCount: previous?.lastRowCount,
    runCount: previous?.runCount ?? 0,
    consecutiveFailures: previous?.consecutiveFailures ?? 0,
  };
  savedConsole.isSaved = true;
  // The schedule is authored: it lives in the file's front-matter.
  const committed = await commitConsoleState({
    row: savedConsole,
    previousPath: savedConsole.path,
    actorUserId: input.actorUserId,
    message: `schedule: ${savedConsole.name}`,
  });
  savedConsole.path = committed.path;
  savedConsole.sourceBlobSha = committed.sourceBlobSha;
  await savedConsole.save();

  return {
    schedule: savedConsole.schedule,
    scheduledRun: savedConsole.scheduledRun,
  };
}

/** False when the console does not exist. */
export async function clearConsoleSchedule(input: {
  workspaceId: string;
  consoleId: string;
  actorUserId: string | undefined;
}): Promise<boolean> {
  const current = await SavedConsole.findOne(
    inWorkspace(input.workspaceId, input.consoleId),
  );
  if (!current) return false;
  const unscheduledSet: Record<string, unknown> = {};
  if (current.isSaved) {
    current.schedule = undefined;
    const committed = await commitConsoleState({
      row: current,
      previousPath: current.path,
      actorUserId: input.actorUserId,
      message: `unschedule: ${current.name}`,
    });
    unscheduledSet.path = committed.path;
    unscheduledSet.sourceBlobSha = committed.sourceBlobSha;
  }
  await SavedConsole.updateOne(
    { _id: current._id },
    {
      ...(Object.keys(unscheduledSet).length ? { $set: unscheduledSet } : {}),
      $unset: {
        schedule: 1,
        "scheduledRun.nextAt": 1,
      },
    },
  );
  return true;
}

/** Queue a manual run; the Inngest event id, or null for no such console. */
export async function triggerConsoleRun(input: {
  workspaceId: string;
  consoleId: string;
  triggeredBy: string | undefined;
}) {
  const savedConsole = await SavedConsole.findOne(
    inWorkspace(input.workspaceId, input.consoleId),
  ).select("_id");
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
  const workspaceObjectId = new Types.ObjectId(input.workspaceId);
  const consoleObjectId = new Types.ObjectId(input.consoleId);

  const [runs, consoleDoc] = await Promise.all([
    ScheduledQueryRun.find({
      workspaceId: workspaceObjectId,
      consoleId: consoleObjectId,
    })
      .sort({ triggeredAt: -1 })
      .limit(input.limit)
      .lean(),
    SavedConsole.findOne({
      _id: consoleObjectId,
      workspaceId: workspaceObjectId,
    })
      .select("scheduledRun")
      .lean(),
  ]);

  return {
    scheduledRun: consoleDoc?.scheduledRun,
    runs: runs.map(run => ({
      id: run._id.toString(),
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
