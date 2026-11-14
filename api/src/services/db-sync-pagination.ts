/**
 * Query building and cursor tracking for database-source flow chunks: the
 * ONE place a chunk's SQL is built, for the run (executeDbSyncChunk) and the
 * dry run alike.
 *
 * There is a single mode, template mode: the query's `{{limit}}`,
 * `{{offset}}`, `{{last_sync_value}}` and `{{keyset_value}}` placeholders
 * are substituted. A query written without placeholders (every flow saved
 * before templates existed, and any the user writes plain) is translated
 * into its template equivalent when the chunk is built — paging clauses
 * appended as `LIMIT {{limit}} OFFSET {{offset}}`, the cursor predicates
 * the placeholders cannot express spelled out — and then substituted the
 * same way. Translating at load time, not in a data migration, is
 * deliberate: flow definitions live in `flows/<slug>.yml` in the workspace
 * repo, so a rewritten Mongo copy would be resynced away, and the tie-safe
 * predicates below have no placeholder to be rewritten into.
 *
 * Pure (no drivers, no Mongoose) so the paging contract can be tested
 * against a real SQL engine. The contract for a translated query:
 *
 * - **Incremental ties.** `tracking > lastValue` never picks up a row
 *   committed later with the SAME timestamp as the last synced max — a
 *   classic lost update on a timestamp watermark. With key columns the
 *   filter is `>=`: the tied rows are re-read and the destination's upsert
 *   on the key columns dedupes them. Without key columns (append) `>`
 *   stays, since `>=` would duplicate every tied row on every run.
 * - **Keyset ties.** `keyset > last` on a non-unique column drops every
 *   row tied with the last row of a page. The key columns are added as a
 *   tiebreaker: `(k, pk...) > (lastK, lastPk...)`, spelled out as
 *   `k > a OR (k = a AND pk > b)` because row-value comparison is not
 *   portable (BigQuery, SQL Server).
 * - **Offset ordering.** Chunks run in separate Inngest steps, minutes
 *   apart. `ORDER BY 1` (or a non-unique tracking column) is not a total
 *   order, so OFFSET pages could overlap or skip. The key columns are
 *   appended as a tiebreaker when present.
 * - **Literal types.** A numeric-looking string cursor (`"00123"`) was
 *   compared as the number 123. Cursor values now carry their JS type.
 */
import {
  appendSqlClause,
  appendWhereCondition,
  findTopLevelKeyword,
} from "./sql-query-utils";
import {
  detectTemplates,
  substituteTemplates,
  type TemplateValues,
} from "../utils/template-substitution";

export type CursorValueType = "number" | "string";

/** One column's value at the cursor, with the type it was read as. */
export interface CursorValue {
  column: string;
  value: string;
  /** Absent only for a value from before types were recorded. */
  type?: CursorValueType;
}

export interface ChunkCursorState {
  offset: number;
  lastKeysetValue?: string;
  /** Type of `lastKeysetValue`; absent on state written before it existed. */
  lastKeysetValueType?: CursorValueType;
  /** Key-column values of the last row, the keyset tiebreaker. */
  lastKeysetTiebreaker?: CursorValue[];
}

export interface ChunkQueryInput {
  sourceQuery: string;
  syncMode: "full" | "incremental";
  incrementalConfig?: {
    trackingColumn?: string;
    trackingType?: string;
    lastValue?: string;
  };
  paginationMode: "offset" | "keyset";
  keysetColumn?: string;
  keysetDirection: "asc" | "desc";
  keyColumns?: string[];
  maxRowsPerChunk: number;
  state: ChunkCursorState;
  /** The flow's saved keyset value, used when the run has none yet. */
  savedKeysetValue?: string;
}

function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A SQL literal for a cursor value. A value known to be a string is always
 * quoted; a number is emitted bare only if it really is finite. With no
 * type (state from before types were recorded) the old heuristic applies.
 */
export function cursorLiteral(value: string, type?: CursorValueType): string {
  if (type === "string") return quoteString(value);
  const num = Number(value);
  if (value.trim() !== "" && !isNaN(num) && isFinite(num)) {
    return String(num);
  }
  return quoteString(value);
}

/** Incremental watermark literal, by the flow's declared tracking type. */
function trackingLiteral(value: string, trackingType: string): string {
  if (trackingType === "timestamp") return quoteString(value);
  return cursorLiteral(value);
}

/** Key columns other than the keyset column: the keyset tiebreaker. */
export function keysetTiebreakColumns(
  keysetColumn: string,
  keyColumns?: string[],
): string[] {
  return (keyColumns ?? []).filter(column => column !== keysetColumn);
}

/**
 * `(c1, c2, ...) op (v1, v2, ...)` lexicographically, without row-value
 * syntax: `c1 op v1 OR (c1 = v1 AND (c2 op v2 OR (...)))`.
 */
function lexicographicAfter(values: CursorValue[], op: ">" | "<"): string {
  const [head, ...rest] = values;
  const literal = cursorLiteral(head.value, head.type);
  if (rest.length === 0) return `${head.column} ${op} ${literal}`;
  return (
    `(${head.column} ${op} ${literal} OR ` +
    `(${head.column} = ${literal} AND ${lexicographicAfter(rest, op)}))`
  );
}

/** True when the query carries its own paging placeholders. */
export function isTemplateQuery(query: string): boolean {
  const found = detectTemplates(query);
  return (
    found.hasLimit ||
    found.hasOffset ||
    found.hasLastSyncValue ||
    found.hasKeysetValue
  );
}

/**
 * The SQL for one chunk. A template query is substituted as written; a
 * plain query is first translated by `plainQueryAsTemplate`.
 */
export function buildChunkQuery(input: ChunkQueryInput): string {
  const template = isTemplateQuery(input.sourceQuery)
    ? input.sourceQuery
    : plainQueryAsTemplate(input);
  return substituteTemplates(template, chunkTemplateValues(input));
}

/**
 * Placeholder values for a chunk. `last_sync_value` and `keyset_value`
 * are inserted as written (the query supplies its own quotes); a keyset
 * value known to be a string stays a string.
 */
export function chunkTemplateValues(input: ChunkQueryInput): TemplateValues {
  const { syncMode, incrementalConfig, paginationMode, state } = input;

  let lastSyncValue: string | null = null;
  if (
    syncMode === "incremental" &&
    incrementalConfig?.trackingColumn &&
    incrementalConfig?.lastValue
  ) {
    lastSyncValue = incrementalConfig.lastValue;
  }

  let keysetValue: string | number | null = null;
  const lastKeyset = state.lastKeysetValue || input.savedKeysetValue;
  if (paginationMode === "keyset" && lastKeyset) {
    const knownString =
      Boolean(state.lastKeysetValue) && state.lastKeysetValueType === "string";
    keysetValue =
      knownString || isNaN(Number(lastKeyset))
        ? lastKeyset
        : Number(lastKeyset);
  }

  return {
    limit: input.maxRowsPerChunk,
    offset: state.offset,
    last_sync_value: lastSyncValue,
    keyset_value: keysetValue,
  };
}

/**
 * Translate a query without placeholders into template mode: the
 * incremental and keyset predicates (from the run's state, as typed
 * literals) are added to its WHERE, an ORDER BY that is a total order when
 * it has none, and `LIMIT {{limit}}` (keyset) or `LIMIT {{limit}} OFFSET
 * {{offset}}`. (The cursor literals are inlined, so a cursor value that
 * itself contained a `{{limit}}` token would be substituted too; ids and
 * timestamps do not.)
 */
export function plainQueryAsTemplate(input: ChunkQueryInput): string {
  const {
    syncMode,
    incrementalConfig,
    paginationMode,
    keysetColumn,
    keysetDirection,
    keyColumns,
    state,
  } = input;
  // Strip trailing semicolons to avoid "... ; LIMIT ..." syntax errors
  let query = input.sourceQuery.replace(/;\s*$/, "");
  const hasKeys = (keyColumns?.length ?? 0) > 0;
  const hasOrderBy = () => findTopLevelKeyword(query, /^ORDER\s+BY\b/i) !== -1;

  if (
    syncMode === "incremental" &&
    incrementalConfig?.trackingColumn &&
    incrementalConfig?.lastValue
  ) {
    const literal = trackingLiteral(
      incrementalConfig.lastValue,
      incrementalConfig.trackingType || "timestamp",
    );
    const op = hasKeys ? ">=" : ">";
    query = appendWhereCondition(
      query,
      `${incrementalConfig.trackingColumn} ${op} ${literal}`,
    );
  }

  if (paginationMode === "keyset" && keysetColumn) {
    const dir = keysetDirection === "asc" ? "ASC" : "DESC";
    const op = keysetDirection === "asc" ? ">" : "<";
    const tiebreak = keysetTiebreakColumns(keysetColumn, keyColumns);
    const lastKeyset = state.lastKeysetValue || input.savedKeysetValue;

    if (lastKeyset) {
      const head: CursorValue = {
        column: keysetColumn,
        value: lastKeyset,
        // The flow's saved value has no recorded type: old heuristic.
        type: state.lastKeysetValue ? state.lastKeysetValueType : undefined,
      };
      const tail = state.lastKeysetValue ? state.lastKeysetTiebreaker : null;
      // Only use the tiebreaker when it matches the current key columns.
      const tieValues =
        tail &&
        tail.length === tiebreak.length &&
        tail.every((v, i) => v.column === tiebreak[i])
          ? tail
          : [];
      query = appendWhereCondition(
        query,
        lexicographicAfter([head, ...tieValues], op),
      );
    }

    if (!hasOrderBy()) {
      const orderBy = [keysetColumn, ...tiebreak]
        .map(column => `${column} ${dir}`)
        .join(", ");
      query = appendSqlClause(query, `ORDER BY ${orderBy}`);
    }
    return appendSqlClause(query, "LIMIT {{limit}}");
  }

  if (!hasOrderBy()) {
    const tracking = incrementalConfig?.trackingColumn;
    const columns = [
      ...(tracking ? [tracking] : []),
      ...(keyColumns ?? []).filter(column => column !== tracking),
    ];
    query = appendSqlClause(
      query,
      `ORDER BY ${columns.length > 0 ? columns.join(", ") : "1"}`,
    );
  }
  return appendSqlClause(query, "LIMIT {{limit}} OFFSET {{offset}}");
}

function toCursorValue(column: string, raw: unknown): CursorValue | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number" || typeof raw === "bigint") {
    return { column, value: String(raw), type: "number" };
  }
  if (raw instanceof Date) {
    return { column, value: raw.toISOString(), type: "string" };
  }
  return { column, value: String(raw), type: "string" };
}

/**
 * The keyset cursor after a page: the last row's keyset value and its
 * tiebreaker values, with their types. Null when the row has no keyset
 * value (the cursor then stays where it was).
 */
export function keysetCursorAfter(
  lastRow: Record<string, unknown>,
  keysetColumn: string,
  keyColumns?: string[],
): Pick<
  ChunkCursorState,
  "lastKeysetValue" | "lastKeysetValueType" | "lastKeysetTiebreaker"
> | null {
  const head = toCursorValue(keysetColumn, lastRow[keysetColumn]);
  if (!head) return null;
  const tiebreak: CursorValue[] = [];
  for (const column of keysetTiebreakColumns(keysetColumn, keyColumns)) {
    const value = toCursorValue(column, lastRow[column]);
    // A null key value cannot be compared; fall back to no tiebreaker.
    if (!value) {
      return { lastKeysetValue: head.value, lastKeysetValueType: head.type };
    }
    tiebreak.push(value);
  }
  return {
    lastKeysetValue: head.value,
    lastKeysetValueType: head.type,
    ...(tiebreak.length > 0 ? { lastKeysetTiebreaker: tiebreak } : {}),
  };
}

/**
 * The largest tracking value among `rows`, as a string (Date → ISO). The
 * rows are not necessarily ordered by the tracking column (keyset mode
 * orders by the keyset column), so "the last row's value" is not the max.
 */
export function maxTrackingValue(
  rows: Record<string, unknown>[],
  trackingColumn: string,
  previous?: string,
): string | undefined {
  let best: unknown = undefined;
  for (const row of rows) {
    const value = row[trackingColumn];
    if (value === null || value === undefined) continue;
    if (best === undefined || compareTracking(value, best) > 0) best = value;
  }
  if (best === undefined) return previous;
  const asString = best instanceof Date ? best.toISOString() : String(best);
  if (previous === undefined) return asString;
  return compareTracking(asString, previous) > 0 ? asString : previous;
}

function compareTracking(a: unknown, b: unknown): number {
  const toComparable = (v: unknown): number | string => {
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number" || typeof v === "bigint") return Number(v);
    const s = String(v);
    const n = Number(s);
    if (s.trim() !== "" && !isNaN(n) && isFinite(n)) return n;
    const t = Date.parse(s);
    return isNaN(t) ? s : t;
  };
  const x = toComparable(a);
  const y = toComparable(b);
  if (typeof x === "number" && typeof y === "number") return x - y;
  return String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
}
