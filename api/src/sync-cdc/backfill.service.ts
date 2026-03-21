import * as crypto from "crypto";
import { Types } from "mongoose";
import { inngest } from "../inngest/client";
import {
  CdcChangeEvent,
  CdcBackfillCheckpoint,
  CdcEntityState,
  CdcStateTransition,
  DatabaseConnection,
  Flow,
  FlowExecution,
  WebhookEvent,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { databaseRegistry } from "../databases/registry";
import { retryFailedMaterializationForFlow } from "../services/bigquery-cdc.service";
import { syncMachineService } from "./state/sync-machine.service";
import { resolveConfiguredEntities } from "./entity-selection";
import { BIGQUERY_WORKING_DATASET } from "../utils/bigquery-working-dataset";
import {
  cdcFlowToken,
  cdcLiveTableName,
  cdcStageTableName,
} from "./table-names";
import { databaseDataSourceManager } from "../sync/database-data-source-manager";
import { syncConnectorRegistry } from "../sync/connector-registry";
import { getEntityTableName } from "../sync/sync-orchestrator";

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

type RestartPreviewTable = {
  entity: string;
  kind: "live" | "working" | "legacy_live" | "legacy_working";
  schema: string;
  table: string;
  fullName: string;
};

type RestartPreview = {
  flowId: string;
  destinationType: string;
  destinationSchema: string;
  workingSchema: string;
  entities: string[];
  safeToDropLegacyTables: boolean;
  tables: RestartPreviewTable[];
};

export class CdcBackfillService {
  async getRestartTablePreview(params: {
    workspaceId: string;
    flowId: string;
    entities?: string[];
  }): Promise<RestartPreview> {
    const workspaceObjectId = new Types.ObjectId(params.workspaceId);
    const flowObjectId = new Types.ObjectId(params.flowId);
    const flow = await Flow.findOne({
      _id: flowObjectId,
      workspaceId: workspaceObjectId,
    });
    if (!flow) {
      throw new Error("Flow not found");
    }
    if (flow.syncEngine !== "cdc") {
      throw new Error("Restart preview requires syncEngine=cdc");
    }

    const requestedEntities = normalizeEntities(params.entities);
    const entitiesToDrop = await this.resolveEntitiesForReset(
      flow as any,
      requestedEntities,
    );
    return this.buildRestartPreview(flow as any, entitiesToDrop);
  }

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
    const running = await hasActiveExecution(workspaceId, flowId);
    if (running) {
      throw new Error(
        "Backfill already running. Use restart-from-scratch to reset from zero, or cancel the active run first.",
      );
    }
    const runId =
      shouldReuseRunId && flow.backfillState?.runId
        ? flow.backfillState.runId
        : createBackfillRunId(flowId);
    const reusedRunId = Boolean(shouldReuseRunId && flow.backfillState?.runId);
    const now = new Date();
    await syncMachineService.applyTransition({
      workspaceId,
      flowId,
      event: { type: "START_BACKFILL" },
      context: {
        hasActiveRunLock: false,
      },
    });

    flow.backfillState = {
      active: true,
      runId,
      startedAt: reusedRunId ? flow.backfillState?.startedAt || now : now,
      completedAt: undefined,
    };
    await flow.save();

    await inngest.send({
      // Keep runId stable for checkpoint resume semantics, but use a unique
      // event id for each trigger so recover can re-dispatch the same runId.
      id: createBackfillTriggerEventId(flowId, runId),
      name: "flow.execute",
      data: {
        flowId,
        noJitter: true,
        backfill: true,
        backfillRunId: runId,
        ...(requestedEntities.length > 0
          ? { backfillEntities: requestedEntities }
          : {}),
      },
    });

    if (requestedEntities.length > 0) {
      log.info("Started targeted CDC backfill", {
        flowId,
        runId,
        entityCount: requestedEntities.length,
        entities: requestedEntities,
      });
    }

    return { runId, reusedRunId };
  }

  async resyncFlow(params: {
    workspaceId: string;
    flowId: string;
    deleteDestination?: boolean;
    clearWebhookEvents?: boolean;
    entities?: string[];
  }) {
    const { workspaceId, flowId, deleteDestination, clearWebhookEvents } =
      params;
    const requestedEntities = normalizeEntities(params.entities);
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
      throw new Error(
        "Cannot restart from scratch while a CDC execution is active. Cancel or finish the active run first.",
      );
    }
    if (!deleteDestination) {
      throw new Error(
        "Restart from scratch requires destination deletion (deleteDestination=true).",
      );
    }

    if (deleteDestination) {
      const entitiesToDrop = await this.resolveEntitiesForReset(
        flow as any,
        requestedEntities,
      );
      await this.deleteDestinationTables(flow as any, entitiesToDrop);
    }

    await this.clearResyncState({
      workspaceObjectId,
      flowObjectId,
      entities: requestedEntities,
      clearWebhookEvents: Boolean(clearWebhookEvents),
    });

    if (requestedEntities.length === 0) {
      await this.clearCdcIngestCounter(flowObjectId);
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

    await this.startBackfill(workspaceId, flowId, {
      entities: requestedEntities,
    });
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

    return retryFailedMaterializationForFlow({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      entity: params.entity,
    });
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

    await syncMachineService.applyTransition({
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

    log.info("CDC flow recovered", {
      flowId: params.flowId,
      retriedFailed: retried.resetCount,
      resumedRunId: resumedRun?.runId,
      resumedBackfill: Boolean(resumedRun),
    });

    return {
      retriedFailedRows: retried.resetCount,
      retriedEntities: retried.entities,
      resumedRunId: resumedRun?.runId || null,
      resumedBackfill: Boolean(resumedRun),
      reusedRunId: resumedRun?.reusedRunId || false,
    };
  }

  private async clearResyncState(params: {
    workspaceObjectId: Types.ObjectId;
    flowObjectId: Types.ObjectId;
    entities: string[];
    clearWebhookEvents: boolean;
  }) {
    const scopedEntityMatch =
      params.entities.length > 0 ? { entity: { $in: params.entities } } : {};
    const baseMatch = {
      workspaceId: params.workspaceObjectId,
      flowId: params.flowObjectId,
    };

    await CdcChangeEvent.deleteMany({ ...baseMatch, ...scopedEntityMatch });
    await CdcEntityState.deleteMany({ ...baseMatch, ...scopedEntityMatch });
    await CdcBackfillCheckpoint.deleteMany({
      ...baseMatch,
      ...scopedEntityMatch,
    });

    if (params.entities.length === 0) {
      await CdcStateTransition.deleteMany(baseMatch);
    }

    if (params.clearWebhookEvents) {
      await WebhookEvent.deleteMany({ ...baseMatch, ...scopedEntityMatch });
    }
  }

  private async clearCdcIngestCounter(flowId: Types.ObjectId) {
    const counters = Flow.db.collection("bigquery_cdc_counters");
    await counters.deleteOne({ flowId });
    log.info("Cleared CDC ingest counter for flow resync", {
      flowId: flowId.toString(),
    });
  }

  private async resolveEntitiesForReset(
    flow: any,
    requestedEntities: string[],
  ): Promise<string[]> {
    if (requestedEntities.length > 0) {
      return requestedEntities;
    }

    const flowId = String(flow._id);
    const workspaceId = String(flow.workspaceId);
    const flowObjectId = new Types.ObjectId(flowId);
    const workspaceObjectId = new Types.ObjectId(workspaceId);

    const entitySet = new Set<string>(resolveConfiguredEntities(flow).entities);

    const [
      stateEntities,
      changeEventEntities,
      checkpointEntities,
      webhookEntities,
      recentExecutions,
    ] = await Promise.all([
      CdcEntityState.distinct("entity", {
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
      }),
      CdcChangeEvent.distinct("entity", {
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
      }),
      CdcBackfillCheckpoint.distinct("entity", {
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
      }),
      WebhookEvent.distinct("entity", {
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
        entity: { $exists: true, $ne: null },
      }),
      FlowExecution.find({
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
      })
        .sort({ startedAt: -1 })
        .limit(20)
        .select({
          "stats.plannedEntities": 1,
          "stats.entityStatus": 1,
          "stats.entityStats": 1,
        })
        .lean(),
    ]);

    for (const entityList of [
      stateEntities,
      changeEventEntities,
      checkpointEntities,
      webhookEntities,
    ]) {
      for (const entity of entityList || []) {
        if (typeof entity === "string" && entity.trim().length > 0) {
          entitySet.add(entity.trim());
        }
      }
    }

    for (const execution of recentExecutions as any[]) {
      const plannedEntities = Array.isArray(execution?.stats?.plannedEntities)
        ? execution.stats.plannedEntities
        : [];
      for (const entity of plannedEntities) {
        if (typeof entity === "string" && entity.trim().length > 0) {
          entitySet.add(entity.trim());
        }
      }

      const statusEntities = Object.keys(execution?.stats?.entityStatus || {});
      const statEntities = Object.keys(execution?.stats?.entityStats || {});
      for (const entity of [...statusEntities, ...statEntities]) {
        if (entity.trim().length > 0) {
          entitySet.add(entity.trim());
        }
      }
    }

    if (entitySet.size === 0 && flow.dataSourceId) {
      try {
        const dataSource = await databaseDataSourceManager.getDataSource(
          String(flow.dataSourceId),
        );
        if (dataSource) {
          const connector =
            await syncConnectorRegistry.getConnector(dataSource);
          if (connector) {
            for (const entity of connector.getAvailableEntities()) {
              if (typeof entity === "string" && entity.trim().length > 0) {
                entitySet.add(entity.trim());
              }
            }
          }
        }
      } catch (error) {
        log.warn("Failed to resolve connector entities for CDC table cleanup", {
          flowId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return Array.from(entitySet);
  }

  private async buildRestartPreview(
    flow: any,
    entities: string[],
  ): Promise<RestartPreview> {
    if (
      !flow.tableDestination?.connectionId ||
      !flow.tableDestination?.schema
    ) {
      throw new Error(
        "Cannot build restart preview: flow is missing table destination settings.",
      );
    }

    const destination = await DatabaseConnection.findById(
      flow.tableDestination.connectionId,
    ).lean();
    if (!destination) {
      throw new Error("Destination connection not found");
    }

    const entitiesToDrop = normalizeEntities(entities);
    if (entitiesToDrop.length === 0) {
      throw new Error(
        "Cannot restart from scratch: no flow-owned entities could be resolved for destination cleanup.",
      );
    }

    const tablePrefix = flow.tableDestination.tableName || "";
    const destinationSchema = flow.tableDestination.schema;
    const workingSchema =
      destination.type === "bigquery"
        ? BIGQUERY_WORKING_DATASET
        : destinationSchema;
    const flowId = String(flow._id);

    // Live tables now use shared entity table names, while working tables remain
    // flow-scoped. We only include explicit legacy table cleanup entries when
    // they differ from the current naming to avoid duplicate drop attempts.
    const legacyTableUsedByNonCdcFlow = await Flow.exists({
      _id: { $ne: flow._id },
      workspaceId: flow.workspaceId,
      "tableDestination.connectionId": flow.tableDestination.connectionId,
      "tableDestination.schema": flow.tableDestination.schema,
      "tableDestination.tableName": flow.tableDestination.tableName || "",
      syncEngine: { $ne: "cdc" },
    });
    const safeToDropLegacyTables = !legacyTableUsedByNonCdcFlow;

    const tables: RestartPreviewTable[] = [];
    for (const entity of entitiesToDrop) {
      const liveTable = cdcLiveTableName(tablePrefix, entity, flowId);
      const stageTable = cdcStageTableName(tablePrefix, entity, flowId);
      const previousFlowScopedLiveTable = `${getEntityTableName(
        tablePrefix,
        entity,
      )}__${cdcFlowToken(flowId)}`;
      tables.push({
        entity,
        kind: "live",
        schema: destinationSchema,
        table: liveTable,
        fullName: `${destinationSchema}.${liveTable}`,
      });
      tables.push({
        entity,
        kind: "working",
        schema: workingSchema,
        table: stageTable,
        fullName: `${workingSchema}.${stageTable}`,
      });

      if (previousFlowScopedLiveTable !== liveTable) {
        tables.push({
          entity,
          kind: "legacy_live",
          schema: destinationSchema,
          table: previousFlowScopedLiveTable,
          fullName: `${destinationSchema}.${previousFlowScopedLiveTable}`,
        });
      }

      if (safeToDropLegacyTables) {
        const legacyLiveTable = getEntityTableName(tablePrefix, entity);
        if (legacyLiveTable !== liveTable) {
          tables.push({
            entity,
            kind: "legacy_live",
            schema: destinationSchema,
            table: legacyLiveTable,
            fullName: `${destinationSchema}.${legacyLiveTable}`,
          });
          tables.push({
            entity,
            kind: "legacy_working",
            schema: workingSchema,
            table: `${legacyLiveTable}__stage_changes`,
            fullName: `${workingSchema}.${legacyLiveTable}__stage_changes`,
          });
        }
      }
    }

    return {
      flowId,
      destinationType: destination.type,
      destinationSchema,
      workingSchema,
      entities: entitiesToDrop,
      safeToDropLegacyTables,
      tables,
    };
  }

  private async deleteDestinationTables(flow: any, entities: string[]) {
    const preview = await this.buildRestartPreview(flow, entities);
    const destination = await DatabaseConnection.findById(
      flow.tableDestination.connectionId,
    );
    if (!destination) {
      throw new Error("Destination connection not found");
    }

    const driver = databaseRegistry.getDriver(destination.type);
    if (!driver?.dropTable) {
      throw new Error(
        `Destination driver '${destination.type}' does not support table deletion`,
      );
    }

    for (const table of preview.tables) {
      await driver.dropTable(destination as any, table.table, {
        schema: table.schema,
      });
    }

    log.info("CDC destination tables dropped during resync", {
      flowId: preview.flowId,
      entityCount: preview.entities.length,
      entities: preview.entities,
      tableCount: preview.tables.length,
      safeToDropLegacyTables: preview.safeToDropLegacyTables,
    });
  }
}

export const cdcBackfillService = new CdcBackfillService();
