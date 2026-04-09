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
  resolveEntityPartitioning,
  resolveEntityClustering,
} from "./adapters/registry";
import {
  cdcLiveTableName,
  normalizePayloadBySchema,
  normalizePayloadKeys,
} from "./normalization";
import { isEntityEnabledForFlow } from "./entity-selection";
import { cdcSyncStateService } from "./sync-state";
import { syncConnectorRegistry } from "../sync/connector-registry";
import { databaseDataSourceManager } from "../sync/database-data-source-manager";
import type { ConnectorEntitySchema } from "../connectors/base/BaseConnector";

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
      partitioning: resolveEntityPartitioning(
        entityLayout,
        flow.tableDestination?.partitioning,
      ),
      clustering: resolveEntityClustering(
        entityLayout,
        flow.tableDestination?.clustering,
      ),
    });

    await adapter.ensureLiveTable(layout);

    const state = await CdcEntityState.findOne({
      flowId: new Types.ObjectId(params.flowId),
      entity: params.entity,
    }).lean();
    const afterIngestSeq = Number(state?.lastMaterializedSeq || 0);
    const lastIngestSeq = Number(state?.lastIngestSeq || 0);
    const eventStore = getCdcEventStore();
    const pending = await eventStore.readAfter({
      flowId: params.flowId,
      entity: params.entity,
      afterIngestSeq,
      limit: params.maxEvents || 7500,
    });

    if (pending.length === 0) {
      if (lastIngestSeq > afterIngestSeq) {
        log.warn("Sequence gap with no pending events — advancing cursor", {
          flowId: params.flowId,
          entity: params.entity,
          lastMaterializedSeq: afterIngestSeq,
          lastIngestSeq,
        });
        await cdcSyncStateService.advanceConsumerCursor({
          workspaceId: params.workspaceId,
          flowId: params.flowId,
          entity: params.entity,
          lastIngestSeq,
          processedEventsDelta: 0,
          rowsAppliedDelta: 0,
        });
      }
      return {
        processed: 0,
        applied: 0,
        failed: 0,
        dropped: 0,
        latestIngestSeq: lastIngestSeq,
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

      let entitySchema: ConnectorEntitySchema | null = null;
      if (flow.dataSourceId) {
        try {
          const decrypted = await databaseDataSourceManager.getDataSource(
            String(flow.dataSourceId),
          );
          const connector = decrypted
            ? await syncConnectorRegistry.getConnector(decrypted)
            : null;
          if (connector) {
            entitySchema = await connector.resolveSchema(params.entity);
          }
        } catch {
          log.warn("Schema resolution failed, proceeding without schema", {
            entity: params.entity,
            flowId: params.flowId,
          });
        }
      }

      const normalizedEvents = entitySchema
        ? pending.map(event => {
            if (!event.payload) return event;
            const keysNormalized = normalizePayloadKeys(event.payload);
            const { payload: normalizedPayload, warnings } =
              normalizePayloadBySchema(keysNormalized, entitySchema);
            if (warnings.length > 0) {
              log.warn("Schema coercion warnings during materialization", {
                entity: params.entity,
                recordId: event.recordId,
                warnings,
              });
            }
            return { ...event, payload: normalizedPayload };
          })
        : pending;

      const apply = await adapter.applyEvents({
        events: normalizedEvents,
        layout,
        flow: {
          _id: flow._id,
          deleteMode: effectiveDeleteMode,
          dataSourceId: flow.dataSourceId,
        },
        entitySchema: entitySchema ?? undefined,
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
      await this.syncWebhookApplyFailedStatus(
        pending.map(event => event.webhookEventId),
        {
          code: "MATERIALIZATION_FAILED",
          message: errorMessage,
        },
      );
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

  private async syncWebhookApplyFailedStatus(
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
          applyStatus: "failed",
          applyError: failure,
          status: "failed",
          error: failure,
        },
        $unset: { appliedAt: "" },
      },
    );
  }
}

export const cdcConsumerService = new CdcConsumerService();
