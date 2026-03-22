import { loggers } from "../logging";
import { inngest } from "../inngest/client";
import { BaseConnector } from "../connectors/base/BaseConnector";
import { normalizeCdcEvent, type NormalizedCdcEvent } from "./events";
import { getCdcEventStore } from "./event-store";
import { cdcSyncStateService } from "./sync-state";

const log = loggers.sync("cdc.ingest");

export class CdcIngestService {
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

  async appendWebhookEvent(params: {
    workspaceId: string;
    flowId: string;
    connector: BaseConnector;
    event: unknown;
    eventType?: string;
    runId?: string;
    enqueue?: boolean;
  }): Promise<{ inserted: number; deduped: number }> {
    const records = params.connector.extractWebhookCdcRecords(
      params.event,
      params.eventType,
    );
    const events = records.map(record =>
      normalizeCdcEvent({
        entity: record.entity,
        recordId: record.recordId,
        operation: record.operation,
        payload: record.payload,
        sourceTs: record.sourceTs,
        source: record.source,
        changeId: record.changeId,
        runId: params.runId,
      }),
    );
    return this.appendNormalizedEvents({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      events,
      enqueue: params.enqueue,
    });
  }
}

export const cdcIngestService = new CdcIngestService();
