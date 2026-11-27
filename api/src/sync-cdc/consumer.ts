import { Types } from "mongoose";
import {
  CdcChangeEvent,
  CdcEntityState,
  Flow,
  IEntityLayout,
  WebhookEvent,
} from "../database/workspace-schema";
import { connectionsRepo } from "../repositories/connections";
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
  segmentAroundDeletes,
} from "./normalization";
import { isEntityEnabledForFlow } from "./entity-selection";
import { cdcSyncStateService } from "./sync-state";
import { syncConnectorRegistry } from "../sync/connector-registry";
import { sourceConnectionManager } from "../sync/database-data-source-manager";
import type { ConnectorEntitySchema } from "../connectors/base/BaseConnector";
import { boxLowMemoryRefusal } from "../apps/sandbox/box-memory";
import { ensureFlowDerivedCache } from "../services/flow-sync.service";
import {
  FLOW_PAUSED_CODE,
  isWebhookPaused,
} from "../services/flow-triggers.service";

const log = loggers.sync("cdc.consumer");

/**
 * Marks a paused flow's pending webhook-sourced change events of one entity
 * as dropped (FLOW_PAUSED), so materialization never applies them, and marks
 * their WebhookEvents dropped too, so the event log and the orphan reconciler
 * never report them as applied. `appliedAt` puts the change events under the
 * 7-day dropped-events TTL. Returns how many were parked.
 */
export async function parkPausedFlowWebhookEvents(params: {
  flowId: string;
  entity: string;
}): Promise<number> {
  const parkable = await CdcChangeEvent.find(
    {
      flowId: new Types.ObjectId(params.flowId),
      entity: params.entity,
      sourceKind: "webhook",
      materializationStatus: { $in: ["pending", "failed"] },
    },
    { _id: 1, webhookEventId: 1 },
  ).lean();
  if (parkable.length === 0) return 0;

  const failure = {
    code: FLOW_PAUSED_CODE,
    message: "The flow's webhook is switched off; event parked",
  };
  const result = await CdcChangeEvent.updateMany(
    {
      _id: { $in: parkable.map(event => event._id) },
      materializationStatus: { $in: ["pending", "failed"] },
    },
    {
      $set: {
        materializationStatus: "dropped",
        materializationError: failure,
        appliedAt: new Date(),
      },
    },
  );

  const webhookEventIds = Array.from(
    new Set(
      parkable
        .map(event => event.webhookEventId)
        .filter(
          (eventId): eventId is string =>
            typeof eventId === "string" && Types.ObjectId.isValid(eventId),
        ),
    ),
  );
  if (webhookEventIds.length > 0) {
    await WebhookEvent.updateMany(
      { _id: { $in: webhookEventIds.map(id => new Types.ObjectId(id)) } },
      {
        $set: { applyStatus: "dropped", applyError: failure },
        $unset: { appliedAt: "" },
      },
    );
  }
  return result.modifiedCount ?? 0;
}

export class CdcConsumerService {
  async materializeEntity(params: {
    workspaceId: string;
    flowId: string;
    entity: string;
    maxEvents?: number;
  }) {
    const loaded = await Flow.findById(params.flowId).lean();
    if (!loaded) {
      throw new Error("Flow not found");
    }
    const freshness = await ensureFlowDerivedCache(loaded);
    if (freshness === "invalid" || freshness === "missing") {
      return { skipped: true, reason: "definition_invalid" as const };
    }
    const flow =
      freshness === "resynced"
        ? await Flow.findById(params.flowId).lean()
        : loaded;
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

    // The apply step refuses webhook events of a paused flow, whatever lane
    // or retry path queued them: they are parked as dropped before the read
    // below. Backfill events still apply (an operator re-read is deliberate).
    if (isWebhookPaused(flow)) {
      const parked = await parkPausedFlowWebhookEvents({
        flowId: params.flowId,
        entity: params.entity,
      });
      if (parked > 0) {
        log.warn("Parked webhook events of a paused flow", {
          flowId: params.flowId,
          entity: params.entity,
          parked,
        });
      }
    }

    const destination = await connectionsRepo.findDatabaseConnectionSummary(
      flow.tableDestination.connectionId.toString(),
      flow.workspaceId ? flow.workspaceId.toString() : params.workspaceId,
    );
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
      flowId: String(flow._id),
      workspaceId: String(flow.workspaceId),
      destinationDatabaseId: String(flow.destinationDatabaseId),
      destinationDatabaseName: flow.destinationDatabaseName,
      tableDestination: {
        connectionId: String(flow.tableDestination.connectionId),
        schema: flow.tableDestination.schema || "public",
        tableName,
      },
    });
    let connectorSchema: ConnectorEntitySchema | null = null;
    if (flow.dataSourceId) {
      try {
        const ds = await sourceConnectionManager.getSourceConnection(
          String(flow.dataSourceId),
          String(flow.workspaceId),
        );
        const conn = ds
          ? await syncConnectorRegistry.getConnectorFor(ds)
          : null;
        if (conn) {
          connectorSchema = await conn.resolveSchema(params.entity);
        }
      } catch (error) {
        // A box memory refusal is no answer: the materialization waits for
        // memory (webhook-flow.ts) and never builds a layout without keys.
        // Thrown before any event is read, so none is marked failed.
        if (boxLowMemoryRefusal(error)) throw error;
        log.warn("Schema resolution failed for layout key columns", {
          entity: params.entity,
          flowId: params.flowId,
        });
      }
    }

    const layout = buildCdcEntityLayout({
      entity: params.entity,
      tableName,
      keyColumns: connectorSchema?.keyColumns,
      deleteMode: flow.deleteMode,
      // Without this, applyEvents/applyBatch default to dedup-merge
      // semantics even on `Incremental | Append` flows, silently
      // overwriting instead of appending history rows (bug B3, see
      // docs/sync-modes-hardening-plan.md).
      writeMode: flow.writeMode,
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
    const eventStore = getCdcEventStore();
    const pending = await eventStore.readAfter({
      flowId: params.flowId,
      entity: params.entity,
      afterIngestSeq,
      limit: params.maxEvents || 2500,
    });

    if (pending.length === 0) {
      // Close the sequence gap so the scheduler stops treating this entity
      // as stale.  This happens when all events after lastMaterializedSeq
      // have already been applied/failed/dropped by a previous run.
      const currentIngestSeq = Number(state?.lastIngestSeq || 0);
      if (currentIngestSeq > afterIngestSeq) {
        // Drift-seed guard: `readAfter` already selects ALL pending rows for
        // this entity, so an empty result *should* mean nothing is pending.
        // Confirm with a direct count before jumping the cursor forward — if a
        // pending row exists (e.g. a backfill or concurrent ingest raced ahead
        // of this read), advancing would orphan it below lastMaterializedSeq
        // and findStaleEntities would stop re-triggering it. Never advance the
        // cursor past a still-pending event.
        const stillPending = await CdcChangeEvent.countDocuments({
          flowId: new Types.ObjectId(params.flowId),
          entity: params.entity,
          materializationStatus: "pending",
        });
        if (stillPending === 0) {
          await cdcSyncStateService.advanceConsumerCursor({
            workspaceId: params.workspaceId,
            flowId: params.flowId,
            entity: params.entity,
            lastIngestSeq: currentIngestSeq,
            processedEventsDelta: 0,
            rowsAppliedDelta: 0,
          });
        }
      }
      return {
        processed: 0,
        applied: 0,
        failed: 0,
        dropped: 0,
        latestIngestSeq: currentIngestSeq,
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

      const entitySchema = connectorSchema;

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

      // One applyEvents per segment, in ingest order: a delete never shares
      // a segment with its record's other events (segmentAroundDeletes), so
      // the rows do not depend on how events were batched or coalesced.
      const apply = { applied: 0 };
      for (const segment of segmentAroundDeletes(normalizedEvents)) {
        const applied = await adapter.applyEvents({
          events: segment,
          layout,
          flow: {
            _id: flow._id,
            deleteMode: effectiveDeleteMode,
            dataSourceId: flow.dataSourceId,
          },
          entitySchema: entitySchema ?? undefined,
        });
        apply.applied += applied.applied;
      }

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

      // A failed apply marks the whole stream "error"; one that succeeds
      // afterwards proves the failure was transient (a reset connection, a
      // BigQuery hiccup), so clear it rather than show a working stream as
      // broken until someone presses Recover (es/fr Close sat in "error" from
      // 2026-10-05 while applying events every minute).
      if (
        flow.streamState === "error" &&
        flow.syncStateMeta?.lastErrorCode === "MATERIALIZATION_FAILED"
      ) {
        try {
          await cdcSyncStateService.applyStreamTransition({
            workspaceId: params.workspaceId,
            flowId: params.flowId,
            event: {
              type: "RECOVER",
              reason: "Materialization succeeded again",
            },
          });
        } catch (recoverError) {
          log.warn("CDC consumer could not clear the stream error", {
            flowId: params.flowId,
            error:
              recoverError instanceof Error
                ? recoverError.message
                : String(recoverError),
          });
        }
      }

      if (state?.consecutiveFailures) {
        await CdcEntityState.updateOne(
          {
            flowId: new Types.ObjectId(params.flowId),
            entity: params.entity,
          },
          {
            $set: { consecutiveFailures: 0, lastFailureError: null },
          },
        );
      }

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
      await CdcEntityState.updateOne(
        {
          flowId: new Types.ObjectId(params.flowId),
          entity: params.entity,
        },
        {
          $inc: { consecutiveFailures: 1 },
          $set: {
            lastFailedAt: new Date(),
            lastFailureError: errorMessage.slice(0, 500),
          },
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
