import { Types } from "mongoose";
import { loggers } from "../logging";
import { BaseConnector } from "../connectors/base/BaseConnector";
import { NormalizedCdcEvent, normalizeCdcEvent } from "./contracts/events";
import { resolveCdcSourceAdapter } from "./sources/registry";
import { getCdcEventStore } from "./stores";
import { onCdcEventsAppended } from "./runtime.service";

const log = loggers.sync("cdc.ingest");

export class CdcIngestService {
  async appendNormalizedEvents(params: {
    workspaceId: string;
    flowId: string;
    events: NormalizedCdcEvent[];
    enqueue?: boolean;
  }): Promise<{ inserted: number; deduped: number }> {
    const workspaceObjectId = new Types.ObjectId(params.workspaceId);
    const flowObjectId = new Types.ObjectId(params.flowId);

    const normalized = params.events.map(event => normalizeCdcEvent(event));
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
      })),
    });
    await onCdcEventsAppended({
      workspaceId: workspaceObjectId,
      flowId: flowObjectId,
      entities: result.entities.map(entity => ({
        entity: entity.entity,
        sourceKind: entity.source,
        runId: entity.runId,
        lastIngestSeq: entity.lastIngestSeq,
      })),
      enqueue: params.enqueue !== false,
    });

    log.info("CDC events appended", {
      flowId: params.flowId,
      inserted: result.inserted,
      deduped: result.deduped,
      attempted: result.attempted,
    });

    return result;
  }

  async appendBackfillRecords(params: {
    workspaceId: string;
    flowId: string;
    connector: BaseConnector;
    connectorType?: string;
    entity: string;
    records: Array<Record<string, unknown>>;
    runId?: string;
    enqueue?: boolean;
  }): Promise<{ inserted: number; deduped: number }> {
    const adapter = resolveCdcSourceAdapter({
      connector: params.connector,
      connectorType: params.connectorType,
    });
    const events = await adapter.fromBackfill({
      entity: params.entity,
      records: params.records,
      runId: params.runId,
    });
    return this.appendNormalizedEvents({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      events,
      enqueue: params.enqueue,
    });
  }
}

export const cdcIngestService = new CdcIngestService();
