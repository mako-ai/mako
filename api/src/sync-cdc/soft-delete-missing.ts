/**
 * Soft-delete rows that a complete full read of a small entity no longer
 * lists. A poll re-reads rosters whose source ignores `since` (Close users,
 * Google directory users, Intercom admins) in full, but polls only upsert, so
 * a row that left the listing stayed live in the destination for good. The
 * periodic full backfill does not sweep either (B2 in
 * docs/sync-modes-hardening-plan.md; that phase stays open).
 *
 * The listed ids, not `_syncedAt`, say what is gone: the writer skips
 * unchanged rows, so their `_syncedAt` never moves.
 */
import { loggers } from "../logging";
import type {
  CdcDestinationAdapter,
  CdcEntityLayout,
} from "./adapters/registry";

const log = loggers.sync("cdc.soft-delete-missing");

/** Above this many listed ids the entity is no small roster: no sweep. */
export const SOFT_DELETE_MISSING_MAX_IDS = 10_000;
/** A listing under this share of the live rows is a broken read, not a roster change. */
export const SOFT_DELETE_MISSING_MIN_LISTED_RATIO = 0.5;

export type SoftDeleteMissingOutcome =
  | { status: "deleted"; marked: number | undefined }
  | { status: "unchanged" }
  | { status: "skipped"; reason: string }
  | { status: "unsupported" };

export async function softDeleteMissingRows(params: {
  adapter: Pick<
    CdcDestinationAdapter,
    "destinationType" | "countLiveRows" | "softDeleteRowsNotIn"
  >;
  layout: CdcEntityLayout;
  /** Ids the complete read listed. */
  ids: readonly string[];
  /** The read listed more ids than were kept (SOFT_DELETE_MISSING_MAX_IDS). */
  overflowed: boolean;
  deleteMode: "hard" | "soft" | undefined;
  /** Caller already established the read was complete, in one chunk, with no error. */
  logger?: {
    log: (level: "info" | "warn", msg: string, meta?: unknown) => void;
  };
}): Promise<SoftDeleteMissingOutcome> {
  const { adapter, layout, overflowed } = params;
  const entity = layout.entity;
  const skip = (reason: string, level: "info" | "warn" = "info") => {
    const meta = { entity, table: layout.tableName, reason };
    log[level]("Soft-delete of missing rows skipped", meta);
    params.logger?.log(
      level,
      `Soft-delete of missing ${entity} rows skipped: ${reason}`,
      meta,
    );
    return { status: "skipped", reason } as const;
  };

  // Guard 3: never hard-delete, and never decide for a flow that keeps no tombstones.
  if (params.deleteMode !== "soft") return skip("delete_mode is not soft");
  if (layout.writeMode && layout.writeMode !== "append_dedup") {
    return skip(`write_mode is ${layout.writeMode}`);
  }
  // Guard 5: only small rosters.
  if (overflowed) {
    return skip(`the listing has more than ${SOFT_DELETE_MISSING_MAX_IDS} ids`);
  }
  // Guard 1: an empty listing is a failed read until proven otherwise.
  const ids = [...new Set(params.ids)];
  if (ids.length === 0) return skip("the listing is empty");
  if (layout.keyColumns.length !== 1) {
    return skip("the entity has a composite key");
  }
  if (!adapter.countLiveRows || !adapter.softDeleteRowsNotIn) {
    log.info("Soft-delete of missing rows unsupported by the destination", {
      entity,
      destination: adapter.destinationType,
    });
    return { status: "unsupported" };
  }

  const keyColumn = layout.keyColumns[0];
  const counts = await adapter.countLiveRows(layout, keyColumn, ids);
  if (!counts) return skip("the live rows could not be counted");
  if (counts.live === 0) return skip("the destination has no live rows");
  // Guard 2: a listing far smaller than the table is a broken read.
  if (ids.length < counts.live * SOFT_DELETE_MISSING_MIN_LISTED_RATIO) {
    return skip(
      `the listing has ${ids.length} ids against ${counts.live} live rows (under ${SOFT_DELETE_MISSING_MIN_LISTED_RATIO * 100}%)`,
      "warn",
    );
  }
  if (counts.missing === 0) return { status: "unchanged" };

  const { marked } = await adapter.softDeleteRowsNotIn(layout, keyColumn, ids);
  params.logger?.log(
    "info",
    `Soft-deleted ${marked ?? counts.missing} ${entity} rows missing from the listing`,
    { entity, marked, missing: counts.missing },
  );
  return { status: "deleted", marked };
}
