import { Types } from "mongoose";
import {
  CdcEntityState,
  DatabaseConnection,
  Flow,
  IEntityLayout,
  WebhookEvent,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { getCdcEventStore } from "./event-store";
import {
  buildCdcEntityLayout,
  resolveCdcDestinationAdapter,
} from "./adapters/registry";
import { cdcLiveTableName } from "./normalization";
import { isEntityEnabledForFlow } from "./entity-selection";
import { cdcSyncStateService } from "./sync-state";

const log = loggers.sync("cdc.consumer");

export class CdcConsumerService {
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
    if (flow.streamState === "paused") {
      return { skipped: true, reason: "streamState is paused" as const };
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
    const tableDestinationPartitioning = flow.tableDestination?.partitioning;
    const tableDestinationClustering = flow.tableDestination?.clustering;
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
    const layout = buildCdcEntityLayout({
      entity: params.entity,
      tableName,
      deleteMode: flow.deleteMode,
      partitioning: entityLayout?.partitionField
        ? {
            type: "time",
            field: entityLayout.partitionField,
            granularity: entityLayout.partitionGranularity || "day",
            requirePartitionFilter:
              tableDestinationPartitioning?.requirePartitionFilter,
          }
        : tableDestinationPartitioning?.enabled
          ? {
              type: tableDestinationPartitioning.type || "time",
              field:
                tableDestinationPartitioning.type === "ingestion"
                  ? "_syncedAt"
                  : tableDestinationPartitioning.field || "_syncedAt",
              granularity: tableDestinationPartitioning.granularity || "day",
              requirePartitionFilter:
                tableDestinationPartitioning.requirePartitionFilter,
            }
          : undefined,
      clustering: entityLayout?.clusterFields?.length
        ? { fields: entityLayout.clusterFields }
        : tableDestinationClustering?.enabled &&
            tableDestinationClustering.fields?.length
          ? { fields: tableDestinationClustering.fields }
          : undefined,
    });

    await adapter.ensureLiveTable(layout);

    const state = await CdcEntityState.findOne({
      flowId: new Types.ObjectId(params.flowId),
      entity: params.entity,
    }).lean();
    const afterIngestSeq = Number(state?.lastMaterializedSeq || 0);
    const eventStore = getCdcEventStore();
    const pending = await eventStore.readAfter({
      flowId: params.flowId,
      entity: params.entity,
      afterIngestSeq,
      limit: params.maxEvents || 7500,
    });

    if (pending.length === 0) {
      return {
        processed: 0,
        applied: 0,
        failed: 0,
        dropped: 0,
        latestIngestSeq: afterIngestSeq,
      };
    }

    const latestIngestSeq =
      pending[pending.length - 1]?.ingestSeq || afterIngestSeq;
    const enabled = isEntityEnabledForFlow(flow as any, params.entity);
    if (!enabled) {
      await eventStore.markEventsDropped({
        eventIds: pending.map(event => event.id),
        errorCode: "ENTITY_DISABLED",
        errorMessage: `Entity '${params.entity}' disabled for this flow`,
      });
      await this.syncWebhookApplyDroppedStatus(
        pending.map(event => event.webhookEventId),
        {
          code: "ENTITY_DISABLED",
          message: `Entity '${params.entity}' is disabled for this flow`,
        },
      );
      await cdcSyncStateService.advanceConsumerCursor({
        workspaceId: params.workspaceId,
        flowId: params.flowId,
        entity: params.entity,
        lastIngestSeq: latestIngestSeq,
        processedEventsDelta: pending.length,
        rowsAppliedDelta: 0,
      });
      return {
        processed: pending.length,
        applied: 0,
        failed: 0,
        dropped: pending.length,
        latestIngestSeq,
      };
    }

    try {
      const isBackfilling = flow.backfillState?.status === "running";
      const effectiveDeleteMode =
        flow.deleteMode === "hard" && isBackfilling ? "soft" : flow.deleteMode;

      const apply = await adapter.applyEvents({
        events: pending,
        layout,
        flow: {
          _id: flow._id,
          deleteMode: effectiveDeleteMode,
          dataSourceId: flow.dataSourceId,
        },
      });

      await eventStore.markEventsApplied(pending.map(event => event.id));
      await this.syncWebhookApplyStatus(
        pending.map(event => event.webhookEventId),
      );
      await cdcSyncStateService.advanceConsumerCursor({
        workspaceId: params.workspaceId,
        flowId: params.flowId,
        entity: params.entity,
        lastIngestSeq: latestIngestSeq,
        processedEventsDelta: pending.length,
        rowsAppliedDelta: apply.applied,
      });

      return {
        processed: pending.length,
        applied: apply.applied,
        failed: 0,
        dropped: 0,
        latestIngestSeq,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await eventStore.markEventsFailed({
        eventIds: pending.map(event => event.id),
        errorCode: "MATERIALIZATION_FAILED",
        errorMessage,
      });
      await cdcSyncStateService.applyStreamTransition({
        workspaceId: params.workspaceId,
        flowId: params.flowId,
        event: {
          type: "FAIL",
          reason: "Materialization failed",
          errorCode: "MATERIALIZATION_FAILED",
          errorMessage,
        },
      });
      log.error("CDC consumer materialization failed", {
        flowId: params.flowId,
        entity: params.entity,
        error: errorMessage,
      });
      throw error;
    }
  }

  private async syncWebhookApplyStatus(
    webhookEventIds: Array<string | undefined>,
  ): Promise<void> {
    const ids = Array.from(
      new Set(
        webhookEventIds.filter(
          (eventId): eventId is string =>
            typeof eventId === "string" && Types.ObjectId.isValid(eventId),
        ),
      ),
    );
    if (ids.length === 0) {
      return;
    }

    await WebhookEvent.updateMany(
      { _id: { $in: ids.map(id => new Types.ObjectId(id)) } },
      {
        $set: {
          applyStatus: "applied",
          applyError: null,
        },
      },
    );
  }

  private async syncWebhookApplyDroppedStatus(
    webhookEventIds: Array<string | undefined>,
    failure: { code: string; message: string },
  ): Promise<void> {
    const ids = Array.from(
      new Set(
        webhookEventIds.filter(
          (eventId): eventId is string =>
            typeof eventId === "string" && Types.ObjectId.isValid(eventId),
        ),
      ),
    );
    if (ids.length === 0) {
      return;
    }

    await WebhookEvent.updateMany(
      { _id: { $in: ids.map(id => new Types.ObjectId(id)) } },
      {
        $set: {
          applyStatus: "dropped",
          applyError: failure,
        },
        $unset: { appliedAt: "" },
      },
    );
  }
}

export const cdcConsumerService = new CdcConsumerService();
