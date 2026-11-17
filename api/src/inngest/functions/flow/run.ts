/**
 * `flow` — execute one flow run (`flow.execute`). This module owns the
 * function config and the prologue every run shares (jitter, fetch,
 * destination detection, execution record); the source-specific work is in
 * `database-source.ts` / `connector-source.ts`, the failure path in
 * `failure.ts`.
 *
 * Step ids are persisted by Inngest per run; they must not change.
 */
import { inWorkspace } from "../../../utils/workspace-scope";
import { inngest } from "../../client";
import {
  DatabaseConnection,
  Flow,
  type IFlow,
} from "../../../database/workspace-schema";
import { hasCdcDestinationAdapter } from "../../../sync-cdc/adapters/registry";
import { resolveConfiguredEntities } from "../../../sync-cdc/entity-selection";
import { flowDisplayName as resolveFlowDisplayName } from "../../../services/flow-identity.service";
import { ensureFlowDerivedCache } from "../../../services/flow-sync.service";
import {
  deriveTriggerSet,
  hasScheduleTrigger,
  hasWebhookTrigger,
  LEGACY_ENGINE_REMOVED,
} from "../../../services/flow-triggers.service";
import { runConnectorSourceFlow } from "./connector-source";
import { runDatabaseSourceFlow } from "./database-source";
import { createExecutionLogger } from "./execution-logger";
import { handleFlowRunFailure } from "./failure";
import { createFlowRunContext, type FlowRunEventData } from "./run-context";

export const flowFunction = inngest.createFunction(
  {
    id: "flow",
    name: "Execute Flow",
    concurrency: {
      limit: 1, // Only one execution per flow at a time
      key: "event.data.flowId", // Prevent duplicate executions of the same flow
    },
    retries: 10,
    timeouts: {
      start: "5m",
    },
    cancelOn: [
      {
        event: "flow.cancel",
        if: "async.data.flowId == event.data.flowId",
      },
    ],
    triggers: { event: "flow.execute" },
  },
  async ({ event, step, group, logger }) => {
    const data = event.data as FlowRunEventData;
    const { flowId, noJitter, backfill, backfillRunId } = data;
    const ctx = createFlowRunContext({ step, group, logger, data });

    logger.info("Flow function started", {
      flowId,
      eventData: event.data,
    });

    try {
      // Add jitter to prevent thundering herd - random delay 0-60 seconds
      // Skip jitter if noJitter flag is set
      const jitterMs = await step.run("apply-jitter", async () => {
        if (noJitter) {
          logger.info("Skipping jitter", {
            flowId,
          });
          return 0;
        }

        const jitter = Math.floor(Math.random() * 60000);
        logger.info("Executing flow with jitter", {
          flowId,
          jitterMs: jitter,
        });

        if (jitter > 0) {
          await new Promise(resolve => setTimeout(resolve, jitter));
        }

        return jitter;
      });

      // Use a unique step ID when backfilling to prevent Inngest from replaying
      // stale flow data cached by earlier (possibly pre-CDC) runs.
      const fetchStepSuffix = backfillRunId
        ? `:${backfillRunId.slice(-12)}`
        : "";

      // Get flow details
      const flow = (await step.run(`fetch-flow${fetchStepSuffix}`, async () => {
        const found = await Flow.findById(flowId);
        if (!found) {
          throw new Error(`Flow ${flowId} not found`);
        }
        const freshness = await ensureFlowDerivedCache(found);
        if (freshness === "invalid" || freshness === "missing") {
          throw new Error(
            `Flow ${flowId} definition is invalid at main; refusing to run`,
          );
        }
        const fresh =
          freshness === "resynced" ? await Flow.findById(flowId) : found;
        if (!fresh) {
          throw new Error(`Flow ${flowId} not found`);
        }
        return fresh.toObject() as IFlow;
      })) as unknown as IFlow;
      ctx.state.flowRef = flow; // Store for error handler

      const destinationType = (await step.run(
        `detect-destination-type${fetchStepSuffix}`,
        async () => {
          if (!flow.tableDestination?.connectionId) return undefined;
          const destination = await DatabaseConnection.findOne(
            inWorkspace(flow.tableDestination.connectionId, flow.workspaceId),
          )
            .select({ type: 1 })
            .lean();
          return destination?.type || undefined;
        },
      )) as string | undefined;
      const isCdcEnabled =
        flow.syncEngine === "cdc" &&
        Boolean(flow.tableDestination?.connectionId) &&
        hasCdcDestinationAdapter(destinationType);

      // "Webhook-only" replaces the `type` discriminator: a flow whose sole
      // freshness source is its webhook has no poll schedule to execute, but
      // any flow with a poll trigger may run.
      const isWebhookOnly =
        hasWebhookTrigger(flow) && !hasScheduleTrigger(flow);
      // A CDC backfill run is a full reconcile regardless of which trigger
      // the flow uses day-to-day.
      const isCdcBackfill = Boolean(backfill && isCdcEnabled);

      const requestedBackfillRunId =
        typeof backfillRunId === "string" && backfillRunId.length > 0
          ? backfillRunId
          : undefined;
      ctx.state.cdcBackfillRunId = isCdcBackfill
        ? requestedBackfillRunId || flow.backfillState?.runId
        : undefined;

      // Webhook-only flows should not be executed unless it's a backfill
      if (isWebhookOnly && !backfill) {
        logger.error("CRITICAL: Webhook-only flow reached flow executor!", {
          flowId,
          triggers: deriveTriggerSet(flow),
          dataSourceId: flow.dataSourceId,
          schedule: flow.schedule,
          webhookConfig: !!flow.webhookConfig,
        });
        return {
          success: false,
          message: "Webhook flows cannot be executed as scheduled flows",
        };
      }

      // CDC is the only engine for connector flows: the legacy engine has been
      // removed. A connector flow that is not CDC-capable (no table
      // destination, or a destination without a CDC adapter) fails here, before
      // any work, instead of half-way through a run.
      if (flow.sourceType !== "database" && !isCdcEnabled) {
        throw new Error(`${LEGACY_ENGINE_REMOVED} (flow ${flowId})`);
      }

      if (isCdcBackfill) {
        flow.syncMode = "full";
        logger.info("Backfill mode: CDC enabled, forcing full sync", {
          flowId,
        });
      }

      // Initialize logger and get execution ID
      ctx.state.executionId = await step.run("initialize-logger", async () => {
        const execLogger = createExecutionLogger(flowId, flow);
        await execLogger.start();

        const flowDisplayName = await resolveFlowDisplayName(flow);
        logger.info("Starting flow execution", {
          flowId,
          flowDisplayName,
          jitterApplied: jitterMs,
          executionId: execLogger.getExecutionId(),
          triggerType: noJitter ? "manual" : "scheduled",
        });

        return execLogger.getExecutionId();
      });

      // Update flow status
      const currentRunCount = await step.run("update-flow-status", async () => {
        const result = await Flow.findByIdAndUpdate(
          flowId,
          {
            lastRunAt: new Date(),
            $inc: { runCount: 1 },
          },
          { returnDocument: "after" },
        );
        if (result) {
          return result.runCount;
        }
        return flow.runCount + 1;
      });

      logger.info("Flow run status updated", {
        flowId,
        runCount: currentRunCount,
      });
      await ctx.throwIfExecutionCancelled("post-flow-status-update");

      // Validate sync configuration
      await step.run("validate-sync-config", async () => {
        logger.info("Validating sync configuration", {
          flowId,
          sourceType: flow.sourceType || "connector",
          syncMode: flow.syncMode,
          dataSourceId: flow.dataSourceId?.toString(),
          databaseSourceConnectionId:
            flow.databaseSource?.connectionId?.toString(),
          destinationDatabaseId: flow.destinationDatabaseId.toString(),
          tableDestination: flow.tableDestination?.tableName,
          entityFilter: resolveConfiguredEntities(flow).entities,
        });
        return true;
      });

      // For database-to-database flows, use chunked execution for resumability
      if (flow.sourceType === "database") {
        return await runDatabaseSourceFlow(ctx, flow);
      }
      return await runConnectorSourceFlow(ctx, flow, {
        isCdcEnabled,
        isCdcBackfill,
        destinationType,
      });
    } catch (error) {
      return await handleFlowRunFailure(ctx, error);
    }
  },
);
