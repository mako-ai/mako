import * as crypto from "crypto";
import { Types } from "mongoose";
import { inngest } from "../inngest/client";
import {
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
import { BIGQUERY_WORKING_DATASET } from "../utils/bigquery-working-dataset";
import { cdcLiveTableName, cdcStageTableName } from "./normalization";
import { getCdcEventStore } from "./event-store";
import { cdcSyncStateService } from "./sync-state";

const log = loggers.sync("cdc.backfill");

async function hasActiveExecution(workspaceId: string, flowId: string) {
  return FlowExecution.exists({
    workspaceId: new Types.ObjectId(workspaceId),
    flowId: new Types.ObjectId(flowId),
    status: "running",
  });
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

    const running = await hasActiveExecution(workspaceId, flowId);
    if (running) {
      throw new Error(
        "Backfill already running. Cancel or wait for the active execution before starting another backfill.",
      );
    }

    const runId =
      shouldReuseRunId && flow.backfillState?.runId
        ? flow.backfillState.runId
        : createBackfillRunId(flowId);
    const reusedRunId = Boolean(shouldReuseRunId && flow.backfillState?.runId);
    const previousFailures = flow.backfillState?.consecutiveFailures ?? 0;
    const now = new Date();
    flow.backfillState = {
      active: true,
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
      context: { hasActiveRunLock: Boolean(running) },
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

    const running = await hasActiveExecution(workspaceId, flowId);
    if (running) {
      throw new Error("Cannot resync while a CDC execution is active");
    }

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
    flow.syncState = "idle";
    flow.syncStateUpdatedAt = new Date();
    flow.syncStateMeta = {
      lastEvent: "RESYNC",
      lastReason: "Operator initiated resync",
    };
    flow.backfillState = {
      active: false,
      status: "idle",
      runId: undefined,
      startedAt: undefined,
      completedAt: undefined,
    };
    await flow.save();

    await this.startBackfill(workspaceId, flowId);
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
    resumeBackfill?: boolean;
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

    const running = await hasActiveExecution(params.workspaceId, params.flowId);
    if (running) {
      throw new Error("Cannot recover while a CDC execution is active");
    }

    await this.resumeStream(params.workspaceId, params.flowId);

    await cdcSyncStateService.applyBackfillTransition({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      event: { type: "RECOVER", reason: "Recovered via API" },
    });

    let retried = { resetCount: 0, entities: [] as string[] };
    if (params.retryFailedMaterialization) {
      retried = await this.retryFailedMaterialization({
        workspaceId: params.workspaceId,
        flowId: params.flowId,
        entity: params.entity,
      });
    }

    let resumedRun:
      | {
          runId: string;
          reusedRunId: boolean;
        }
      | undefined;
    if (params.resumeBackfill !== false) {
      resumedRun = await this.startBackfill(params.workspaceId, params.flowId, {
        reuseExistingRunId: true,
        reason: "Backfill resumed via manual recovery",
      });
    }

    return {
      retriedFailedRows: retried.resetCount,
      retriedEntities: retried.entities,
      resumedRunId: resumedRun?.runId || null,
      resumedBackfill: Boolean(resumedRun),
      reusedRunId: resumedRun?.reusedRunId || false,
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

    const runningExecution = await FlowExecution.findOne({
      flowId: new Types.ObjectId(flowId),
      workspaceId: new Types.ObjectId(workspaceId),
      status: "running",
    })
      .sort({ startedAt: -1 })
      .lean();

    if (runningExecution) {
      const now = new Date();
      await FlowExecution.updateOne(
        { _id: runningExecution._id, status: "running" },
        {
          $set: {
            status: "cancelled",
            success: false,
            completedAt: now,
            lastHeartbeat: now,
            error: {
              message: "Flow execution cancelled by pause",
              code: "USER_CANCELLED",
            },
          },
        },
      );

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
          "backfillState.active": false,
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

    let webhookEventsDrained = 0;
    try {
      const flowObjectId = new Types.ObjectId(flowId);
      const stuckWebhookEvents = await WebhookEvent.find({
        flowId: flowObjectId,
        status: "pending",
        attempts: { $lt: 5 },
      })
        .sort({ receivedAt: 1 })
        .limit(500)
        .select({ eventId: 1 })
        .lean();

      if (stuckWebhookEvents.length > 0) {
        for (const evt of stuckWebhookEvents) {
          await inngest.send({
            name: "webhook/event.process",
            data: {
              flowId,
              eventId: (evt as any).eventId,
              isReplay: true,
            },
          });
        }
        webhookEventsDrained = stuckWebhookEvents.length;
        log.info("Drained pending WebhookEvents on resume", {
          flowId,
          workspaceId,
          count: webhookEventsDrained,
        });
      }
    } catch (error) {
      log.warn("Failed to drain pending WebhookEvents on resume", {
        flowId,
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

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

      await driver.dropTable(destination, liveTable, { schema });
      for (const stageTable of oldStageTables) {
        await driver.dropTable(destination, stageTable, {
          schema: stageSchema,
        });
      }
      await driver.dropTable(destination, bulkStagingTable, { schema });
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

    const staleFlows = await Flow.find({
      syncEngine: "cdc",
      "backfillState.status": "running",
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

      const activeExec = await hasActiveExecution(wId, fId);
      if (activeExec) {
        log.info(
          `Startup recovery: "${flowLabel}" skipped — execution still active`,
          { flowId: fId, runId },
        );
        skipped++;
        continue;
      }

      try {
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

        if (failures + 1 < MAX_CONSECUTIVE_FAILURES) {
          const result = await this.startBackfill(wId, fId, {
            reuseExistingRunId: true,
            reason: `Auto-resumed on startup (attempt ${failures + 1}/${MAX_CONSECUTIVE_FAILURES})`,
          });
          log.info(
            `Startup recovery: "${flowLabel}" — backfill restarted from checkpoint`,
            {
              flowId: fId,
              newRunId: result.runId,
              reusedRunId: result.reusedRunId,
              consecutiveFailures: failures + 1,
            },
          );
          recovered++;
        } else {
          log.warn(
            `Startup recovery: "${flowLabel}" — too many consecutive failures (${failures + 1}/${MAX_CONSECUTIVE_FAILURES}), manual intervention required`,
            { flowId: fId, runId, consecutiveFailures: failures + 1 },
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
        "backfillState.active": false,
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
  maxEventsPerEntity?: number;
}) {
  const maxEventsPerEntity = Math.max(params.maxEventsPerEntity || 5000, 100);
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
        maxEvents: maxEventsPerEntity,
      },
    });
  }
}
