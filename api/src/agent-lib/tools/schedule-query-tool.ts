import { Types } from "mongoose";
import { tool } from "ai";
import { z } from "zod";
import { consolesChartsRepo } from "../../repositories/consoles-charts";
import {
  getNextScheduledConsoleRunAt,
  resumedScheduledRun,
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

  return {
    schedule_query: tool({
      description:
        "Schedule an existing saved console to run automatically on a cron (standard 5-field expression) in an IANA timezone. Replaces any existing schedule on that console. Requires a saved console id (from open tabs or search); the console must have a database connection. Only call after the user explicitly confirms they want this schedule.",
      inputSchema: scheduleQueryInputSchema,
      execute: async input => {
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

          const savedConsole = await consolesChartsRepo.findConsoleById(
            workspaceId,
            consoleId,
            { excludeDeleted: true },
          );

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

          // Setting the schedule resumes one Mako paused.
          const scheduledRun = resumedScheduledRun(
            savedConsole.scheduledRun,
            nextAt,
          );
          await consolesChartsRepo.updateConsole(workspaceId, savedConsole.id, {
            schedule,
            scheduledRun,
            isSaved: true,
          });

          return {
            success: true,
            consoleId: savedConsole.id,
            name: savedConsole.name,
            schedule,
            nextAt: scheduledRun.nextAt?.toISOString?.() ?? null,
            scheduledRun,
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
    }),
  };
}
