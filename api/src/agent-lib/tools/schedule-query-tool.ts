import { Types } from "mongoose";
import { z } from "zod";
import { SavedConsole } from "../../database/workspace-schema";
import {
  getNextScheduledConsoleRunAt,
  validateScheduledConsoleSchedule,
} from "../../services/scheduled-query-schedule.service";

export interface ScheduleQueryToolOptions {
  workspaceId: string;
  /** Mirrors HTTP `PUT .../schedule`: owner/admin, or API key (workspace-scoped). */
  canManageScheduledQueries: boolean;
}

const scheduleQueryInputSchema = z.object({
  consoleId: z.string().describe("The _id of the SavedConsole to schedule."),
  cron: z.string().describe("5-field cron expression, e.g. '0 9 * * 1-5'."),
  timezone: z
    .string()
    .optional()
    .describe("IANA timezone name, e.g. 'America/New_York'. Defaults to UTC."),
});

export function createScheduleQueryTool(options: ScheduleQueryToolOptions) {
  const { workspaceId, canManageScheduledQueries } = options;
  const wsOid = new Types.ObjectId(workspaceId);

  return {
    schedule_query: {
      description:
        "Schedule an existing saved console to run automatically on a cron (standard 5-field expression) in an IANA timezone. Replaces any existing schedule on that console. Requires a saved console id (from open tabs or search); the console must have a database connection. Only call after the user explicitly confirms they want this schedule.",
      inputSchema: scheduleQueryInputSchema,
      execute: async (input: z.infer<typeof scheduleQueryInputSchema>) => {
        try {
          if (!canManageScheduledQueries) {
            return {
              success: false,
              error:
                "Admin access required for scheduled queries (workspace owner or admin), or use a workspace API key.",
            };
          }

          const { consoleId, cron, timezone } = input;

          if (!Types.ObjectId.isValid(consoleId)) {
            return {
              success: false,
              error: "INVALID_CONSOLE_ID",
            };
          }

          const savedConsole = await SavedConsole.findOne({
            _id: new Types.ObjectId(consoleId),
            workspaceId: wsOid,
            $or: [{ is_deleted: { $ne: true } }, { is_deleted: { $exists: false } }],
          });

          if (!savedConsole) {
            return {
              success: false,
              error: "CONSOLE_NOT_FOUND",
            };
          }

          if (!savedConsole.connectionId) {
            return {
              success: false,
              error:
                "MISSING_CONNECTION: bind a database connection to this console (e.g. set_console_connection) before scheduling.",
            };
          }

          const schedule = validateScheduledConsoleSchedule({
            cron,
            timezone: timezone ?? "UTC",
          });
          const nextAt = getNextScheduledConsoleRunAt(schedule);

          savedConsole.schedule = schedule;
          savedConsole.scheduledRun = {
            nextAt,
            lastAt: savedConsole.scheduledRun?.lastAt,
            lastStatus: savedConsole.scheduledRun?.lastStatus,
            lastError: savedConsole.scheduledRun?.lastError,
            lastDurationMs: savedConsole.scheduledRun?.lastDurationMs,
            lastRowsAffected: savedConsole.scheduledRun?.lastRowsAffected,
            lastRowCount: savedConsole.scheduledRun?.lastRowCount,
            runCount: savedConsole.scheduledRun?.runCount ?? 0,
            consecutiveFailures:
              savedConsole.scheduledRun?.consecutiveFailures ?? 0,
          };
          savedConsole.isSaved = true;
          await savedConsole.save();

          return {
            success: true,
            consoleId: savedConsole._id.toString(),
            name: savedConsole.name,
            schedule: savedConsole.schedule,
            nextAt: savedConsole.scheduledRun?.nextAt?.toISOString?.() ?? null,
            scheduledRun: savedConsole.scheduledRun,
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to schedule console query",
          };
        }
      },
    },
  };
}
