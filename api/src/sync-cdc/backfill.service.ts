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
import { getEntityTableName } from "../sync/sync-orchestrator";
import { retryFailedMaterializationForFlow } from "../services/bigquery-cdc.service";
import { syncMachineService } from "./state/sync-machine.service";

const log = loggers.sync("cdc.backfill");

function getEnabledEntities(flow: any): string[] {
  if (Array.isArray(flow.entityLayouts) && flow.entityLayouts.length > 0) {
    return flow.entityLayouts
      .filter((layout: any) => layout.enabled !== false)
      .map((layout: any) => layout.entity)
      .filter((entity: any) => typeof entity === "string" && entity.length > 0);
  }

  if (Array.isArray(flow.entityFilter) && flow.entityFilter.length > 0) {
    return flow.entityFilter;
  }

  return [];
}

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

export class CdcBackfillService {
  async startBackfill(
    workspaceId: string,
    flowId: string,
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

    const runId = flow.backfillState?.runId || createBackfillRunId(flowId);
    const reusedRunId = Boolean(flow.backfillState?.runId);
    const now = new Date();
    flow.backfillState = {
      active: true,
      runId,
      startedAt: flow.backfillState?.startedAt || now,
      completedAt: undefined,
    };
    await flow.save();

    const running = await hasActiveExecution(workspaceId, flowId);
    await syncMachineService.applyTransition({
      workspaceId,
      flowId,
      event: { type: "START_BACKFILL" },
      context: {
        hasActiveRunLock: Boolean(running),
      },
    });

    await inngest.send({
      name: "flow.execute",
      data: {
        flowId,
        noJitter: true,
        backfill: true,
        backfillRunId: runId,
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
    const { workspaceId, flowId, deleteDestination, clearWebhookEvents } = params;
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

    await CdcChangeEvent.deleteMany({
      workspaceId: workspaceObjectId,
      flowId: flowObjectId,
    });
    await CdcEntityState.deleteMany({
      workspaceId: workspaceObjectId,
      flowId: flowObjectId,
    });
    await CdcStateTransition.deleteMany({
      workspaceId: workspaceObjectId,
      flowId: flowObjectId,
    });
    await CdcBackfillCheckpoint.deleteMany({
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
      await this.deleteDestinationTables(flow as any);
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
      resumedRun = await this.startBackfill(params.workspaceId, params.flowId);
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

  private async deleteDestinationTables(flow: any) {
    if (!flow.tableDestination?.connectionId || !flow.tableDestination?.schema) {
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

    const enabledEntities = getEnabledEntities(flow);
    const tablePrefix = flow.tableDestination.tableName || "sync";
    const schema = flow.tableDestination.schema;

    for (const entity of enabledEntities) {
      const liveTable = getEntityTableName(tablePrefix, entity);
      await driver.dropTable(destination as any, liveTable, { schema });
      await driver.dropTable(destination as any, `${liveTable}__stage_changes`, {
        schema,
      });
    }

    log.info("CDC destination tables dropped during resync", {
      flowId: flow._id.toString(),
      entityCount: enabledEntities.length,
    });
  }
}

export const cdcBackfillService = new CdcBackfillService();
