import { loggers } from "../logging";
import { normalizeCdcEvent, type NormalizedCdcEvent } from "./events";
import { getCdcEventStore } from "./event-store";
import { cdcSyncStateService } from "./sync-state";

const log = loggers.sync("cdc.ingest");

class CdcIngestService {
  /**
   * Append normalized CDC events to the event store and update ingest state.
   *
   * The caller (webhookEventProcessCdcFunction) triggers materialization
   * inline by emitting cdc/materialize events immediately after this call.
   * The cdcMaterializeSchedulerFunction cron (every 1 min) acts as a safety
   * net for any entities missed by the inline trigger.
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
      entityBreakdown: result.entities.map(entity => ({
        entity: entity.entity,
        source: entity.source,
        lastIngestSeq: entity.lastIngestSeq,
        runId: entity.runId,
      })),
    });

    return result;
  }
}

export const cdcIngestService = new CdcIngestService();
