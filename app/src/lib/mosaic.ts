import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";

type MosaicCoordinator = any;
type MosaicSelection = any;

let mosaicCorePromise: Promise<typeof import("@uwdata/mosaic-core")> | null =
  null;

async function loadMosaicCore() {
  if (!mosaicCorePromise) {
    mosaicCorePromise = import("@uwdata/mosaic-core");
  }
  return mosaicCorePromise;
}

export interface MosaicInstance {
  coordinator: MosaicCoordinator;
  /**
   * Get or create a per-data-source crossfilter selection.
   * Keyed by `dataSourceId` so widgets on different data sources
   * get independent selection scopes (Phase 1 same-data-source-only).
   */
  getSelection: (
    dataSourceId: string,
    resolution?: "intersect" | "union",
  ) => MosaicSelection;
  /** Default crossfilter selection (backward compat). */
  selection: MosaicSelection;
  destroy: () => void;
}

export async function createMosaicInstance(
  db: AsyncDuckDB,
): Promise<MosaicInstance> {
  const mosaic = await loadMosaicCore();

  const coordinator = new mosaic.Coordinator();

  const conn = await db.connect();
  const connector = {
    query: async (query: { sql: string }) => {
      const result = await conn.query(query.sql);
      return result as any;
    },
  };
  coordinator.databaseConnector(connector as any);

  const selectionCache = new Map<string, MosaicSelection>();

  const getSelection = (
    dataSourceId: string,
    resolution: "intersect" | "union" = "intersect",
  ): MosaicSelection => {
    const key = `${dataSourceId}:${resolution}`;
    const cached = selectionCache.get(key);
    if (cached) return cached;

    const sel =
      resolution === "union"
        ? mosaic.Selection.union({ cross: true })
        : mosaic.Selection.crossfilter();

    selectionCache.set(key, sel);
    return sel;
  };

  const defaultSelection = mosaic.Selection.crossfilter();

  return {
    coordinator,
    getSelection,
    selection: defaultSelection,
    destroy: () => {
      coordinator.clear();
      selectionCache.clear();
      conn.close();
    },
  };
}

/**
 * Smarter SQL filter composition that inserts WHERE/AND before GROUP BY,
 * ORDER BY, or LIMIT clauses instead of naively appending.
 */
export function applyFilterClause(sql: string, clause: string): string {
  if (!clause) return sql;
  const lower = sql.toLowerCase();
  const whereIdx = lower.indexOf("where");

  const groupIdx = lower.indexOf("group by");
  const orderIdx = lower.indexOf("order by");
  const limitIdx = lower.indexOf("limit");
  const firstTrailing = Math.min(
    groupIdx === -1 ? sql.length : groupIdx,
    orderIdx === -1 ? sql.length : orderIdx,
    limitIdx === -1 ? sql.length : limitIdx,
  );

  if (whereIdx !== -1 && whereIdx < firstTrailing) {
    return `${sql.slice(0, firstTrailing)} AND (${clause}) ${sql.slice(firstTrailing)}`;
  }
  return `${sql.slice(0, firstTrailing)} WHERE ${clause} ${sql.slice(firstTrailing)}`;
}

/**
 * Convert a DuckDB Arrow result to plain rows + field metadata.
 */
export function convertMosaicQueryResult(data: any): {
  rows: Record<string, unknown>[];
  fields: Array<{ name: string; type: string }>;
} {
  const rows: Record<string, unknown>[] = [];
  const fields: Array<{ name: string; type: string }> = [];
  if (!data || !data.numRows) return { rows, fields };

  const schema = data.schema?.fields || [];
  for (const f of schema) {
    fields.push({ name: f.name, type: String(f.type ?? "Utf8") });
  }
  for (let i = 0; i < data.numRows; i++) {
    const row: Record<string, unknown> = {};
    for (const f of schema) {
      const col = data.getChild(f.name);
      row[f.name] = col?.get(i);
    }
    rows.push(row);
  }
  return { rows, fields };
}

/**
 * Build a SQL predicate from a point or interval selection.
 */
export function createSelectionClause(sel: {
  field: string;
  values: unknown[];
  type: "point" | "interval";
}): string {
  const esc = (v: unknown) => {
    if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
    if (v instanceof Date) return `'${v.toISOString()}'`;
    return String(v);
  };

  if (sel.type === "point") {
    if (sel.values.length === 0) return "";
    if (sel.values.length === 1) {
      return `"${sel.field}" = ${esc(sel.values[0])}`;
    }
    return `"${sel.field}" IN (${sel.values.map(esc).join(", ")})`;
  }

  if (sel.type === "interval" && sel.values.length === 2) {
    return `"${sel.field}" >= ${esc(sel.values[0])} AND "${sel.field}" <= ${esc(sel.values[1])}`;
  }

  return "";
}

export interface MosaicClientConfig {
  widgetId: string;
  tableName: string;
  sql: string;
  coordinator: MosaicCoordinator;
  selection: MosaicSelection;
  onData: (data: {
    rows: Record<string, unknown>[];
    fields: Array<{ name: string; type: string }>;
  }) => void;
  onPending?: () => void;
  onError?: (error: string) => void;
}

export function createMosaicClient(config: MosaicClientConfig) {
  const {
    widgetId,
    tableName: _tableName,
    sql,
    coordinator,
    selection,
    onData,
    onPending,
    onError,
  } = config;

  let currentSql = sql;

  const client = {
    _id: widgetId,
    filterBy: selection,

    query(filter?: any): { sql: string } {
      let effectiveSql = currentSql;
      if (filter) {
        const whereClause =
          typeof filter === "string" ? filter : filter.toString();
        if (whereClause) {
          effectiveSql = applyFilterClause(effectiveSql, whereClause);
        }
      }
      return { sql: effectiveSql };
    },

    queryResult(data: any): void {
      const result = convertMosaicQueryResult(data);
      onData(result);
    },

    queryPending(): void {
      onPending?.();
    },

    queryError(error: any): void {
      onError?.(error instanceof Error ? error.message : "Mosaic query failed");
    },

    update(): void {
      coordinator.requestQuery(client);
    },

    /** Update the SQL for this client and re-query. */
    updateSql(newSql: string): void {
      currentSql = newSql;
      coordinator.requestQuery(client);
    },
  };

  coordinator.connect(client);
  return client;
}
