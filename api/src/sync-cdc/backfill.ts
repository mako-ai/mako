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
    options?: { reuseExistingRunId?: boolean; entities?: string[] },
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
    const now = new Date();
    flow.backfillState = {
      active: true,
      runId,
      startedAt: reusedRunId ? flow.backfillState?.startedAt || now : now,
      completedAt: undefined,
      scope: {
        mode: effectiveScope.length > 0 ? "subset" : "all",
        entities: effectiveScope,
      },
    };
    await flow.save();

    await cdcSyncStateService.applyTransition({
      workspaceId,
      flowId,
      event: { type: "START_BACKFILL" },
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

    flow.syncState = "idle";
    flow.syncStateUpdatedAt = new Date();
    flow.syncStateMeta = {
      lastEvent: "RESYNC",
      lastReason: "Operator initiated resync",
    };
    flow.backfillState = {
      active: false,
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

    await cdcSyncStateService.applyTransition({
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

    await cdcSyncStateService.applyTransition({
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

    await cdcSyncStateService.applyTransition({
      workspaceId,
      flowId,
      event: { type: "RESUME", reason: "Resumed via API" },
    });

    const running = await hasActiveExecution(workspaceId, flowId);
    let resumedRun: { runId: string; reusedRunId: boolean } | null = null;
    if (!running && flow.backfillState?.runId) {
      resumedRun = await this.startBackfill(workspaceId, flowId, {
        reuseExistingRunId: true,
      });
    }

    const pending = await getCdcEventStore().countEvents({
      workspaceId,
      flowId,
      materializationStatus: "pending",
    });
    if (pending === 0) {
      await cdcSyncStateService.applyTransition({
        workspaceId,
        flowId,
        event: {
          type: "LAG_CLEARED",
          reason: "Resume with empty backlog",
        },
        context: {
          backlogCount: 0,
          lagSeconds: 0,
          lagThresholdSeconds: 60,
        },
      });
    }

    return {
      resumed: true,
      resumedRunId: resumedRun?.runId || null,
      reusedRunId: resumedRun?.reusedRunId || false,
      pendingBacklog: pending,
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
    const tablePrefix = flow.tableDestination.tableName || "sync";
    const schema = flow.tableDestination.schema;
    const stageSchema =
      destination.type === "bigquery" ? BIGQUERY_WORKING_DATASET : schema;
    const flowId = flow._id.toString();

    for (const entity of enabledEntities) {
      const liveTable = cdcLiveTableName(tablePrefix, entity, flowId);
      const stageTables = new Set<string>([
        cdcStageTableName(tablePrefix, entity, flowId),
        `${liveTable}__stage_changes`,
      ]);
      await driver.dropTable(destination, liveTable, { schema });
      for (const stageTable of stageTables) {
        await driver.dropTable(destination, stageTable, {
          schema: stageSchema,
        });
      }
    }

    log.info("CDC destination tables dropped during resync", {
      flowId: flow._id.toString(),
      entityCount: enabledEntities.length,
    });
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
