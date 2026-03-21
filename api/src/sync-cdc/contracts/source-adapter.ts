import type { NormalizedCdcEvent } from "./cdc-event";

export interface CdcSourceAdapter {
  fromWebhook(params: {
    event: unknown;
    eventType?: string;
    runId?: string;
  }): Promise<NormalizedCdcEvent[]>;
  fromBackfill(params: {
    entity: string;
    records: Array<Record<string, unknown>>;
    runId?: string;
  }): Promise<NormalizedCdcEvent[]>;
}
