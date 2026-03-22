import {
  DatabaseConnection,
  Flow,
  IEntityLayout,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { buildLeaseOwnerId, cdcLockService, CdcLease } from "./lock.service";
import { syncMachineService } from "./state/sync-machine.service";
import {
  buildCdcEntityLayout,
  resolveCdcDestinationAdapter,
} from "./adapters/registry";
import { getCdcStateInvariant } from "./state/sync.machine";
import { toCdcErrorInfo } from "./error-utils";
import { cdcLiveTableName } from "./table-names";
import { getCdcEventStore } from "./stores";
import { recordCdcMaterializationFailure } from "./runtime.service";

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
    if (!getCdcStateInvariant(flow.syncState || "idle").allowMaterialization) {
      return { skipped: true, reason: "syncState is paused" as const };
    }
    if (!flow.tableDestination?.connectionId) {
      return { skipped: true, reason: "missing table destination" as const };
    }

    const destination = await DatabaseConnection.findById(
      flow.tableDestination.connectionId,
    ).lean();
    if (!destination) {
      throw new Error("Destination connection not found");
    }

    const entityLayout = (flow.entityLayouts || []).find(
      (layout: IEntityLayout) =>
        layout.entity === params.entity ||
        layout.entity === params.entity.split(":")[0],
    );
    const tableName = cdcLiveTableName(
      flow.tableDestination.tableName,
      params.entity,
      String(flow._id),
    );
    const adapter = resolveCdcDestinationAdapter({
      destinationType: destination.type,
      destinationDatabaseId: String(flow.destinationDatabaseId),
      destinationDatabaseName: flow.destinationDatabaseName,
      tableDestination: {
        connectionId: String(flow.tableDestination.connectionId),
        schema: flow.tableDestination.schema || "public",
        tableName,
      },
    });
    await adapter.ensureLiveTable(
      buildCdcEntityLayout({
        entity: params.entity,
        tableName,
        deleteMode: flow.deleteMode,
        partitioning: entityLayout?.partitionField
          ? {
              field: entityLayout.partitionField,
              granularity: entityLayout.partitionGranularity || "day",
            }
          : undefined,
        clustering: entityLayout?.clusterFields?.length
          ? { fields: entityLayout.clusterFields }
          : undefined,
      }),
    );

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
      const result = await adapter.materializeEntity(
        {
          workspaceId: params.workspaceId,
          flowId: params.flowId,
          entity: params.entity,
          maxEvents: params.maxEvents,
        },
        lease.fencingToken,
      );
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
    const pending = await getCdcEventStore().countEvents({
      workspaceId,
      flowId,
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
    const errorInfo = toCdcErrorInfo(error, "MATERIALIZATION_FAILED");
    log.error("CDC materialization failed", {
      flowId: params.flowId,
      entity: params.entity,
      errorCode: errorInfo.code,
      error: errorInfo.message,
      fencingToken: lease.fencingToken,
    });

    await recordCdcMaterializationFailure({
      flowId: params.flowId,
      entity: params.entity,
      errorCode: errorInfo.code,
      error: errorInfo.message,
    });

    await syncMachineService.applyTransition({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      event: {
        type: "FAIL",
        reason: "Materialization failed",
        errorCode: errorInfo.code,
        errorMessage: errorInfo.message,
      },
    });
  }
}

export const cdcMaterializerService = new CdcMaterializerService();
