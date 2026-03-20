import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";

type MosaicCoordinator = any;
type MosaicSelection = any;
type MosaicClient = any;
type MosaicCoreModule = typeof import("@uwdata/mosaic-core");

export type DashboardCrossFilterResolution = "intersect" | "union";

export interface MosaicSelectionInput {
  field: string;
  values: unknown[];
  type: "point" | "interval";
}

let mosaicCorePromise: Promise<MosaicCoreModule> | null = null;

async function loadMosaicCore() {
  if (!mosaicCorePromise) {
    mosaicCorePromise = import("@uwdata/mosaic-core");
  }
  return mosaicCorePromise;
}

function applyFilterClause(sql: string, filter: unknown): string {
  if (!filter || filter === true) {
    return sql;
  }

  const filterClause = Array.isArray(filter)
    ? filter
        .map(entry =>
          typeof entry === "string" ? entry : entry?.toString?.() || "",
        )
        .filter(Boolean)
        .join(" AND ")
    : typeof filter === "string"
      ? filter
      : filter.toString?.() || "";

  if (!filterClause) {
    return sql;
  }

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
    return `${sql.slice(0, firstTrailing)} AND (${filterClause}) ${sql.slice(firstTrailing)}`;
  }
  return `${sql.slice(0, firstTrailing)} WHERE ${filterClause} ${sql.slice(firstTrailing)}`;
}

function normalizeDuckDBValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    const min = BigInt(Number.MIN_SAFE_INTEGER);
    if (value <= max && value >= min) {
      return Number(value);
    }
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(normalizeDuckDBValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        normalizeDuckDBValue(nested),
      ]),
    );
  }

  return value;
}

export interface MosaicQueryResult {
  rows: Record<string, unknown>[];
  fields: Array<{ name: string; type: string }>;
}

export function convertMosaicQueryResult(data: any): MosaicQueryResult {
  const rows: Record<string, unknown>[] = [];
  const fields = Array.isArray(data?.schema?.fields)
    ? data.schema.fields.map((field: any) => ({
        name: String(field.name),
        type: String(field.type),
      }))
    : [];

  if (data?.numRows) {
    for (let i = 0; i < data.numRows; i++) {
      const row: Record<string, unknown> = {};
      for (const field of fields) {
        const col = data.getChild(field.name);
        row[field.name] = normalizeDuckDBValue(col?.get(i));
      }
      rows.push(row);
    }
  }

  return { rows, fields };
}

export interface MosaicInstance {
  coordinator: MosaicCoordinator;
  getSelection: (
    selectionKey: string,
    resolution?: DashboardCrossFilterResolution,
  ) => MosaicSelection;
  createSelectionClause: (
    selection: MosaicSelectionInput | null,
    options: { source: object; client?: MosaicClient | null },
  ) => any;
  destroy: () => void;
}

/**
 * Create a Mosaic coordinator connected to a DuckDB-WASM instance.
 * Returns a coordinator plus lazily-scoped selections for the dashboard.
 */
export async function createMosaicInstance(
  db: AsyncDuckDB,
): Promise<MosaicInstance> {
  const mosaic = await loadMosaicCore();
  const coordinator = new mosaic.Coordinator();
  const conn = await db.connect();
  const connector = {
    query: async (query: { sql: string } | string) => {
      const sql = typeof query === "string" ? query : query.sql;
      const result = await conn.query(sql);
      return result as any;
    },
  };
  coordinator.databaseConnector(connector as any);
  const selections = new Map<
    string,
    { resolution: DashboardCrossFilterResolution; selection: MosaicSelection }
  >();

  return {
    coordinator,
    getSelection: (
      selectionKey: string,
      resolution: DashboardCrossFilterResolution = "intersect",
    ) => {
      const existing = selections.get(selectionKey);
      if (existing && existing.resolution === resolution) {
        return existing.selection;
      }

      const selection =
        resolution === "union"
          ? mosaic.Selection.union({ cross: true })
          : mosaic.Selection.crossfilter();
      selections.set(selectionKey, { resolution, selection });
      return selection;
    },
    createSelectionClause: (
      selection: MosaicSelectionInput | null,
      options: { source: object; client?: MosaicClient | null },
    ) => {
      if (!selection || selection.values.length === 0) {
        return null;
      }

      const clients = options.client ? new Set([options.client]) : undefined;
      if (selection.type === "interval" && selection.values.length === 2) {
        return mosaic.clauseInterval(selection.field, selection.values as any, {
          source: options.source,
          clients,
        });
      }

      if (selection.values.length > 1) {
        return mosaic.clausePoints(
          [selection.field],
          selection.values.map(value => [value]),
          {
            source: options.source,
            clients,
          },
        );
      }

      return mosaic.clausePoint(selection.field, selection.values[0], {
        source: options.source,
        clients,
      });
    },
    destroy: () => {
      coordinator.clear();
      selections.clear();
      void conn.close();
    },
  };
}

export interface MosaicClientConfig {
  widgetId: string;
  coordinator: MosaicCoordinator;
  selection?: MosaicSelection | null;
  getSql: () => string;
  onData: (result: MosaicQueryResult) => void;
  onPending?: () => void;
  onError?: (error: Error) => void;
  filterStable?: boolean;
}

/**
 * Create a Mosaic client that participates in cross-filtering.
 * The client re-queries DuckDB when the selection changes.
 */
export async function createMosaicClient(
  config: MosaicClientConfig,
): Promise<MosaicClient> {
  const {
    widgetId,
    coordinator,
    selection,
    onData,
    onPending,
    onError,
    getSql,
    filterStable = true,
  } = config;
  const mosaic = await loadMosaicCore();

  const methods = {
    selection: selection || undefined,
    filterStable,
    query(filter?: unknown): string {
      return applyFilterClause(getSql(), filter);
    },
    queryResult(data: unknown): void {
      onData(convertMosaicQueryResult(data));
    },
    queryPending(): void {
      onPending?.();
    },
    queryError(error: Error): void {
      onError?.(error);
    },
  };

  if (typeof mosaic.makeClient === "function") {
    const client = mosaic.makeClient({
      coordinator,
      ...methods,
    });
    (client as any)._id = widgetId;
    return client;
  }

  const client = {
    _id: widgetId,
    enabled: true,
    filterStable,
    coordinator: null,
    filterBy: selection || undefined,
    initialize(): void {
      void 0;
    },
    reset(): void {
      this.filterBy?.reset?.();
    },
    requestQuery(): Promise<unknown> {
      return coordinator.requestQuery(this);
    },
    update() {
      return this;
    },
    query: methods.query,
    queryResult(data: unknown) {
      methods.queryResult(data);
      return this;
    },
    queryPending() {
      methods.queryPending();
      return this;
    },
    queryError(error: Error) {
      methods.queryError(error);
      return this;
    },
  };

  coordinator.connect(client);
  void coordinator.requestQuery(client);
  return client;
}
