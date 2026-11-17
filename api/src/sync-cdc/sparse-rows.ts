/**
 * Sparse rows: a CDC writer updates only the columns a record carries.
 *
 * A key that is absent from a record means "unknown here, leave the stored
 * value". A key that is present with `null` means "the source cleared it".
 * Keys whose value is `undefined` count as absent, which is what JSON does to
 * them at the connector box boundary.
 *
 * Why: some fields reach us through one path only. Close sends `lead.source`
 * and `meeting.calendar_event_link` in webhooks, while its Search and GET
 * never return them. A poll or a full re-read that wrote every schema column
 * NULLed those fields on every row it touched.
 *
 * Row-based writers (Postgres, MySQL, Mongo) write each row with its own
 * key set. The columnar BigQuery load cannot leave a cell out, so each
 * staging row carries `_mako_absent_cols`, the columns it lacks, and the
 * MERGE keeps the live value for those (see buildMergeStatement).
 */

/** Staging-only column: `,a,b,` lists the columns this row lacks. */
export const ABSENT_COLUMNS_FIELD = "_mako_absent_cols";

/** A copy of `row` without the keys whose value is `undefined`. */
export function stripUndefined<T extends Record<string, unknown>>(row: T): T {
  let hasUndefined = false;
  for (const key in row) {
    if (row[key] === undefined) {
      hasUndefined = true;
      break;
    }
  }
  if (!hasUndefined) return row;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

export function encodeAbsentColumns(columns: string[]): string | undefined {
  return columns.length > 0 ? `,${columns.join(",")},` : undefined;
}

/** The SQL literal a MERGE searches the marker for. */
export function absentColumnNeedle(column: string): string {
  return `,${column},`;
}

/**
 * Mark each row with the columns of `columns` it lacks. Rows that lack
 * nothing get no marker key, so a batch of complete rows stages exactly as
 * before.
 */
export function markAbsentColumns(
  rows: Record<string, unknown>[],
  columns: Iterable<string>,
): Record<string, unknown>[] {
  const cols = [...columns].filter(c => c !== ABSENT_COLUMNS_FIELD);
  return rows.map(raw => {
    const row = stripUndefined(raw);
    const absent = cols.filter(c => !(c in row));
    const marker = encodeAbsentColumns(absent);
    if (marker === undefined) {
      if (!(ABSENT_COLUMNS_FIELD in row)) return row;
      const { [ABSENT_COLUMNS_FIELD]: _drop, ...rest } = row;
      return rest;
    }
    return { ...row, [ABSENT_COLUMNS_FIELD]: marker };
  });
}

/**
 * Prepare one in-memory batch for a columnar staging load. Returns the rows
 * (undefined keys dropped, absent columns marked) and the columns at least
 * one row carries. A column that every row lacks stays out of staging; a
 * column that some row carries as `null` stays in.
 */
export function prepareSparseBatch(rows: Record<string, unknown>[]): {
  rows: Record<string, unknown>[];
  presentColumns: Set<string>;
} {
  const stripped = rows.map(stripUndefined);
  const presentColumns = new Set<string>();
  for (const row of stripped) {
    for (const key of Object.keys(row)) presentColumns.add(key);
  }
  presentColumns.delete(ABSENT_COLUMNS_FIELD);
  return {
    rows: markAbsentColumns(stripped, presentColumns),
    presentColumns,
  };
}

/**
 * Split rows into groups that share one key set, in first-seen order. A
 * row-based writer builds one column list per call, so each group writes
 * only its own columns.
 */
export function groupRowsByKeySet(
  rows: Record<string, unknown>[],
): Record<string, unknown>[][] {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const raw of rows) {
    const row = stripUndefined(raw);
    const signature = Object.keys(row).sort().join("\u0000");
    const group = groups.get(signature);
    if (group) group.push(row);
    else groups.set(signature, [row]);
  }
  return [...groups.values()];
}

interface BatchWriter<O> {
  writeBatch(
    rows: Record<string, unknown>[],
    options?: O,
  ): Promise<{ success: boolean; rowsWritten: number; error?: string }>;
}

/** writeBatch once per key set (see groupRowsByKeySet). */
export async function writeBatchByKeySet<O>(
  writer: BatchWriter<O>,
  rows: Record<string, unknown>[],
  options?: O,
): Promise<{ success: boolean; rowsWritten: number; error?: string }> {
  let rowsWritten = 0;
  for (const group of groupRowsByKeySet(rows)) {
    const result = await writer.writeBatch(group, options);
    if (!result.success) return { ...result, rowsWritten };
    rowsWritten += result.rowsWritten;
  }
  return { success: true, rowsWritten };
}
