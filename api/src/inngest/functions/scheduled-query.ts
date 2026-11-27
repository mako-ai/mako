import { Types } from "mongoose";
import {
  claimDueScheduledRuns,
  scheduledRunEventId,
} from "../../services/scheduled-run-claim";
import { inngest } from "../client";
import {
  type IDatabaseConnection,
  type ISavedConsole,
  SavedConsole,
  ScheduledQueryRun,
} from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import { queryExecutionService } from "../../services/query-execution.service";
import { loggers } from "../../logging";
import { getNextScheduledConsoleRunAt } from "../../services/scheduled-query-schedule.service";
import {
  notifyScheduledRunOutcome,
  recordScheduledRunOutcome,
} from "../../services/consoles/schedule-pause";
import { liveConsoleCode } from "../../apps/workspace-consoles.service";
import { mapConsoleLanguageToQueryLanguage } from "../../services/console-execution.service";
import { findWorkspaceConnection } from "../../services/consoles/connection-scope";

const logger = loggers.inngest();

/**
 * The console a scheduled run executes, with its database connection. The
 * connection is loaded with the console's workspace in the filter: a
 * connectionId that names another workspace's database (a pushed
 * front-matter line, an old row) fails the run instead of running there.
 */
export async function loadScheduledConsole(
  workspaceId: string,
  consoleId: string,
): Promise<{ savedConsole: ISavedConsole; connection: IDatabaseConnection }> {
  const savedConsoleDoc = await SavedConsole.findOne({
    _id: new Types.ObjectId(consoleId),
    workspaceId: new Types.ObjectId(workspaceId),
  });

  if (!savedConsoleDoc) {
    throw new Error("Scheduled console not found");
  }

  const savedConsole = savedConsoleDoc.toObject({
    getters: true,
  }) as ISavedConsole;
  // Git is the definition: run the file at main, not the row's last
  // pushed copy.
  const liveCode = await liveConsoleCode(workspaceId, consoleId);
  if (liveCode) savedConsole.code = liveCode.code;

  if (!savedConsole.connectionId) {
    throw new Error("Scheduled console has no database connection");
  }

  const connectionRecord = await findWorkspaceConnection(
    savedConsoleDoc.workspaceId,
    savedConsole.connectionId,
  );
  if (!connectionRecord) {
    logger.warn(
      "Scheduled console points at a connection outside its workspace",
      {
        workspaceId,
        consoleId,
        connectionId: String(savedConsole.connectionId),
      },
    );
    throw new Error(
      "Scheduled console's database connection is not in this workspace; refusing to run",
    );
  }

  const connection = connectionRecord as unknown as IDatabaseConnection;

  return { savedConsole, connection };
}

export const scheduledQuerySchedulerFunction = inngest.createFunction(
  {
    id: "scheduled-query-scheduler",
    name: "Run Scheduled Queries",
    // One scan at a time (it runs every minute); the claims make overlap
    // safe, this keeps a slow scan from stacking up behind itself.
    concurrency: { limit: 1 },
    retries: 3,
    triggers: { cron: "*/1 * * * *" },
  },
  async ({ step }) => {
    // Fetch + claim in one step (not one step per console, which hits the
    // per-run step limit), with `now` read inside it so a replay sees the
    // memoized value.
    const claimed = await step.run("claim-due-scheduled-queries", () =>
      claimDueScheduledRuns(SavedConsole, new Date(), {
        isSaved: true,
        $or: [
          { is_deleted: { $ne: true } },
          { is_deleted: { $exists: false } },
        ],
      }),
    );

    if (claimed.length > 0) {
      // Through step.sendEvent (memoized) with an id per claimed
      // occurrence: a retry of this function cannot re-send.
      await step.sendEvent(
        "dispatch-scheduled-queries",
        claimed.map(consoleDoc => ({
          id: scheduledRunEventId("scheduled-query", consoleDoc),
          name: "scheduled_query/execute",
          data: {
            workspaceId: consoleDoc.workspaceId,
            consoleId: consoleDoc.id,
            triggerType: "schedule",
          },
        })),
      );
    }

    return { dispatched: claimed.length };
  },
);

export const scheduledQueryExecutorFunction = inngest.createFunction(
  {
    id: "scheduled-query-executor",
    name: "Execute Scheduled Query",
    retries: 0,
    concurrency: {
      key: "event.data.consoleId",
      limit: 1,
    },
    triggers: { event: "scheduled_query/execute" },
  },
  async ({ event, step }) => {
    const workspaceId = String(event.data.workspaceId);
    const consoleId = String(event.data.consoleId);
    const triggerType =
      event.data.triggerType === "manual" ? "manual" : "schedule";
    const triggeredBy =
      typeof event.data.triggeredBy === "string"
        ? event.data.triggeredBy
        : undefined;

    const run = await step.run("create-run", async () => {
      const created = await ScheduledQueryRun.create({
        workspaceId: new Types.ObjectId(workspaceId),
        consoleId: new Types.ObjectId(consoleId),
        triggeredAt: new Date(),
        status: "queued",
        triggerType,
        triggeredBy,
        inngestRunId: event.id,
      });

      return { id: created._id.toString() };
    });

    const startedAt = new Date();
    let isFinalized = false;
    await step.run("mark-running", async () => {
      await ScheduledQueryRun.updateOne(
        { _id: new Types.ObjectId(run.id) },
        { $set: { status: "running", startedAt } },
      );
    });

    try {
      const consoleDoc = (await step.run("load-console", () =>
        loadScheduledConsole(workspaceId, consoleId),
      )) as unknown as {
        savedConsole: ISavedConsole;
        connection: IDatabaseConnection;
      };

      const execution = await step.run("execute-query", async () => {
        const executionStartedAt = Date.now();
        const result = await databaseConnectionService.executeQuery(
          consoleDoc.connection,
          consoleDoc.savedConsole.code,
          {
            databaseId: consoleDoc.savedConsole.databaseId,
            databaseName: consoleDoc.savedConsole.databaseName,
            // A schedule writes as the console's owner, not as the system.
            actor: consoleDoc.savedConsole.createdBy
              ? `user:${consoleDoc.savedConsole.createdBy}`
              : undefined,
            labels: {
              mako_source: "scheduled_query",
              mako_console: consoleId,
              mako_trigger: "scheduler",
              mako_user: consoleDoc.savedConsole.createdBy,
              mako_workspace: workspaceId,
            },
          },
        );

        return {
          result,
          durationMs: Date.now() - executionStartedAt,
        };
      });

      const completedAt = new Date();
      const { result, durationMs } = execution;
      const rowCount =
        result.rowCount ??
        (Array.isArray(result.data) ? result.data.length : undefined);
      const status = result.success ? "success" : "error";
      const errorMessage = result.success
        ? undefined
        : result.error || "Unknown error";

      const outcome = await step.run("finalize-run", async () => {
        await ScheduledQueryRun.updateOne(
          { _id: new Types.ObjectId(run.id) },
          {
            $set: {
              status,
              completedAt,
              durationMs,
              rowCount,
              error: errorMessage ? { message: errorMessage } : undefined,
            },
          },
        );

        const nextAt =
          consoleDoc.savedConsole.schedule?.cron &&
          consoleDoc.savedConsole.schedule?.timezone
            ? getNextScheduledConsoleRunAt(
                {
                  cron: consoleDoc.savedConsole.schedule.cron,
                  timezone: consoleDoc.savedConsole.schedule.timezone,
                },
                completedAt,
              )
            : undefined;

        // A permanent failure (a write refusal) repeated pauses the
        // schedule and notifies once (schedule-pause.ts).
        return recordScheduledRunOutcome({
          consoleId,
          error: errorMessage,
          now: completedAt,
          fields: {
            "scheduledRun.lastAt": completedAt,
            "scheduledRun.lastStatus": status,
            "scheduledRun.lastError": errorMessage,
            "scheduledRun.lastDurationMs": durationMs,
            "scheduledRun.lastRowCount": rowCount,
            ...(nextAt ? { "scheduledRun.nextAt": nextAt } : {}),
          },
        });
      });
      isFinalized = true;

      await step.run("emit-scheduled-query-terminal-notification", async () => {
        await notifyScheduledRunOutcome(outcome, {
          workspaceId,
          consoleId,
          runId: run.id,
          triggerType,
        });
      });

      queryExecutionService.track({
        userId: triggeredBy || consoleDoc.savedConsole.createdBy,
        workspaceId: consoleDoc.savedConsole.workspaceId,
        connectionId: consoleDoc.connection._id,
        databaseName:
          consoleDoc.savedConsole.databaseName ||
          consoleDoc.connection.connection.database,
        consoleId: consoleDoc.savedConsole._id,
        source: "scheduled_query",
        databaseType: consoleDoc.connection.type,
        queryLanguage: mapConsoleLanguageToQueryLanguage(
          consoleDoc.savedConsole.language,
        ),
        status: status === "error" ? "error" : "success",
        executionTimeMs: durationMs,
        rowCount,
        errorType: status === "error" ? "unknown" : undefined,
      });

      if (!result.success) {
        logger.error("Scheduled query execution failed", {
          consoleId,
          workspaceId,
          error: result.error,
        });
        throw new Error(result.error || "Scheduled query execution failed");
      }

      return {
        runId: run.id,
        consoleId,
        workspaceId,
        rowCount,
        durationMs,
      };
    } catch (error) {
      if (isFinalized) {
        throw error;
      }
      const outcome = await step.run("finalize-run-error", async () => {
        const completedAt = new Date();
        const message =
          error instanceof Error ? error.message : "Scheduled query failed";
        await ScheduledQueryRun.updateOne(
          { _id: new Types.ObjectId(run.id) },
          {
            $set: {
              status: "error",
              completedAt,
              error: { message },
            },
          },
        );
        return recordScheduledRunOutcome({
          consoleId,
          error: message,
          now: completedAt,
          fields: { "scheduledRun.lastAt": completedAt },
        });
      });
      await step.run(
        "emit-scheduled-query-terminal-notification-error",
        async () => {
          await notifyScheduledRunOutcome(outcome, {
            workspaceId,
            consoleId,
            runId: run.id,
            triggerType,
          });
        },
      );
      throw error;
    }
  },
);
