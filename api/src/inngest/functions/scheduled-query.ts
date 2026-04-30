import { Types } from "mongoose";
import { inngest } from "../client";
import {
  DatabaseConnection,
  type IDatabaseConnection,
  type ISavedConsole,
  SavedConsole,
  ScheduledQueryRun,
} from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import { queryExecutionService } from "../../services/query-execution.service";
import { loggers } from "../../logging";
import { getNextScheduledConsoleRunAt } from "../../services/scheduled-query-schedule.service";

const logger = loggers.inngest();

function mapConsoleLanguageToQueryLanguage(
  language: "sql" | "javascript" | "mongodb",
): "sql" | "javascript" | "mongodb" {
  if (language === "mongodb") return "mongodb";
  if (language === "javascript") return "javascript";
  return "sql";
}

export const scheduledQuerySchedulerFunction = inngest.createFunction(
  {
    id: "scheduled-query-scheduler",
    name: "Run Scheduled Queries",
  },
  { cron: "*/1 * * * *" },
  async ({ step }) => {
    const now = new Date();

    const dueConsoles = await step.run(
      "fetch-due-scheduled-queries",
      async () => {
        const consoles = await SavedConsole.find({
          "schedule.cron": { $exists: true, $ne: "" },
          "scheduledRun.nextAt": { $lte: now },
          isSaved: true,
          $or: [
            { is_deleted: { $ne: true } },
            { is_deleted: { $exists: false } },
          ],
        })
          .select("_id workspaceId schedule scheduledRun")
          .lean();

        return consoles.map(consoleDoc => ({
          id: consoleDoc._id.toString(),
          workspaceId: consoleDoc.workspaceId.toString(),
          nextAt: consoleDoc.scheduledRun?.nextAt ?? null,
          schedule: consoleDoc.schedule,
        }));
      },
    );

    for (const consoleDoc of dueConsoles) {
      if (!consoleDoc.schedule?.cron || !consoleDoc.schedule?.timezone) {
        continue;
      }

      const nextAt = getNextScheduledConsoleRunAt(consoleDoc.schedule, now);
      const updateResult = await step.run(
        `claim-${consoleDoc.id}-${consoleDoc.nextAt?.toString() ?? "none"}`,
        async () =>
          SavedConsole.updateOne(
            {
              _id: new Types.ObjectId(consoleDoc.id),
              "scheduledRun.nextAt": consoleDoc.nextAt,
            },
            {
              $set: {
                "scheduledRun.nextAt": nextAt,
              },
            },
          ),
      );

      if (updateResult.modifiedCount === 0) {
        continue;
      }

      await inngest.send({
        name: "scheduled_query/execute",
        data: {
          workspaceId: consoleDoc.workspaceId,
          consoleId: consoleDoc.id,
          triggerType: "schedule",
        },
      });
    }

    return { checked: dueConsoles.length };
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
  },
  { event: "scheduled_query/execute" },
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
      const consoleDoc = (await step.run("load-console", async () => {
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

        const connectionMongooseDoc = savedConsole.connectionId
          ? await DatabaseConnection.findById(savedConsole.connectionId)
          : null;

        if (!connectionMongooseDoc) {
          throw new Error("Scheduled console has no database connection");
        }

        const connection = connectionMongooseDoc.toObject({
          getters: true,
        }) as IDatabaseConnection;

        return {
          savedConsole,
          connection,
        };
      })) as {
        savedConsole: ISavedConsole;
        connection: IDatabaseConnection;
      };

      const executionStartedAt = Date.now();
      const result = await step.run("execute-query", async () =>
        databaseConnectionService.executeQuery(
          consoleDoc.connection,
          consoleDoc.savedConsole.code,
          {
            databaseId: consoleDoc.savedConsole.databaseId,
            databaseName: consoleDoc.savedConsole.databaseName,
          },
        ),
      );

      const completedAt = new Date();
      const durationMs = Date.now() - executionStartedAt;
      const rowCount =
        result.rowCount ??
        (Array.isArray(result.data) ? result.data.length : undefined);
      const status = result.success ? "success" : "error";
      const errorMessage = result.success
        ? undefined
        : result.error || "Unknown error";

      await step.run("finalize-run", async () => {
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

        await SavedConsole.updateOne(
          { _id: new Types.ObjectId(consoleId) },
          status === "error"
            ? {
                $set: {
                  "scheduledRun.lastAt": completedAt,
                  "scheduledRun.lastStatus": status,
                  "scheduledRun.lastError": errorMessage,
                  "scheduledRun.lastDurationMs": durationMs,
                  "scheduledRun.lastRowCount": rowCount,
                  ...(nextAt ? { "scheduledRun.nextAt": nextAt } : {}),
                },
                $inc: {
                  "scheduledRun.runCount": 1,
                  "scheduledRun.consecutiveFailures": 1,
                },
              }
            : {
                $set: {
                  "scheduledRun.lastAt": completedAt,
                  "scheduledRun.lastStatus": status,
                  "scheduledRun.lastError": errorMessage,
                  "scheduledRun.lastDurationMs": durationMs,
                  "scheduledRun.lastRowCount": rowCount,
                  "scheduledRun.consecutiveFailures": 0,
                  ...(nextAt ? { "scheduledRun.nextAt": nextAt } : {}),
                },
                $inc: {
                  "scheduledRun.runCount": 1,
                },
              },
        );
      });
      isFinalized = true;

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
      await step.run("finalize-run-error", async () => {
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
        await SavedConsole.updateOne(
          { _id: new Types.ObjectId(consoleId) },
          {
            $set: {
              "scheduledRun.lastAt": completedAt,
              "scheduledRun.lastStatus": "error",
              "scheduledRun.lastError": message,
            },
            $inc: {
              "scheduledRun.runCount": 1,
              "scheduledRun.consecutiveFailures": 1,
            },
          },
        );
      });
      throw error;
    }
  },
);
