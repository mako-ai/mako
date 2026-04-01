import { loggers } from "../logging";
import { normalizeCdcEvent, type NormalizedCdcEvent } from "./events";
import { getCdcEventStore } from "./event-store";
import { cdcSyncStateService } from "./sync-state";

const log = loggers.sync("cdc.ingest");

class CdcIngestService {
  /**
   * Append normalized CDC events to the event store and update ingest state.
   *
   * Materialization is NOT triggered inline — the cdcMaterializeSchedulerFunction
   * cron picks up stale entities every ~30 s by comparing lastIngestSeq vs
   * lastMaterializedSeq in CdcEntityState. The `enqueue` parameter is retained
   * for backward compatibility but is a no-op.
   */
  async appendNormalizedEvents(params: {
    workspaceId: string;
    flowId: string;
    events: Array<NormalizedCdcEvent & { webhookEventId?: string }>;
    enqueue?: boolean;
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
    });

    return result;
  }
}

export const cdcIngestService = new CdcIngestService();
