import { loggers } from "../logging";
import { normalizeCdcEvent, type NormalizedCdcEvent } from "./events";
import { getCdcEventStore } from "./event-store";
import { cdcSyncStateService } from "./sync-state";

const log = loggers.sync("cdc.ingest");

class CdcIngestService {
  /**
   * Append normalized CDC events to the event store and update ingest state.
   *
   * Called by the 2-min cron scheduler (cdcMaterializeSchedulerFunction)
   * during the ingest step, and by the backfill system.
   */
  async appendNormalizedEvents(params: {
    workspaceId: string;
    flowId: string;
    events: Array<NormalizedCdcEvent & { webhookEventId?: string }>;
  }): Promise<{ inserted: number; deduped: number }> {
    const normalized = params.events.map(event => ({
      ...normalizeCdcEvent(event),
      webhookEventId: event.webhookEventId,
    }));
    const eventStore = getCdcEventStore();
    const result = await eventStore.appendEvents({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      events: normalized.map(event => ({
        entity: event.entity,
        recordId: event.recordId,
        operation: event.operation,
        payload: event.payload,
        sourceTs: event.sourceTs,
        source: event.source,
        idempotencyKey: event.changeId,
        runId: event.runId,
        webhookEventId: event.webhookEventId,
      })),
    });

    await Promise.all(
      result.entities.map(entity =>
        cdcSyncStateService.updateIngestState({
          workspaceId: params.workspaceId,
          flowId: params.flowId,
          entity: entity.entity,
          sourceKind: entity.source,
          runId: entity.runId,
          lastIngestSeq: entity.lastIngestSeq,
        }),
      ),
    );

    log.info("CDC webhook events appended", {
      flowId: params.flowId,
      inserted: result.inserted,
      deduped: result.deduped,
      attempted: result.attempted,
      entities: result.entities.map(entity => entity.entity),
      entityBreakdown: result.entities.map(entity => ({
        entity: entity.entity,
        source: entity.source,
        lastIngestSeq: entity.lastIngestSeq,
        runId: entity.runId,
      })),
    });

    // Guardrail: a persistently high dedup ratio is the signature of a
    // non-unique idempotency key silently dropping real changes (the Close
    // `lead.updated:<recordId>` bug). Emit an alertable WARN on a stable `code`
    // so this class of data loss can never go unnoticed for long again.
    const HIGH_DEDUP_MIN_ATTEMPTED = 20;
    const HIGH_DEDUP_RATIO = 0.9;
    if (
      result.attempted >= HIGH_DEDUP_MIN_ATTEMPTED &&
      result.deduped / result.attempted >= HIGH_DEDUP_RATIO
    ) {
      log.warn("CDC ingest dedup rate high", {
        code: "CDC_HIGH_DEDUP_RATE",
        flowId: params.flowId,
        attempted: result.attempted,
        deduped: result.deduped,
        inserted: result.inserted,
        dedupRatio: Number((result.deduped / result.attempted).toFixed(3)),
        entities: result.entities.map(entity => entity.entity),
      });
    }

    return result;
  }
}

export const cdcIngestService = new CdcIngestService();
