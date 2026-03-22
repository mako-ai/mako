import {
  BaseConnector,
  NormalizedCdcRecord,
} from "../../connectors/base/BaseConnector";
import { normalizeCdcEvent, NormalizedCdcEvent } from "../contracts/events";
import { CdcSourceAdapter } from "../contracts/adapters";

function toCanonicalEvent(
  record: NormalizedCdcRecord,
  runId?: string,
): NormalizedCdcEvent {
  return normalizeCdcEvent({
    entity: record.entity,
    recordId: record.recordId,
    operation: record.operation,
    payload: record.payload,
    sourceTs: record.sourceTs,
    source: record.source,
    changeId: record.changeId,
    runId,
  });
}

export class BaseConnectorCdcAdapter implements CdcSourceAdapter {
  constructor(private readonly connector: BaseConnector) {}

  async fromWebhook(params: {
    event: unknown;
    eventType?: string;
    runId?: string;
  }): Promise<NormalizedCdcEvent[]> {
    const records = this.connector.extractWebhookCdcRecords(
      params.event,
      params.eventType,
    );
    return records.map(record => toCanonicalEvent(record, params.runId));
  }

  async fromBackfill(params: {
    entity: string;
    records: Array<Record<string, unknown>>;
    runId?: string;
  }): Promise<NormalizedCdcEvent[]> {
    const normalized: NormalizedCdcEvent[] = [];
    for (const record of params.records) {
      const converted = this.connector.normalizeBackfillRecord(
        params.entity,
        record,
      );
      if (!converted) continue;
      normalized.push(toCanonicalEvent(converted, params.runId));
    }
    return normalized;
  }
}
