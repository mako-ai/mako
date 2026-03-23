import { loggers } from "../logging";
import { inngest } from "../inngest/client";
import { normalizeCdcEvent, type NormalizedCdcEvent } from "./events";
import { getCdcEventStore } from "./event-store";
import { cdcSyncStateService } from "./sync-state";

const log = loggers.sync("cdc.ingest");

class CdcIngestService {
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

    for (const entity of result.entities) {
      await cdcSyncStateService.updateIngestState({
        workspaceId: params.workspaceId,
        flowId: params.flowId,
        entity: entity.entity,
        sourceKind: entity.source,
        runId: entity.runId,
        lastIngestSeq: entity.lastIngestSeq,
      });

      if (params.enqueue !== false) {
        await inngest.send({
          name: "cdc/materialize",
          data: {
            workspaceId: params.workspaceId,
            flowId: params.flowId,
            entity: entity.entity,
            force: false,
          },
        });
      }
    }

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
