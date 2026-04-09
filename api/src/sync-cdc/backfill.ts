import * as crypto from "crypto";
import { Types } from "mongoose";
import { inngest } from "../inngest/client";
import { resolveWebhookEventName } from "../inngest/webhook-process-enqueue";
import {
  CdcChangeEvent,
  CdcEntityState,
  CdcStateTransition,
  DatabaseConnection,
  Flow,
  FlowExecution,
  IFlow,
  WebhookEvent,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { databaseRegistry } from "../databases/registry";
import { resolveConfiguredEntities } from "./entity-selection";
import { hasCdcDestinationAdapter } from "./adapters/registry";
import { BIGQUERY_WORKING_DATASET } from "../utils/bigquery-working-dataset";
import { cdcLiveTableName, cdcStageTableName } from "./normalization";
import { getCdcEventStore } from "./event-store";
import { cdcSyncStateService } from "./sync-state";

const log = loggers.sync("cdc.backfill");

const STALE_HEARTBEAT_MS = 10 * 60 * 1000; // 10 minutes

const CANCEL_WAIT_POLL_MS = 1000;
const CANCEL_WAIT_TIMEOUT_MS = 30_000;

async function assertCanStartBackfill(
  workspaceId: string,
  flowId: string,
): Promise<void> {
  await abandonStaleExecutions(workspaceId, flowId);

  const workspaceObjectId = new Types.ObjectId(workspaceId);
  const flowObjectId = new Types.ObjectId(flowId);

  const running = await FlowExecution.findOne({
    workspaceId: workspaceObjectId,
    flowId: flowObjectId,
    status: "running",
  })
    .sort({ startedAt: -1 })
    .lean();

  if (!running) return;

  // If the backfill was paused (or cancelled), an Inngest cancel is already
  // in-flight.  Wait for the worker to finish rather than rejecting — the
  // user expects reset-entity / resume to work immediately after pause.
  const flow = await Flow.findById(flowId)
    .select("backfillState.status")
    .lean();
  const isPendingCancel =
    flow?.backfillState?.status === "paused" ||
    flow?.backfillState?.status === "error" ||
    flow?.backfillState?.status === "completed" ||
    flow?.backfillState?.status === "idle";

  if (!isPendingCancel) {
    throw new Error(
      "Cannot start backfill while an execution is still running",
    );
  }

  // Send cancel (idempotent) and poll until the execution finishes
  log.info("Waiting for previous execution to finish before starting", {
    flowId,
    executionId: running._id?.toString(),
    backfillStatus: flow?.backfillState?.status,
  });

  await inngest.send({
    name: "flow.cancel",
    data: {
      flowId,
      executionId: running._id?.toString(),
    },
  });

  const deadline = Date.now() + CANCEL_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, CANCEL_WAIT_POLL_MS));
    const still = await FlowExecution.exists({
      _id: running._id,
      status: "running",
    });
    if (!still) return;
  }

  throw new Error(
    "Timed out waiting for previous execution to finish (30s). Try again shortly.",
  );
}

async function abandonStaleExecutions(
  workspaceId: string,
  flowId: string,
  options?: { force?: boolean },
): Promise<number> {
  const filter: Record<string, unknown> = {
    workspaceId: new Types.ObjectId(workspaceId),
    flowId: new Types.ObjectId(flowId),
    status: "running",
  };

  if (!options?.force) {
    const cutoff = new Date(Date.now() - STALE_HEARTBEAT_MS);
    filter.$or = [
      { lastHeartbeat: { $lt: cutoff } },
      { lastHeartbeat: { $exists: false }, startedAt: { $lt: cutoff } },
    ];
  }

  const result = await FlowExecution.updateMany(filter, {
    $set: {
      status: "abandoned",
      completedAt: new Date(),
      error: {
        message: options?.force
          ? "Execution abandoned on server startup — previous process no longer running"
          : "Execution abandoned during recovery — no heartbeat for 10+ minutes",
        code: "RECOVERY_ABANDON",
      },
    },
  });

  if (result.modifiedCount > 0) {
    log.warn("Abandoned stale executions during recovery", {
      flowId,
      workspaceId,
      abandonedCount: result.modifiedCount,
      force: options?.force ?? false,
    });
  }

  return result.modifiedCount;
}

function createBackfillRunId(flowId: string): string {
  return `backfill:${flowId}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
}

function createBackfillTriggerEventId(flowId: string, runId: string): string {
  return `cdc-backfill:${flowId}:${runId}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeEntities(entities: unknown[] | undefined): string[] {
  return Array.isArray(entities)
    ? Array.from(
        new Set(
          entities
            .filter(
              (entity): entity is string =>
                typeof entity === "string" && entity.trim().length > 0,
            )
            .map(entity => entity.trim()),
        ),
      )
    : [];
}

export class CdcBackfillService {
  assertCanStartBackfill = assertCanStartBackfill;

  async startBackfill(
    workspaceId: string,
    flowId: string,
    options?: {
      reuseExistingRunId?: boolean;
      entities?: string[];
      reason?: string;
    },
  ): Promise<{ runId: string; reusedRunId: boolean }> {
    const flow = await Flow.findOne({
      _id: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!flow) {
      throw new Error("Flow not found");
    }
    if (flow.syncEngine !== "cdc") {
      throw new Error("Backfill start requires syncEngine=cdc");
    }

    const shouldReuseRunId = options?.reuseExistingRunId === true;
    const requestedEntities = normalizeEntities(options?.entities);
    const scopeFromFlow =
      flow.backfillState?.scope?.mode === "subset" &&
      Array.isArray(flow.backfillState.scope.entities)
        ? normalizeEntities(flow.backfillState.scope.entities)
        : [];
    const effectiveScope =
      requestedEntities.length > 0
        ? requestedEntities
        : shouldReuseRunId
          ? scopeFromFlow
          : [];

    await assertCanStartBackfill(workspaceId, flowId);

    const runId =
      shouldReuseRunId && flow.backfillState?.runId
        ? flow.backfillState.runId
        : createBackfillRunId(flowId);
    const reusedRunId = Boolean(shouldReuseRunId && flow.backfillState?.runId);
    const previousFailures = flow.backfillState?.consecutiveFailures ?? 0;
    const now = new Date();
    flow.backfillState = {
      status: "running",
      runId,
      startedAt: reusedRunId ? flow.backfillState?.startedAt || now : now,
      completedAt: undefined,
      consecutiveFailures: previousFailures,
      scope: {
        mode: effectiveScope.length > 0 ? "subset" : "all",
        entities: effectiveScope,
      },
    };
    await flow.save();

    const reason =
      options?.reason ||
      (reusedRunId
        ? `Backfill resumed from checkpoint (runId reused, attempt ${previousFailures + 1})`
        : "Backfill started via API");

    log.info(reason, {
      flowId,
      runId,
      reusedRunId,
      consecutiveFailures: previousFailures,
      scope: effectiveScope.length > 0 ? effectiveScope : "all",
    });

    await cdcSyncStateService.applyBackfillTransition({
      workspaceId,
      flowId,
      event: { type: "START", reason },
      context: { hasActiveRunLock: false },
    });

    await inngest.send({
      id: createBackfillTriggerEventId(flowId, runId),
      name: "flow.execute",
      data: {
        flowId,
        noJitter: true,
        backfill: true,
        backfillRunId: runId,
        ...(effectiveScope.length > 0
          ? { backfillEntities: effectiveScope }
          : {}),
      },
    });

    return { runId, reusedRunId };
  }

  async resyncFlow(params: {
    workspaceId: string;
    flowId: string;
    deleteDestination?: boolean;
    clearWebhookEvents?: boolean;
  }) {
    const { workspaceId, flowId, deleteDestination, clearWebhookEvents } =
      params;
    const workspaceObjectId = new Types.ObjectId(workspaceId);
    const flowObjectId = new Types.ObjectId(flowId);

    const flow = await Flow.findOne({
      _id: flowObjectId,
      workspaceId: workspaceObjectId,
    });
    if (!flow) {
      throw new Error("Flow not found");
    }
    if (flow.syncEngine !== "cdc") {
      throw new Error("Resync requires syncEngine=cdc");
    }

    await assertCanStartBackfill(workspaceId, flowId);

    await getCdcEventStore().deleteFlowEvents({ workspaceId, flowId });
    await CdcEntityState.deleteMany({
      workspaceId: workspaceObjectId,
      flowId: flowObjectId,
    });
    await CdcStateTransition.deleteMany({
      workspaceId: workspaceObjectId,
      flowId: flowObjectId,
    });

    if (clearWebhookEvents) {
      await WebhookEvent.deleteMany({
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
      });
    }

    if (deleteDestination) {
      await this.deleteDestinationTables(flow);
    }

    flow.streamState = "idle";
    flow.syncStateUpdatedAt = new Date();
    flow.syncStateMeta = {
      lastEvent: "RESYNC",
      lastReason: "Operator initiated resync",
    };
    flow.backfillState = {
      status: "idle",
      runId: undefined,
      startedAt: undefined,
      completedAt: undefined,
    };
    await flow.save();

    await this.startBackfill(workspaceId, flowId);

    if (!clearWebhookEvents) {
      await this.drainPendingWebhookEvents(workspaceId, flowId, "resync");
    }
  }

  async retryFailedMaterialization(params: {
    workspaceId: string;
    flowId: string;
    entity?: string;
  }) {
    const flow = await Flow.findOne({
      _id: new Types.ObjectId(params.flowId),
      workspaceId: new Types.ObjectId(params.workspaceId),
    });
    if (!flow) {
      throw new Error("Flow not found");
    }
    if (flow.syncEngine !== "cdc") {
      throw new Error("Retry failed materialization requires syncEngine=cdc");
    }

    const eventStore = getCdcEventStore();
    const { resetCount, entities, webhookEventIds } =
      await eventStore.resetFailedEvents({
        workspaceId: params.workspaceId,
        flowId: params.flowId,
        entity: params.entity,
      });

    if (resetCount === 0) {
      return { resetCount: 0, entities: [] as string[] };
    }

    if (webhookEventIds.length > 0) {
      await WebhookEvent.updateMany(
        {
          workspaceId: new Types.ObjectId(params.workspaceId),
          flowId: new Types.ObjectId(params.flowId),
          eventId: { $in: webhookEventIds },
        },
        {
          $set: { applyStatus: "pending", status: "pending" },
          $unset: { applyError: "", error: "", processedAt: "" },
        },
      );
    }

    for (const entity of entities) {
      const minPending = await CdcChangeEvent.findOne({
        flowId: new Types.ObjectId(params.flowId),
        entity,
        materializationStatus: "pending",
      })
        .sort({ ingestSeq: 1 })
        .select({ ingestSeq: 1 })
        .lean();
      if (minPending) {
        await CdcEntityState.updateOne(
          {
            flowId: new Types.ObjectId(params.flowId),
            entity,
          },
          {
            $set: {
              lastMaterializedSeq: Math.max(
                0,
                (parseInt(String(minPending.ingestSeq), 10) || 0) - 1,
              ),
            },
          },
        );
      }

      await inngest.send({
        name: "cdc/materialize",
        data: {
          workspaceId: params.workspaceId,
          flowId: params.flowId,
          entity,
          force: true,
        },
      });
    }

    return { resetCount, entities };
  }

  async recoverFlow(params: {
    workspaceId: string;
    flowId: string;
    retryFailedMaterialization?: boolean;
    entity?: string;
  }) {
    const flow = await Flow.findOne({
      _id: new Types.ObjectId(params.flowId),
      workspaceId: new Types.ObjectId(params.workspaceId),
    });
    if (!flow) {
      throw new Error("Flow not found");
    }
    if (flow.syncEngine !== "cdc") {
      throw new Error("Recover requires syncEngine=cdc");
    }

    await assertCanStartBackfill(params.workspaceId, params.flowId);

    const streamResult = await cdcSyncStateService.applyStreamTransition({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      event: { type: "RECOVER", reason: "Stream recovered via API" },
    });
    if (!streamResult.changed) {
      await this.resumeStream(params.workspaceId, params.flowId);
    }

    let retried = { resetCount: 0, entities: [] as string[] };
    if (params.retryFailedMaterialization) {
      retried = await this.retryFailedMaterialization({
        workspaceId: params.workspaceId,
        flowId: params.flowId,
        entity: params.entity,
      });
    }

    const [
      webhookEventsDrained,
      drainedFailedWebhooks,
      reconciledWebhooks,
      stagingCleaned,
    ] = await Promise.all([
      this.drainPendingWebhookEvents(
        params.workspaceId,
        params.flowId,
        "recover",
      ),
      this.resetFailedWebhookEvents(params.workspaceId, params.flowId),
      this.reconcileWebhookApplyStatus(params.workspaceId, params.flowId),
      this.cleanupOrphanStagingTables(flow),
    ]);

    return {
      retriedFailedRows: retried.resetCount,
      retriedEntities: retried.entities,
      webhookEventsDrained,
      drainedFailedWebhooks,
      reconciledWebhooks,
      stagingCleaned,
    };
  }

  async pauseBackfill(workspaceId: string, flowId: string) {
    const flow = await Flow.findOne({
      _id: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!flow) {
      throw new Error("Flow not found");
    }
    if (flow.syncEngine !== "cdc") {
      throw new Error("Pause requires syncEngine=cdc");
    }

    await cdcSyncStateService.applyBackfillTransition({
      workspaceId,
      flowId,
      event: { type: "PAUSE", reason: "Paused via API" },
    });

    // Send cancel to Inngest so it stops the function between steps.
    // The FlowExecution stays "running" so assertCanStartBackfill()
    // blocks new starts until the Inngest function actually exits.
    const runningExecution = await FlowExecution.findOne({
      flowId: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
      status: "running",
    })
      .sort({ startedAt: -1 })
      .lean();

    if (runningExecution) {
      await inngest.send({
        name: "flow.cancel",
        data: {
          flowId: flow._id.toString(),
          executionId: runningExecution._id.toString(),
        },
      });
    }

    await Flow.updateOne(
      { _id: flow._id, workspaceId: new Types.ObjectId(workspaceId) },
      {
        $set: {
          "backfillState.status": "paused",
          "backfillState.completedAt": null,
        },
      },
    );

    return {
      paused: true,
      cancelledExecutionId: runningExecution?._id?.toString() || null,
      runId: flow.backfillState?.runId || null,
    };
  }

  async cancelBackfill(workspaceId: string, flowId: string) {
    const flow = await Flow.findOne({
      _id: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!flow) {
      throw new Error("Flow not found");
    }
    if (flow.syncEngine !== "cdc") {
      throw new Error("Cancel requires syncEngine=cdc");
    }

    await cdcSyncStateService.applyBackfillTransition({
      workspaceId,
      flowId,
      event: { type: "CANCEL", reason: "Cancelled via API" },
    });

    const runningExecution = await FlowExecution.findOne({
      flowId: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
      status: "running",
    })
      .sort({ startedAt: -1 })
      .lean();

    if (runningExecution) {
      await inngest.send({
        name: "flow.cancel",
        data: {
          flowId: flow._id.toString(),
          executionId: runningExecution._id.toString(),
        },
      });
    }

    await Flow.updateOne(
      { _id: flow._id, workspaceId: new Types.ObjectId(workspaceId) },
      {
        $set: {
          "backfillState.status": "idle",
          "backfillState.completedAt": null,
        },
        $unset: {
          "backfillState.runId": "",
        },
      },
    );

    return {
      cancelled: true,
      cancelledExecutionId: runningExecution?._id?.toString() || null,
    };
  }

  async resumeBackfill(workspaceId: string, flowId: string) {
    const flow = await Flow.findOne({
      _id: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!flow) {
      throw new Error("Flow not found");
    }
    if (flow.syncEngine !== "cdc") {
      throw new Error("Resume requires syncEngine=cdc");
    }

    await cdcSyncStateService.applyBackfillTransition({
      workspaceId,
      flowId,
      event: { type: "RESUME", reason: "Backfill resumed via API" },
    });

    const pending = await getCdcEventStore().countEvents({
      workspaceId,
      flowId,
      materializationStatus: "pending",
    });
    if (pending > 0) {
      try {
        await forceDrainCdcFlow({
          workspaceId,
          flowId,
        });
      } catch (error) {
        log.warn("Failed to schedule CDC drain after resume", {
          flowId,
          workspaceId,
          pendingBacklog: pending,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const webhookEventsDrained = await this.drainPendingWebhookEvents(
      workspaceId,
      flowId,
      "resume",
    );

    let resumedRun: { runId: string; reusedRunId: boolean } | undefined;
    if (flow.backfillState?.runId) {
      resumedRun = await this.startBackfill(workspaceId, flowId, {
        reuseExistingRunId: true,
        reason: "Backfill resumed from pause",
      });
    }

    return {
      resumed: true,
      resumedRunId: resumedRun?.runId || null,
      reusedRunId: resumedRun?.reusedRunId || false,
      resumedBackfill: Boolean(resumedRun),
      webhookEventsDrained,
    };
  }

  async pauseStream(workspaceId: string, flowId: string) {
    const flow = await Flow.findOne({
      _id: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!flow) {
      throw new Error("Flow not found");
    }
    if (flow.syncEngine !== "cdc") {
      throw new Error("Stream pause requires syncEngine=cdc");
    }

    await cdcSyncStateService.applyStreamTransition({
      workspaceId,
      flowId,
      event: { type: "PAUSE", reason: "Stream paused via API" },
    });

    return { paused: true };
  }

  async resumeStream(workspaceId: string, flowId: string) {
    const flow = await Flow.findOne({
      _id: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!flow) {
      throw new Error("Flow not found");
    }
    if (flow.syncEngine !== "cdc") {
      throw new Error("Stream resume requires syncEngine=cdc");
    }

    const result = await cdcSyncStateService.applyStreamTransition({
      workspaceId,
      flowId,
      event: { type: "RESUME", reason: "Stream resumed via API" },
    });
    if (!result.changed) {
      await cdcSyncStateService.applyStreamTransition({
        workspaceId,
        flowId,
        event: { type: "START", reason: "Stream started via API" },
      });
    }

    const pending = await getCdcEventStore().countEvents({
      workspaceId,
      flowId,
      materializationStatus: "pending",
    });
    if (pending > 0) {
      try {
        await forceDrainCdcFlow({ workspaceId, flowId });
      } catch (error) {
        log.warn("Failed to schedule CDC drain after stream resume", {
          flowId,
          workspaceId,
          pendingBacklog: pending,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      resumed: true,
      pendingBacklog: pending,
      drainQueued: pending > 0,
      webhookEventsDrained: 0,
    };
  }

  private async resetFailedWebhookEvents(
    workspaceId: string,
    flowId: string,
  ): Promise<number> {
    try {
      const result = await WebhookEvent.updateMany(
        {
          flowId: new Types.ObjectId(flowId),
          workspaceId: new Types.ObjectId(workspaceId),
          $or: [{ status: "failed" }, { applyStatus: "failed" }],
          attempts: { $lt: 5 },
        },
        {
          $set: { status: "pending", applyStatus: "pending" },
          $unset: { applyError: "", error: "", processedAt: "" },
        },
      );
      if (result.modifiedCount > 0) {
        log.info("Reset failed webhook events during recover", {
          flowId,
          count: result.modifiedCount,
        });
      }
      return result.modifiedCount || 0;
    } catch (error) {
      log.warn("Failed to reset failed webhook events", {
        flowId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  private async reconcileWebhookApplyStatus(
    workspaceId: string,
    flowId: string,
  ): Promise<number> {
    try {
      const flowOid = new Types.ObjectId(flowId);
      const wsOid = new Types.ObjectId(workspaceId);

      const appliedCdcWebhookIds: string[] = await CdcChangeEvent.distinct(
        "webhookEventId",
        {
          flowId: flowOid,
          materializationStatus: "applied",
          webhookEventId: { $type: "string" },
        },
      );
      if (appliedCdcWebhookIds.length === 0) return 0;

      const oids = appliedCdcWebhookIds
        .filter(id => Types.ObjectId.isValid(id))
        .map(id => new Types.ObjectId(id));

      const result = await WebhookEvent.updateMany(
        {
          _id: { $in: oids },
          flowId: flowOid,
          workspaceId: wsOid,
          applyStatus: { $ne: "applied" },
        },
        {
          $set: { applyStatus: "applied", status: "completed" },
          $unset: { applyError: "" },
        },
      );

      if (result.modifiedCount > 0) {
        log.info("Reconciled webhook applyStatus from CDC state", {
          flowId,
          reconciled: result.modifiedCount,
        });
      }
      return result.modifiedCount || 0;
    } catch (error) {
      log.warn("Failed to reconcile webhook apply status", {
        flowId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  private async cleanupOrphanStagingTables(
    flow: Pick<
      IFlow,
      "_id" | "tableDestination" | "destinationDatabaseId" | "entityLayouts"
    >,
  ): Promise<number> {
    try {
      if (
        !flow.tableDestination?.connectionId ||
        !flow.tableDestination?.schema
      ) {
        return 0;
      }
      const destination = await DatabaseConnection.findById(
        flow.tableDestination.connectionId,
      );
      if (!destination || !hasCdcDestinationAdapter(destination.type)) return 0;

      const driver = databaseRegistry.getDriver(destination.type);
      if (!driver?.dropTable) return 0;

      const flowId = String(flow._id);
      const { entities: enabledEntities } = resolveConfiguredEntities(
        flow as any,
      );
      const tablePrefix = flow.tableDestination.tableName || "";
      const schema = flow.tableDestination.schema;
      const stageSchema =
        destination.type === "bigquery" ? BIGQUERY_WORKING_DATASET : schema;
      const flowToken = flowId.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
      let dropped = 0;

      for (const entity of enabledEntities) {
        const liveTable = cdcLiveTableName(tablePrefix, entity, flowId);
        const bulkStaging = `${liveTable}__${flowToken}__staging`;
        const backfillBulkStaging = `${liveTable}__${flowToken}__backfill_staging`;
        const legacyStagingTables = [
          cdcStageTableName(tablePrefix, entity, flowId),
          `${liveTable}__stage_changes`,
        ];
        for (const table of [bulkStaging, backfillBulkStaging]) {
          try {
            await driver.dropTable(destination, table, { schema });
            dropped++;
          } catch {
            /* may not exist */
          }
        }
        for (const table of legacyStagingTables) {
          try {
            await driver.dropTable(destination, table, { schema: stageSchema });
            dropped++;
          } catch {
            /* may not exist */
          }
        }
      }

      if (dropped > 0) {
        log.info("Cleaned up orphan staging tables during recover", {
          flowId,
          dropped,
        });
      }
      return dropped;
    } catch (error) {
      log.warn("Failed to cleanup orphan staging tables", {
        flowId: String(flow._id),
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  private async drainPendingWebhookEvents(
    workspaceId: string,
    flowId: string,
    trigger: string,
  ): Promise<number> {
    try {
      const stuckWebhookEvents = await WebhookEvent.find({
        flowId: new Types.ObjectId(flowId),
        status: "pending",
        attempts: { $lt: 5 },
      })
        .sort({ receivedAt: 1 })
        .limit(500)
        .select({ eventId: 1 })
        .lean();

      if (stuckWebhookEvents.length === 0) return 0;

      const flow = await Flow.findById(flowId)
        .select("syncEngine destinationDatabaseId tableDestination")
        .lean();
      const destConn = flow?.destinationDatabaseId
        ? await DatabaseConnection.findById(flow.destinationDatabaseId)
            .select("type")
            .lean()
        : null;

      const eventName = resolveWebhookEventName(
        flow
          ? {
              syncEngine: flow.syncEngine,
              tableDestination: flow.tableDestination,
            }
          : undefined,
        destConn?.type,
      );

      const CHUNK = 100;
      for (let i = 0; i < stuckWebhookEvents.length; i += CHUNK) {
        const batch = stuckWebhookEvents.slice(i, i + CHUNK);
        await inngest.send(
          batch.map(evt => ({
            name: eventName,
            data: {
              flowId,
              workspaceId,
              eventId: (evt as any).eventId,
              isReplay: true,
            },
          })),
        );
      }

      log.info("Drained pending WebhookEvents", {
        flowId,
        workspaceId,
        trigger,
        count: stuckWebhookEvents.length,
      });

      return stuckWebhookEvents.length;
    } catch (error) {
      log.warn("Failed to drain pending WebhookEvents", {
        flowId,
        workspaceId,
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  private async deleteDestinationTables(
    flow: Pick<
      IFlow,
      "_id" | "tableDestination" | "destinationDatabaseId" | "entityLayouts"
    >,
  ) {
    if (
      !flow.tableDestination?.connectionId ||
      !flow.tableDestination?.schema
    ) {
      return;
    }

    const destination = await DatabaseConnection.findById(
      flow.tableDestination.connectionId,
    );
    if (!destination) {
      return;
    }

    const driver = databaseRegistry.getDriver(destination.type);
    if (!driver?.dropTable) {
      return;
    }

    const enabledEntities = resolveConfiguredEntities(flow).entities;
    const tablePrefix = flow.tableDestination.tableName || "";
    const schema = flow.tableDestination.schema;
    const stageSchema =
      destination.type === "bigquery" ? BIGQUERY_WORKING_DATASET : schema;
    const flowId = flow._id.toString();

    const flowToken = flowId.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
    for (const entity of enabledEntities) {
      const liveTable = cdcLiveTableName(tablePrefix, entity, flowId);
      const oldStageTables = [
        cdcStageTableName(tablePrefix, entity, flowId),
        `${liveTable}__stage_changes`,
      ];
      const bulkStagingTable = `${liveTable}__${flowToken}__staging`;
      const backfillStagingTable = `${liveTable}__${flowToken}__backfill_staging`;

      await driver.dropTable(destination, liveTable, { schema });
      for (const stageTable of oldStageTables) {
        await driver.dropTable(destination, stageTable, {
          schema: stageSchema,
        });
      }
      await driver.dropTable(destination, bulkStagingTable, { schema });
      await driver.dropTable(destination, backfillStagingTable, { schema });
    }

    const db = Flow.db;
    for (const entity of enabledEntities) {
      const collName = `backfill_tmp_${flowId}_${entity.replace(/[^a-zA-Z0-9]/g, "_")}`;
      await db
        .collection(collName)
        .drop()
        .catch(() => undefined);
    }

    log.info("CDC destination tables dropped during resync", {
      flowId: flow._id.toString(),
      entityCount: enabledEntities.length,
    });
  }

  async recoverStaleBackfillsOnStartup(): Promise<{
    recovered: number;
    skipped: number;
    errors: number;
  }> {
    const MAX_CONSECUTIVE_FAILURES = 3;

    // Recover flows stuck in "running" (process died before error handler ran)
    // AND flows in "error" that still have a runId (error handler ran but no
    // auto-restart occurred — e.g. MongoDB crashed and Inngest exhausted retries).
    const staleFlows = await Flow.find({
      syncEngine: "cdc",
      $or: [
        { "backfillState.status": "running" },
        {
          "backfillState.status": "error",
          "backfillState.runId": { $exists: true, $ne: null },
        },
      ],
    }).lean();

    if (staleFlows.length === 0) {
      log.info("Startup backfill check: no stale backfills found");
      return { recovered: 0, skipped: 0, errors: 0 };
    }

    log.info(
      `Startup backfill check: found ${staleFlows.length} stale backfill(s) to recover`,
      {
        flows: staleFlows.map(f => ({
          flowId: f._id.toString(),
          type: f.type,
          backfillStatus: f.backfillState?.status || null,
          runId: f.backfillState?.runId || null,
          startedAt: f.backfillState?.startedAt || null,
          consecutiveFailures: f.backfillState?.consecutiveFailures ?? 0,
          scope: f.backfillState?.scope?.mode || "all",
        })),
      },
    );

    let recovered = 0;
    let skipped = 0;
    let errors = 0;

    for (const flow of staleFlows) {
      const wId = String(flow.workspaceId);
      const fId = String(flow._id);
      const flowLabel = `${flow.type}:${fId}`;
      const runId = flow.backfillState?.runId || "unknown";
      const failures = flow.backfillState?.consecutiveFailures ?? 0;
      const wasRunning = flow.backfillState?.status === "running";

      // On startup, force-abandon ALL running executions for this flow.
      // The previous process is gone, so any "running" execution is orphaned
      // regardless of heartbeat recency (e.g. crash < 10 min ago).
      await abandonStaleExecutions(wId, fId, { force: true });

      try {
        // Only transition running → error; flows already in "error" just
        // need an auto-restart attempt (the Inngest error handler already
        // applied the FAIL transition and incremented consecutiveFailures).
        if (wasRunning) {
          log.info(
            `Startup recovery: "${flowLabel}" — transitioning to error (was stuck in running)`,
            { flowId: fId, runId, consecutiveFailures: failures },
          );

          await cdcSyncStateService.applyBackfillTransition({
            workspaceId: wId,
            flowId: fId,
            event: {
              type: "FAIL",
              reason: "Backfill interrupted by server restart",
              errorCode: "SERVER_RESTART",
            },
          });
          await Flow.findByIdAndUpdate(fId, {
            $inc: { "backfillState.consecutiveFailures": 1 },
          });
        }

        const effectiveFailures = wasRunning ? failures + 1 : failures;

        if (effectiveFailures < MAX_CONSECUTIVE_FAILURES) {
          const result = await this.startBackfill(wId, fId, {
            reuseExistingRunId: true,
            reason: wasRunning
              ? `Auto-resumed on startup (attempt ${effectiveFailures}/${MAX_CONSECUTIVE_FAILURES})`
              : `Auto-resumed on startup from error state (attempt ${effectiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
          });
          log.info(
            `Startup recovery: "${flowLabel}" — backfill restarted from checkpoint`,
            {
              flowId: fId,
              previousStatus: flow.backfillState?.status,
              newRunId: result.runId,
              reusedRunId: result.reusedRunId,
              consecutiveFailures: effectiveFailures,
            },
          );
          recovered++;
        } else {
          log.warn(
            `Startup recovery: "${flowLabel}" — too many consecutive failures (${effectiveFailures}/${MAX_CONSECUTIVE_FAILURES}), manual intervention required`,
            { flowId: fId, runId, consecutiveFailures: effectiveFailures },
          );
          skipped++;
        }
      } catch (err) {
        log.error(
          `Startup recovery: "${flowLabel}" — recovery failed: ${err instanceof Error ? err.message : String(err)}`,
          {
            flowId: fId,
            runId,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        errors++;
      }
    }

    log.info(
      `Startup backfill recovery complete: ${recovered} recovered, ${skipped} skipped, ${errors} errors`,
    );

    return { recovered, skipped, errors };
  }
}

export const cdcBackfillService = new CdcBackfillService();

export async function markCdcBackfillCompletedForFlow(params: {
  workspaceId: string;
  flowId: string;
}) {
  await Flow.updateOne(
    {
      _id: new Types.ObjectId(params.flowId),
      workspaceId: new Types.ObjectId(params.workspaceId),
    },
    {
      $set: {
        "backfillState.status": "completed",
        "backfillState.completedAt": new Date(),
      },
      $unset: {
        "backfillState.runId": "",
      },
    },
  );
}

export async function purgeSoftDeletesAfterBackfill(params: {
  workspaceId: string;
  flowId: string;
}) {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(params.flowId),
    workspaceId: new Types.ObjectId(params.workspaceId),
  }).lean();
  if (!flow || flow.deleteMode !== "hard") return;
  if (!flow.tableDestination?.connectionId || !flow.tableDestination?.schema) {
    return;
  }

  const destination = await DatabaseConnection.findById(
    flow.tableDestination.connectionId,
  );
  if (!destination) return;

  const driver = databaseRegistry.getDriver(destination.type);
  if (!driver?.executeQuery) return;

  const enabledEntities = resolveConfiguredEntities(flow).entities;
  const tablePrefix = flow.tableDestination.tableName || "sync";
  const schema = flow.tableDestination.schema;

  for (const entity of enabledEntities) {
    const tableName = cdcLiveTableName(tablePrefix, entity);
    const fullTable =
      destination.type === "bigquery"
        ? `\`${schema}\`.${tableName}`
        : `"${schema}"."${tableName}"`;
    const query = `DELETE FROM ${fullTable} WHERE is_deleted = true`;
    try {
      await driver.executeQuery(destination, query);
      log.info("Purged soft-deleted rows after backfill", {
        flowId: params.flowId,
        entity,
        table: tableName,
      });
    } catch (err) {
      log.warn("Failed to purge soft-deleted rows", {
        flowId: params.flowId,
        entity,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function forceDrainCdcFlow(params: {
  workspaceId: string;
  flowId: string;
}) {
  const byEntity = await getCdcEventStore().countEventsByEntity({
    workspaceId: params.workspaceId,
    flowId: params.flowId,
    materializationStatus: "pending",
  });

  for (const item of byEntity) {
    if (item.count <= 0) continue;
    await inngest.send({
      name: "cdc/materialize",
      data: {
        workspaceId: params.workspaceId,
        flowId: params.flowId,
        entity: item.entity,
        force: true,
      },
    });
  }
}
