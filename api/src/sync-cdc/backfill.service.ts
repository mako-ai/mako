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
import { resolveConfiguredEntities } from "./entity-selection";
import { BIGQUERY_WORKING_DATASET } from "../utils/bigquery-working-dataset";

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

export class CdcBackfillService {
  async startBackfill(
    workspaceId: string,
    flowId: string,
    options?: { reuseExistingRunId?: boolean },
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
      // Keep runId stable for checkpoint resume semantics, but use a unique
      // event id for each trigger so recover can re-dispatch the same runId.
      id: createBackfillTriggerEventId(flowId, runId),
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

  private async deleteDestinationTables(flow: any) {
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

    for (const entity of enabledEntities) {
      const liveTable = getEntityTableName(tablePrefix, entity);
      await driver.dropTable(destination as any, liveTable, { schema });
      await driver.dropTable(
        destination as any,
        `${liveTable}__stage_changes`,
        {
          schema: stageSchema,
        },
      );
    }

    log.info("CDC destination tables dropped during resync", {
      flowId: flow._id.toString(),
      entityCount: enabledEntities.length,
    });
  }
}

export const cdcBackfillService = new CdcBackfillService();
