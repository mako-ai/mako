import { Types } from "mongoose";
import { CdcChangeEvent, Flow } from "../database/workspace-schema";
import { loggers } from "../logging";
import {
  materializeBigQueryEntity,
  recordMaterializationFailure,
} from "../services/bigquery-cdc.service";
import {
  buildLeaseOwnerId,
  cdcLockService,
  CdcLease,
} from "./lock.service";
import { syncMachineService } from "./state/sync-machine.service";

const log = loggers.sync("cdc.materializer");

export class CdcMaterializerService {
  async materializeEntity(params: {
    workspaceId: string;
    flowId: string;
    entity: string;
    maxEvents?: number;
  }) {
    const flow = await Flow.findById(params.flowId).lean();
    if (!flow) {
      throw new Error("Flow not found");
    }
    if (flow.syncEngine !== "cdc") {
      return { skipped: true, reason: "syncEngine is not cdc" as const };
    }

    const ownerId = buildLeaseOwnerId(params.flowId, params.entity);
    const lease = await cdcLockService.acquireLease({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      entity: params.entity,
      ownerId,
    });
    if (!lease) {
      return { skipped: true, reason: "lease unavailable" as const };
    }

    try {
      await cdcLockService.assertFencingToken(lease);
      const result = await materializeBigQueryEntity({
        workspaceId: params.workspaceId,
        flowId: params.flowId,
        entity: params.entity,
        maxEvents: params.maxEvents,
      });
      await cdcLockService.heartbeat(lease);
      await this.updateLifecycleAfterMaterialization(
        params.workspaceId,
        params.flowId,
      );
      return result;
    } catch (error) {
      await this.handleMaterializationError(params, lease, error);
      throw error;
    } finally {
      await cdcLockService.release(lease);
    }
  }

  private async updateLifecycleAfterMaterialization(
    workspaceId: string,
    flowId: string,
  ) {
    const pending = await CdcChangeEvent.countDocuments({
      workspaceId: new Types.ObjectId(workspaceId),
      flowId: new Types.ObjectId(flowId),
      materializationStatus: "pending",
    });

    const flow = await Flow.findById(flowId).lean();
    if (!flow || flow.syncEngine !== "cdc") {
      return;
    }

    if (pending === 0) {
      await syncMachineService.applyTransition({
        workspaceId,
        flowId,
        event: {
          type: "LAG_CLEARED",
          reason: "Stage backlog drained",
        },
        context: {
          backlogCount: 0,
          lagSeconds: 0,
          lagThresholdSeconds: 60,
        },
      });
      return;
    }

    if (flow.syncState === "live") {
      await syncMachineService.applyTransition({
        workspaceId,
        flowId,
        event: {
          type: "LAG_SPIKE",
          reason: `Backlog increased to ${pending}`,
        },
      });
    }
  }

  private async handleMaterializationError(
    params: {
      workspaceId: string;
      flowId: string;
      entity: string;
    },
    lease: CdcLease,
    error: unknown,
  ) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("CDC materialization failed", {
      flowId: params.flowId,
      entity: params.entity,
      error: message,
      fencingToken: lease.fencingToken,
    });

    await recordMaterializationFailure({
      flowId: params.flowId,
      entity: params.entity,
      message,
      code: "MATERIALIZATION_FAILED",
    });

    await syncMachineService.applyTransition({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      event: {
        type: "FAIL",
        reason: "Materialization failed",
        errorCode: "MATERIALIZATION_FAILED",
        errorMessage: message,
      },
    });
  }
}

export const cdcMaterializerService = new CdcMaterializerService();
