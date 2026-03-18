import { Types } from "mongoose";
import { CdcChangeEvent } from "../database/workspace-schema";
import { loggers } from "../logging";
import { BaseConnector } from "../connectors/base/BaseConnector";
import {
  NormalizedCdcEvent,
  normalizeCdcEvent,
} from "./contracts/cdc-event";
import { appendBigQueryChangeEvents } from "../services/bigquery-cdc.service";

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
    const result = await appendBigQueryChangeEvents({
      workspaceId: workspaceObjectId,
      flowId: flowObjectId,
      enqueue: params.enqueue !== false,
      changes: normalized.map(event => ({
        entity: event.entity,
        recordId: event.recordId,
        op: event.operation,
        payload: event.payload,
        sourceTs: event.sourceTs,
        sourceKind: event.source,
        idempotencyKey: event.changeId,
        runId: event.runId,
      })),
    });

    log.info("CDC events appended", {
      flowId: params.flowId,
      inserted: result.inserted,
      deduped: result.deduped,
    });

    return result;
  }

  async appendWebhookPayload(params: {
    workspaceId: string;
    flowId: string;
    connector: BaseConnector;
    event: unknown;
    eventType?: string;
    runId?: string;
  }): Promise<{ inserted: number; deduped: number }> {
    const records = params.connector.extractWebhookCdcRecords(
      params.event,
      params.eventType,
    );

    return this.appendNormalizedEvents({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      events: records.map(record => ({
        ...record,
        runId: params.runId,
      })),
    });
  }

  async getPendingBacklogCount(workspaceId: string, flowId: string) {
    return CdcChangeEvent.countDocuments({
      workspaceId: new Types.ObjectId(workspaceId),
      flowId: new Types.ObjectId(flowId),
      materializationStatus: "pending",
    });
  }
}

export const cdcIngestService = new CdcIngestService();
