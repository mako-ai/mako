import { Types } from "mongoose";
import { inngest } from "../client";
import {
  ConnectorExecution,
  ConnectorInstance,
  UserConnector,
} from "../../database/connector-builder-schema";
import { DatabaseConnection } from "../../database/workspace-schema";
import { connectorInputSchema } from "../../connector-builder/output-schema";
import { sandboxRunner } from "../../connector-builder/sandbox-runner";
import { databaseRegistry } from "../../databases/registry";
import {
  ensureMakoMetadataTables,
  writeAllBatches,
} from "../../connector-builder/write-pipeline";
import { loggers } from "../../logging";
import { CronExpressionParser } from "cron-parser";

const logger = loggers.inngest("user-connector");

interface LoadedInstance {
  _id: string;
  connectorId: string;
  secrets: Record<string, unknown>;
  config: Record<string, unknown>;
  state: Record<string, unknown>;
  output?: {
    destinationDatabaseId?: string;
    destinationSchema?: string;
    destinationTablePrefix?: string;
    evolutionMode?: "strict" | "append" | "variant" | "relaxed";
  };
  lastRunAt?: Date;
  workspaceId?: string;
}

interface LoadedConnector {
  _id: string;
  name: string;
  bundle: {
    js: string;
    sourceMap?: string;
  };
}

interface LoadedExecution {
  _id: string;
  startedAt: string;
}

export const userConnectorFlowFunction = inngest.createFunction(
  {
    id: "user-connector-execute",
    name: "User Connector Execute",
    concurrency: [{ limit: 1, key: "event.data.instanceId" }],
    retries: 2,
    cancelOn: [
      {
        event: "user-connector.cancel",
        match: "data.instanceId",
      },
    ],
  },
  { event: "user-connector.execute" },
  async ({ event, step }) => {
    const { instanceId, workspaceId, trigger } = event.data as {
      instanceId: string;
      workspaceId: string;
      trigger?: { type?: "manual" | "schedule" | "webhook"; payload?: unknown };
    };

    const instance = (await step.run("load-instance", async () => {
      const record = await ConnectorInstance.findOne({
        _id: new Types.ObjectId(instanceId),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!record) {
        throw new Error(`Connector instance ${instanceId} not found`);
      }

      return record.toObject() as unknown as LoadedInstance;
    })) as LoadedInstance;

    const connector = (await step.run("load-connector", async () => {
      const record = await UserConnector.findById(instance.connectorId);
      if (!record || !record.bundle.js) {
        throw new Error(
          `Connector ${String(instance.connectorId)} is not built`,
        );
      }
      return record.toObject() as unknown as LoadedConnector;
    })) as LoadedConnector;

    const execution = (await step.run("create-execution", async () => {
      const created = await ConnectorExecution.create({
        workspaceId: new Types.ObjectId(workspaceId),
        connectorId: new Types.ObjectId(instance.connectorId),
        instanceId: new Types.ObjectId(instanceId),
        triggerType: trigger?.type || "manual",
        status: "running",
        startedAt: new Date(),
        logs: [],
      });

      await ConnectorInstance.findByIdAndUpdate(instanceId, {
        $set: {
          status: "running",
          lastRunAt: new Date(),
          lastError: undefined,
        },
      });

      return created.toObject() as unknown as LoadedExecution;
    })) as LoadedExecution;

    let currentState = (instance.state as Record<string, unknown>) || {};
    let hasMore = true;
    let chunkIndex = 0;
    let totalRows = 0;
    let runtime: "e2b" | "local-fallback" | undefined;
    const collectedLogs: Array<{
      level: string;
      message: string;
      timestamp?: Date;
    }> = [];

    try {
      while (hasMore && chunkIndex < 100) {
        const chunkResult = await step.run(`chunk-${chunkIndex}`, async () => {
          const parsedInput = connectorInputSchema.parse({
            config: instance.config,
            secrets: instance.secrets,
            state: currentState,
            trigger: trigger || { type: "manual" },
            metadata: {
              workspaceId,
              connectorId: String(instance.connectorId),
              instanceId,
              chunkIndex,
            },
          });

          return sandboxRunner.execute(connector.bundle.js, parsedInput);
        });

        if (chunkResult.error || !chunkResult.output) {
          throw new Error(chunkResult.error || "Connector execution failed");
        }

        const chunkOutput = chunkResult.output;
        runtime = chunkResult.runtime;
        currentState = chunkOutput.state || {};
        hasMore = chunkOutput.hasMore || false;
        totalRows += chunkOutput.batches.reduce(
          (sum, batch) => sum + batch.rows.length,
          0,
        );
        collectedLogs.push(
          ...chunkResult.logs.map(log => ({
            level: log.level,
            message: log.message,
            timestamp: log.timestamp ? new Date(log.timestamp) : undefined,
          })),
        );

        await step.run(`checkpoint-${chunkIndex}`, async () => {
          await ConnectorInstance.findByIdAndUpdate(instanceId, {
            $set: {
              state: currentState,
            },
          });
        });

        if (
          instance.output?.destinationDatabaseId &&
          chunkOutput.batches.length > 0
        ) {
          await step.run(`write-${chunkIndex}`, async () => {
            const outputConfig = instance.output;
            if (!outputConfig) {
              throw new Error("Missing instance output configuration");
            }
            const destination = await DatabaseConnection.findById(
              outputConfig.destinationDatabaseId,
            );
            if (!destination) {
              throw new Error("Destination database not found");
            }

            const driver = databaseRegistry.getDriver(destination.type);
            if (!driver) {
              throw new Error(`No driver registered for ${destination.type}`);
            }

            await ensureMakoMetadataTables(
              driver,
              destination.toObject(),
              destination.type,
              outputConfig.destinationSchema || "public",
            );

            await writeAllBatches(chunkOutput.batches, {
              driver,
              database: destination.toObject(),
              driverType: destination.type,
              schema: outputConfig.destinationSchema || "public",
              tablePrefix: outputConfig.destinationTablePrefix,
              evolutionMode:
                (outputConfig.evolutionMode as
                  | "append"
                  | "strict"
                  | "variant"
                  | "relaxed") || "append",
            });
          });
        }

        chunkIndex += 1;
      }

      await step.run("complete-execution", async () => {
        await ConnectorExecution.findByIdAndUpdate(execution._id, {
          $set: {
            status: "completed",
            runtime,
            completedAt: new Date(),
            durationMs: Date.now() - new Date(execution.startedAt).getTime(),
            rowCount: totalRows,
            logs: collectedLogs,
            metadata: {
              chunks: chunkIndex,
              hasMore,
            },
          },
        });

        await ConnectorInstance.findByIdAndUpdate(instanceId, {
          $set: {
            status: "active",
            state: currentState,
            lastSuccessAt: new Date(),
            lastError: undefined,
          },
        });
      });

      return {
        success: true,
        executionId: String(execution._id),
        instanceId,
        totalRows,
        chunks: chunkIndex,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("User connector execution failed", {
        error,
        instanceId,
        workspaceId,
      });

      await step.run("fail-execution", async () => {
        await ConnectorExecution.findByIdAndUpdate(execution._id, {
          $set: {
            status: "failed",
            runtime,
            completedAt: new Date(),
            durationMs: Date.now() - new Date(execution.startedAt).getTime(),
            rowCount: totalRows,
            logs: collectedLogs,
            error: {
              message,
              stack: error instanceof Error ? error.stack : undefined,
            },
          },
        });

        await ConnectorInstance.findByIdAndUpdate(instanceId, {
          $set: {
            status: "error",
            lastError: message,
          },
        });
      });

      throw error;
    }
  },
);

export const userConnectorSchedulerFunction = inngest.createFunction(
  {
    id: "user-connector-scheduler",
    name: "User Connector Scheduler",
  },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const dueInstances = (await step.run(
      "find-due-user-connectors",
      async () => {
        const instances = await ConnectorInstance.find({
          status: { $ne: "disabled" },
          triggers: {
            $elemMatch: {
              type: "schedule",
              enabled: true,
            },
          },
        }).lean();

        const now = new Date();
        const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

        return instances.filter(instance => {
          const scheduleTrigger = instance.triggers.find(
            trigger =>
              trigger.type === "schedule" && trigger.enabled && trigger.cron,
          );
          if (!scheduleTrigger?.cron) {
            return false;
          }

          try {
            const interval = CronExpressionParser.parse(scheduleTrigger.cron, {
              tz: scheduleTrigger.timezone || "UTC",
            });
            const previousDate = interval.prev().toDate();
            if (previousDate < fiveMinutesAgo) {
              return false;
            }

            if (instance.lastRunAt && instance.lastRunAt >= fiveMinutesAgo) {
              return false;
            }

            return true;
          } catch {
            return false;
          }
        }) as unknown as Array<LoadedInstance & { workspaceId: string }>;
      },
    )) as Array<LoadedInstance & { workspaceId: string }>;

    if (dueInstances.length === 0) {
      return { dispatched: 0 };
    }

    const events = dueInstances.map(
      (instance: LoadedInstance & { workspaceId: string }) => ({
        name: "user-connector.execute" as const,
        data: {
          instanceId: instance._id,
          workspaceId: instance.workspaceId,
          trigger: { type: "schedule" as const },
        },
      }),
    );

    await step.run("dispatch-user-connectors", async () => {
      await inngest.send(events);
    });

    return { dispatched: events.length };
  },
);

export const cancelUserConnectorFunction = inngest.createFunction(
  {
    id: "user-connector-cancel",
    name: "User Connector Cancel",
  },
  { event: "user-connector.cancel" },
  async ({ event, step }) => {
    const { instanceId } = event.data as { instanceId: string };

    await step.run("mark-user-connector-cancelled", async () => {
      await ConnectorInstance.findByIdAndUpdate(instanceId, {
        $set: {
          status: "disabled",
          lastError: "Cancelled by user",
        },
      });

      await ConnectorExecution.findOneAndUpdate(
        {
          instanceId: new Types.ObjectId(instanceId),
          status: "running",
        },
        {
          $set: {
            status: "cancelled",
            completedAt: new Date(),
          },
        },
        { sort: { startedAt: -1 } },
      );
    });

    return { cancelled: true, instanceId };
  },
);
