import { inngest } from "../client";
import {
  UserConnector,
  ConnectorInstance,
} from "../../database/connector-builder-schema";
import { executeConnector } from "../../connector-builder/sandbox-runner";
import { connectorInputSchema } from "../../connector-builder/output-schema";
import { Types } from "mongoose";
import { CronExpressionParser } from "cron-parser";
import { loggers } from "../../logging";

const logger = loggers.inngest("user-connector");

/**
 * Main user connector execution function.
 * Implements the chunked execution loop:
 * load -> load-connector -> loop (chunk-N -> write-N -> checkpoint-N) until !hasMore
 */
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
    const { instanceId, workspaceId, trigger } = event.data;

    // Step 1: Load instance
    const instance = await step.run("load-instance", async () => {
      const inst = await ConnectorInstance.findOne({
        _id: new Types.ObjectId(instanceId),
        workspaceId: new Types.ObjectId(workspaceId),
      }).lean();

      if (!inst) {
        throw new Error(`ConnectorInstance ${instanceId} not found`);
      }

      return {
        _id: inst._id.toString(),
        connectorId: inst.connectorId.toString(),
        secrets: inst.secrets,
        config: inst.config,
        state: inst.state,
        output: inst.output,
      };
    });

    // Step 2: Load connector and its bundle
    const connector = await step.run("load-connector", async () => {
      const conn = await UserConnector.findById(instance.connectorId).lean();
      if (!conn) {
        throw new Error(`UserConnector ${instance.connectorId} not found`);
      }
      if (!conn.bundle?.js) {
        throw new Error(
          `UserConnector ${instance.connectorId} has no built bundle`,
        );
      }
      return {
        _id: conn._id.toString(),
        name: conn.name,
        bundleJs: conn.bundle.js,
      };
    });

    // Step 3: Mark instance as running
    await step.run("mark-running", async () => {
      await ConnectorInstance.findByIdAndUpdate(instanceId, {
        $set: {
          "status.lastRunAt": new Date(),
        },
        $inc: {
          "status.runCount": 1,
        },
      });
    });

    // Step 4: Chunked execution loop
    let currentState = instance.state || {};
    let chunkIndex = 0;
    let hasMore = true;
    let totalRows = 0;
    const allBatches: Array<{
      entity: string;
      records: Record<string, unknown>[];
    }> = [];

    while (hasMore && chunkIndex < 100) {
      // Safety limit of 100 chunks
      const chunkResult = await step.run(`chunk-${chunkIndex}`, async () => {
        const input = connectorInputSchema.parse({
          config: instance.config,
          secrets: instance.secrets,
          state: currentState,
          trigger: trigger || { type: "cron" },
        });

        return executeConnector(connector.bundleJs, input);
      });

      const { output } = chunkResult;

      // Checkpoint: update state
      await step.run(`checkpoint-${chunkIndex}`, async () => {
        const newState = output.state || {};
        await ConnectorInstance.findByIdAndUpdate(instanceId, {
          $set: { state: newState },
        });
        return newState;
      });

      currentState = output.state || {};
      hasMore = output.hasMore || false;

      const chunkRows = output.batches.reduce(
        (sum, b) => sum + b.records.length,
        0,
      );
      totalRows += chunkRows;

      for (const batch of output.batches) {
        allBatches.push({
          entity: batch.entity,
          records: batch.records,
        });
      }

      logger.info("Chunk completed", {
        instanceId,
        chunkIndex,
        chunkRows,
        totalRows,
        hasMore,
      });

      chunkIndex++;
    }

    // Step 5: Mark as complete
    await step.run("mark-complete", async () => {
      await ConnectorInstance.findByIdAndUpdate(instanceId, {
        $set: {
          "status.lastSuccessAt": new Date(),
          "status.lastError": null,
          "status.consecutiveFailures": 0,
        },
      });
    });

    return {
      success: true,
      instanceId,
      connectorName: connector.name,
      chunks: chunkIndex,
      totalRows,
      entities: [...new Set(allBatches.map(b => b.entity))],
    };
  },
);

/**
 * Scheduler function that checks for instances with active cron triggers.
 * Runs every 5 minutes and dispatches execution events for due instances.
 */
export const userConnectorSchedulerFunction = inngest.createFunction(
  {
    id: "user-connector-scheduler",
    name: "User Connector Scheduler",
  },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const instances = await step.run("find-due-instances", async () => {
      const enabledInstances = await ConnectorInstance.find({
        "status.enabled": true,
        "triggers.type": "cron",
      }).lean();

      const now = new Date();
      const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

      const dueInstances: Array<{
        instanceId: string;
        workspaceId: string;
      }> = [];

      for (const inst of enabledInstances) {
        const cronTrigger = inst.triggers.find(t => t.type === "cron");
        if (!cronTrigger?.cron) continue;

        try {
          const interval = CronExpressionParser.parse(cronTrigger.cron, {
            tz: cronTrigger.timezone || "UTC",
          });

          const prevDate = interval.prev().toDate();

          // Check if the cron was due since the last check (5 minutes ago)
          if (prevDate >= fiveMinutesAgo) {
            const lastRun = inst.status.lastRunAt;
            // Skip if already ran within this window
            if (lastRun && lastRun >= fiveMinutesAgo) continue;

            dueInstances.push({
              instanceId: inst._id.toString(),
              workspaceId: inst.workspaceId.toString(),
            });
          }
        } catch (err) {
          logger.warn("Failed to parse cron expression", {
            instanceId: inst._id.toString(),
            cron: cronTrigger.cron,
            error: err,
          });
        }
      }

      return dueInstances;
    });

    // Dispatch execution events for each due instance
    if (instances.length > 0) {
      await step.run("dispatch-executions", async () => {
        const events = instances.map(inst => ({
          name: "user-connector.execute" as const,
          data: {
            instanceId: inst.instanceId,
            workspaceId: inst.workspaceId,
            trigger: { type: "cron" as const },
          },
        }));

        await inngest.send(events);

        logger.info("Dispatched user connector executions", {
          count: events.length,
        });
      });
    }

    return { dispatched: instances.length };
  },
);

/**
 * Cancel a running user connector execution.
 */
export const cancelUserConnectorFunction = inngest.createFunction(
  {
    id: "user-connector-cancel",
    name: "User Connector Cancel",
  },
  { event: "user-connector.cancel" },
  async ({ event, step }) => {
    const { instanceId } = event.data;

    await step.run("mark-cancelled", async () => {
      await ConnectorInstance.findByIdAndUpdate(instanceId, {
        $set: {
          "status.lastError": "Cancelled by user",
        },
      });
    });

    return { cancelled: true, instanceId };
  },
);
