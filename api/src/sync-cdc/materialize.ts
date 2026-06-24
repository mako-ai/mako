import type { IFlow } from "../database/workspace-schema";
import {
  normalizePayloadKeys,
  resolveSourceTimestamp,
  selectLatestChangePerRecord,
} from "./normalization";
import type { CdcStoredEvent } from "./events";
import type { CdcEntityLayout } from "./adapters/registry";

/**
 * Result of turning a batch of stored CDC events into destination-ready rows.
 *
 * Every destination adapter (PostgreSQL, MongoDB, ClickHouse, BigQuery) shaped
 * upsert/soft-delete rows identically and only differed in HOW the rows are
 * written and how hard deletes are keyed. This shared materialization owns the
 * row shaping so that change can't drift per-adapter; adapters consume these
 * arrays and perform their destination-specific writes.
 */
export interface MaterializedCdcEvents {
  /** One event per record (latest change wins; see `selectLatestChangePerRecord`). */
  latest: CdcStoredEvent[];
  /** Resolved delete behavior: flow override → layout default → "hard". */
  deleteMode: "hard" | "soft";
  /** Live rows to upsert, including the `_mako_*` / `is_deleted` system columns. */
  upsertRows: Record<string, unknown>[];
  /**
   * Live rows representing soft deletes (same shape as `upsertRows` but with
   * deletion markers set). Empty unless `deleteMode === "soft"`.
   */
  softDeleteRows: Record<string, unknown>[];
  /**
   * Raw delete events to remove from the destination. Empty unless
   * `deleteMode === "hard"`. Adapters derive their own delete keys from these,
   * since key derivation differs per destination.
   */
  hardDeleteEvents: CdcStoredEvent[];
  /** Resolved fallback data source id, for adapters that build delete keys. */
  fallbackDataSourceId: string | undefined;
  /** Number of records affected by this batch (`latest.length`). */
  applied: number;
}

/**
 * Build a single destination "live" row from a CDC event, applying the shared
 * key normalization, source-timestamp resolution, and `_mako_*` system columns.
 */
function buildLiveRow(
  event: CdcStoredEvent,
  fallbackDataSourceId: string | undefined,
  deleted: boolean,
): Record<string, unknown> {
  const payload = normalizePayloadKeys(event.payload || {});
  const sourceTs = resolveSourceTimestamp(payload, new Date(event.sourceTs));
  const deletedAt = deleted ? new Date() : null;
  return {
    ...payload,
    id: event.recordId,
    _dataSourceId: payload._dataSourceId ?? fallbackDataSourceId,
    _mako_source_ts: sourceTs,
    _mako_ingest_seq: Number(event.ingestSeq),
    _mako_deleted_at: deletedAt,
    is_deleted: deleted,
    deleted_at: deletedAt,
  };
}

/**
 * Deduplicate a batch of stored CDC events to the latest change per record and
 * shape them into upsert rows, soft-delete rows, and hard-delete events
 * according to the resolved delete mode.
 */
export function materializeCdcEvents(params: {
  events: CdcStoredEvent[];
  layout: Pick<CdcEntityLayout, "deleteMode">;
  flow: Pick<IFlow, "deleteMode" | "dataSourceId">;
}): MaterializedCdcEvents {
  const latest = selectLatestChangePerRecord(params.events);
  const fallbackDataSourceId = params.flow.dataSourceId
    ? String(params.flow.dataSourceId)
    : undefined;
  const deleteMode =
    params.flow.deleteMode || params.layout.deleteMode || "hard";

  const upsertRows: Record<string, unknown>[] = [];
  const softDeleteRows: Record<string, unknown>[] = [];
  const hardDeleteEvents: CdcStoredEvent[] = [];

  for (const event of latest) {
    if (event.operation === "upsert") {
      upsertRows.push(buildLiveRow(event, fallbackDataSourceId, false));
    } else if (deleteMode === "soft") {
      softDeleteRows.push(buildLiveRow(event, fallbackDataSourceId, true));
    } else {
      hardDeleteEvents.push(event);
    }
  }

  return {
    latest,
    deleteMode,
    upsertRows,
    softDeleteRows,
    hardDeleteEvents,
    fallbackDataSourceId,
    applied: latest.length,
  };
}
