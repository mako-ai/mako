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
  selection: MosaicSelection;
  destroy: () => void;
}

/**
 * Create a Mosaic coordinator connected to a DuckDB-WASM instance.
 * Returns a coordinator + cross-filter selection for the dashboard.
 */
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

  const selection = mosaic.Selection.crossfilter();

  return {
    coordinator,
    selection,
    destroy: () => {
      coordinator.clear();
      conn.close();
    },
  };
}

export interface MosaicClientConfig {
  widgetId: string;
  tableName: string;
  sql: string;
  coordinator: MosaicCoordinator;
  selection: MosaicSelection;
  onData: (rows: Record<string, unknown>[]) => void;
}

/**
 * Create a Mosaic client that participates in cross-filtering.
 * The client re-queries DuckDB when the selection changes.
 */
export function createMosaicClient(config: MosaicClientConfig) {
  const {
    widgetId,
    tableName: _tableName,
    sql,
    coordinator,
    selection,
    onData,
  } = config;

  const client = {
    _id: widgetId,
    filterBy: selection,

    query(filter?: any): { sql: string } {
      let effectiveSql = sql;
      if (filter) {
        const whereClause =
          typeof filter === "string" ? filter : filter.toString();
        if (whereClause) {
          if (effectiveSql.toLowerCase().includes("where")) {
            effectiveSql += ` AND (${whereClause})`;
          } else {
            effectiveSql += ` WHERE ${whereClause}`;
          }
        }
      }
      return { sql: effectiveSql };
    },

    queryResult(data: any): void {
      const rows: Record<string, unknown>[] = [];
      if (data && data.numRows) {
        const fields = data.schema?.fields || [];
        for (let i = 0; i < data.numRows; i++) {
          const row: Record<string, unknown> = {};
          for (const f of fields) {
            const col = data.getChild(f.name);
            row[f.name] = col?.get(i);
          }
          rows.push(row);
        }
      }
      onData(rows);
    },

    update(): void {
      coordinator.requestQuery(client);
    },
  };

  coordinator.connect(client);
  return client;
}
