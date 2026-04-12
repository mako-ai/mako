import type { IFlow } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import type { CdcStoredEvent } from "../events";
import type { CdcEntityLayout } from "./registry";
import { normalizePayloadKeys, resolveSourceTimestamp } from "../normalization";

const log = loggers.sync("cdc.adapter");

export function resolveFallbackDataSourceId(
  flow: Pick<IFlow, "dataSourceId">,
): string | undefined {
  return flow.dataSourceId ? String(flow.dataSourceId) : undefined;
}

export function resolveDeleteMode(
  flow: Pick<IFlow, "deleteMode">,
  layout: CdcEntityLayout,
): "hard" | "soft" {
  return (flow.deleteMode || layout.deleteMode || "hard") as "hard" | "soft";
}

export function partitionEventsByOperation(events: CdcStoredEvent[]): {
  upserts: CdcStoredEvent[];
  deletes: CdcStoredEvent[];
} {
  const upserts: CdcStoredEvent[] = [];
  const deletes: CdcStoredEvent[] = [];
  for (const event of events) {
    if (event.operation === "delete") {
      deletes.push(event);
    } else {
      upserts.push(event);
    }
  }
  return { upserts, deletes };
}

export function buildUpsertRow(
  event: CdcStoredEvent,
  fallbackDataSourceId?: string,
): Record<string, unknown> {
  const payload = normalizePayloadKeys(event.payload || {});
  const sourceTs = resolveSourceTimestamp(payload, new Date(event.sourceTs));
  return {
    ...payload,
    id: event.recordId,
    _dataSourceId: payload._dataSourceId ?? fallbackDataSourceId,
    _mako_source_ts: sourceTs,
    _mako_ingest_seq: Number(event.ingestSeq),
    _mako_deleted_at: null,
    is_deleted: false,
    deleted_at: null,
  };
}

export function buildSoftDeleteRow(
  event: CdcStoredEvent,
  fallbackDataSourceId?: string,
): Record<string, unknown> {
  const payload = normalizePayloadKeys(event.payload || {});
  const sourceTs = resolveSourceTimestamp(payload, new Date(event.sourceTs));
  const deletedAt = new Date();
  return {
    ...payload,
    id: event.recordId,
    _dataSourceId: payload._dataSourceId ?? fallbackDataSourceId,
    _mako_source_ts: sourceTs,
    _mako_ingest_seq: Number(event.ingestSeq),
    _mako_deleted_at: deletedAt,
    is_deleted: true,
    deleted_at: deletedAt,
  };
}

export function buildBatchRow(
  record: Record<string, unknown>,
  fallbackDataSourceId?: string,
): Record<string, unknown> {
  const payload = normalizePayloadKeys(record);
  return {
    ...payload,
    _dataSourceId: payload._dataSourceId ?? fallbackDataSourceId,
    _mako_source_ts: resolveSourceTimestamp(payload),
    _mako_ingest_seq:
      typeof payload._mako_ingest_seq === "number"
        ? payload._mako_ingest_seq
        : undefined,
  };
}

export function getStagingTableName(
  tableName: string,
  flowId: string,
  suffix?: string,
): string {
  const flowToken = flowId.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
  return `${tableName}__${flowToken}__${suffix || "staging"}`;
}

export async function retryOnTransient<T>(
  fn: () => Promise<T>,
  opts: {
    label: string;
    maxRetries?: number;
    isTransient?: (err: unknown) => boolean;
  },
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 4;
  const isTransient = opts.isTransient ?? (() => false);
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isTransient(err)) throw err;
      const backoffMs = Math.min(30_000, 5_000 * 2 ** attempt);
      log.warn(`${opts.label}: transient error, retrying in ${backoffMs}ms`, {
        attempt: attempt + 1,
        maxRetries,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
}
