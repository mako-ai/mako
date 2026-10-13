/**
 * Read-only SQL over a published app's binding data, for "chat with app".
 *
 * Every call gets a fresh in-memory DuckDB whose ONLY reachable files are the
 * app's own binding parquet files: `allowed_paths` names them, external access
 * is then disabled and the configuration locked, so the agent's SQL can read
 * exactly what the app's viewers already download — never another file on
 * the API host, never a network location, never an extension install. A view
 * per binding gives each one its table name; the database is thrown away
 * after the query, so a DROP or CREATE in the agent's SQL touches nothing.
 */
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

export interface AppDataTable {
  /** Binding name, used verbatim as the table name. */
  name: string;
  /** Local parquet file holding the binding's published data. */
  file: string;
}

export interface AppDataQueryResult {
  columns: Array<{ name: string; type: string }>;
  rows: Record<string, unknown>[];
  /** True when the result had more rows than `maxRows`. */
  truncated: boolean;
}

export interface AppDataQueryOptions {
  maxRows?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_ROWS = 200;
const DEFAULT_TIMEOUT_MS = 30_000;

/** SQL string literal. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** SQL identifier. Binding names may contain `-`, so always quote. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function openLockedDown(
  tables: AppDataTable[],
): Promise<{ instance: DuckDBInstance; connection: DuckDBConnection }> {
  const instance = await DuckDBInstance.create(":memory:", {
    threads: "2",
    memory_limit: "512MB",
  });
  const connection = await instance.connect();
  try {
    const paths = tables.map(t => literal(t.file)).join(", ");
    await connection.run(`SET allowed_paths = [${paths}]`);
    await connection.run("SET autoinstall_known_extensions = false");
    await connection.run("SET autoload_known_extensions = false");
    await connection.run("SET enable_external_access = false");
    await connection.run("SET lock_configuration = true");
    for (const table of tables) {
      await connection.run(
        `CREATE VIEW ${quoteIdent(table.name)} AS SELECT * FROM read_parquet(${literal(table.file)})`,
      );
    }
  } catch (error) {
    connection.closeSync();
    instance.closeSync();
    throw error;
  }
  return { instance, connection };
}

/**
 * Run one agent-written query against the app's tables. Rows come back as
 * JSON-safe objects (BIGINT and DECIMAL as strings); at most `maxRows` of
 * them, with `truncated` set when there were more.
 */
export async function queryAppData(
  tables: AppDataTable[],
  sql: string,
  options: AppDataQueryOptions = {},
): Promise<AppDataQueryResult> {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (options.signal?.aborted) throw new Error("Query cancelled");

  const { instance, connection } = await openLockedDown(tables);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    connection.interrupt();
  }, timeoutMs);
  const onAbort = () => connection.interrupt();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const reader = await connection.streamAndReadUntil(sql, maxRows + 1);
    const names = reader.columnNames();
    const types = reader.columnTypes();
    const rows = reader.getRowObjectsJson() as Record<string, unknown>[];
    return {
      columns: names.map((name, i) => ({ name, type: String(types[i]) })),
      rows: rows.slice(0, maxRows),
      truncated: rows.length > maxRows,
    };
  } catch (error) {
    if (timedOut) {
      throw new Error(
        `Query timed out after ${Math.round(timeoutMs / 1000)}s — aggregate or filter more narrowly`,
        { cause: error },
      );
    }
    if (options.signal?.aborted) {
      throw new Error("Query cancelled", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    connection.closeSync();
    instance.closeSync();
  }
}

export interface AppTableSummary {
  name: string;
  rowCount: number | null;
  columns: Array<{ name: string; type: string }>;
  sampleRows: Record<string, unknown>[];
  error?: string;
}

/** Columns, row count and a few sample rows for each table. */
export async function describeAppData(
  tables: AppDataTable[],
  sampleSize = 3,
): Promise<AppTableSummary[]> {
  if (tables.length === 0) return [];
  const { instance, connection } = await openLockedDown(tables);
  try {
    const out: AppTableSummary[] = [];
    for (const table of tables) {
      const ident = quoteIdent(table.name);
      try {
        const described = await connection.runAndReadAll(`DESCRIBE ${ident}`);
        const columns = (
          described.getRowObjectsJson() as Array<{
            column_name: string;
            column_type: string;
          }>
        ).map(c => ({ name: c.column_name, type: c.column_type }));
        const counted = await connection.runAndReadAll(
          `SELECT count(*) AS n FROM ${ident}`,
        );
        const n = (counted.getRowObjectsJson()[0] as { n?: unknown })?.n;
        const sample = await connection.runAndReadAll(
          `SELECT * FROM ${ident} LIMIT ${Math.max(0, Math.floor(sampleSize))}`,
        );
        out.push({
          name: table.name,
          rowCount: n === undefined ? null : Number(n),
          columns,
          sampleRows: sample.getRowObjectsJson() as Record<string, unknown>[],
        });
      } catch (error) {
        out.push({
          name: table.name,
          rowCount: null,
          columns: [],
          sampleRows: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return out;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
