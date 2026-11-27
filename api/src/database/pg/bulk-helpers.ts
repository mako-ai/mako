/**
 * Shared chunking, deduplication, and batch-prefetch helpers for vectorized
 * Postgres repository writes.
 *
 * Keeps every multi-row `INSERT ... VALUES (...), (...)` well below Postgres's
 * 65,535 bind-parameter protocol limit and prevents Postgres `21000`
 * ("ON CONFLICT DO UPDATE command cannot affect row a second time") errors.
 */
import { getTableColumns, inArray, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { MakoPgDb } from "./client";
import { isUuidString } from "./id-codec";
import { users } from "./schema/auth";

/** Hard ceiling for bind parameters per statement (PG wire limit is 65,535). */
export const MAX_PG_BIND_PARAMS = 50_000;

/** Default maximum number of rows per bulk multi-row INSERT statement. */
export const DEFAULT_BULK_INSERT_ROWS = 300;

/** Default maximum number of values per `IN (...)` prefetch query. */
export const DEFAULT_IN_ARRAY_CHUNK = 5_000;

/**
 * Split `rows` into chunks that respect both `maxRows` and Postgres's 65,535
 * bind-parameter limit (`floor(50_000 / columnsPerRow)`).
 */
export function chunkRows<T>(
  rows: readonly T[],
  columnsPerRow: number,
  maxRows: number = DEFAULT_BULK_INSERT_ROWS,
): T[][] {
  if (rows.length === 0) return [];
  const size = Math.max(
    1,
    Math.min(
      maxRows,
      Math.floor(MAX_PG_BIND_PARAMS / Math.max(1, columnsPerRow)),
    ),
  );
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}

/** Split a scalar value list into safe `IN (...)` chunks. */
export function chunkValues<T>(
  values: readonly T[],
  chunkSize: number = DEFAULT_IN_ARRAY_CHUNK,
): T[][] {
  if (values.length === 0) return [];
  const size = Math.max(1, chunkSize);
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

/**
 * Deduplicate `items` by `getKey`, preserving first-seen order.
 * Defaults to keeping the latest (`incoming`) entry; supply `merge` to keep
 * the first entry or keep the newest `updatedAt`.
 */
export function dedupByKey<T>(
  items: readonly T[],
  getKey: (item: T) => string,
  merge: (existing: T, incoming: T) => T = (_existing, incoming) => incoming,
): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    const key = getKey(item);
    const prev = map.get(key);
    if (prev !== undefined) {
      map.set(key, merge(prev, item));
    } else {
      map.set(key, item);
    }
  }
  return [...map.values()];
}

/** Keep the row whose `updatedAt` is newer (breaking ties in favor of `incoming`). */
export function pickNewerByUpdatedAt<
  T extends { updatedAt?: Date | null | undefined },
>(existing: T, incoming: T): T {
  const existingMs = existing.updatedAt?.getTime() ?? -Infinity;
  const incomingMs = incoming.updatedAt?.getTime() ?? -Infinity;
  return incomingMs >= existingMs ? incoming : existing;
}

/**
 * Build a Drizzle `ON CONFLICT DO UPDATE` `set` object mapping every column on
 * `table` (except `omitKeys`) to `EXCLUDED."<sql_column_name>"`, with optional
 * per-column SQL expression overrides.
 */
export function buildExcludedSet<TTable extends PgTable>(
  table: TTable,
  omitKeys: readonly (keyof TTable["$inferInsert"])[] = [],
  overrides?: Partial<Record<keyof TTable["$inferInsert"], SQL>>,
): Partial<Record<keyof TTable["$inferInsert"], SQL>> {
  const omit = new Set<string>(omitKeys as readonly string[]);
  const cols = getTableColumns(table);
  const out: Record<string, SQL> = {};
  for (const [propKey, col] of Object.entries(cols)) {
    if (omit.has(propKey) || col.generated !== undefined) continue;
    out[propKey] = sql.raw(`EXCLUDED."${col.name}"`);
  }
  if (overrides) {
    for (const [propKey, expr] of Object.entries(overrides)) {
      if (expr !== undefined) {
        out[propKey] = expr as SQL;
      }
    }
  }
  return out as Partial<Record<keyof TTable["$inferInsert"], SQL>>;
}

/**
 * Batch-prefetch existing lowercase string/UUID keys from `table` matching `ids`.
 */
export async function prefetchExistingKeySet(
  db: MakoPgDb,
  table: PgTable,
  column: PgColumn,
  ids: readonly string[],
  options: { lowercase?: boolean } = {},
): Promise<Set<string>> {
  const lowercase = options.lowercase ?? true;
  const unique = [
    ...new Set(
      ids.filter(Boolean).map(id => (lowercase ? id.toLowerCase() : id)),
    ),
  ];
  const found = new Set<string>();
  if (unique.length === 0) return found;
  for (const chunk of chunkValues(unique)) {
    const rows = await db
      .select({ key: column })
      .from(table)
      .where(inArray(column, chunk));
    for (const row of rows) {
      if (typeof row.key === "string") {
        found.add(lowercase ? row.key.toLowerCase() : row.key);
      }
    }
  }
  return found;
}

/**
 * Batch-prefetch `users(id, legacy_id)` mapping every resolved `id` (lowercase),
 * `legacy_id` (verbatim), and UUID-shaped `legacy_id` (lowercase) to its
 * canonical lowercase Postgres `users.id` UUID.
 */
export async function prefetchPgUserUuidMap(
  db: MakoPgDb,
  rawIds: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const unique = [
    ...new Set(
      rawIds
        .map(v => (typeof v === "string" ? v.trim() : ""))
        .filter(v => v.length > 0),
    ),
  ];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  for (const chunk of chunkValues(unique)) {
    const uuidCandidates = chunk.filter(isUuidString).map(u => u.toLowerCase());
    const whereClause =
      uuidCandidates.length > 0
        ? or(inArray(users.id, uuidCandidates), inArray(users.legacyId, chunk))
        : inArray(users.legacyId, chunk);
    const rows = await db
      .select({ id: users.id, legacyId: users.legacyId })
      .from(users)
      .where(whereClause);
    for (const row of rows) {
      const pgId = row.id.toLowerCase();
      out.set(pgId, pgId);
      if (row.legacyId) {
        out.set(row.legacyId, pgId);
        if (isUuidString(row.legacyId)) {
          out.set(row.legacyId.toLowerCase(), pgId);
        }
      }
    }
  }
  return out;
}
