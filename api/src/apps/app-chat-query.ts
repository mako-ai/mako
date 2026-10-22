/**
 * Read-only SQL over a published app's binding data, for "chat with app".
 *
 * Every call gets a fresh in-memory DuckDB whose ONLY reachable files are the
 * app's own binding parquet files: `allowed_paths` names them, external access
 * is then disabled and the configuration locked, so the agent's SQL can read
 * exactly what the app's viewers already download — never another file on
 * the API host, never a network location (except the opted-in direct-GCS
 * URLs), never an extension install. A view per binding gives each one its
 * table name; the database is thrown away after the query, so a DROP or
 * CREATE in the agent's SQL touches nothing.
 *
 * Two parquet sources:
 * - `copy` (default): local files copied from the artifact store. Sandbox is
 *   the original locked-down in-memory DB.
 * - `direct`: DuckDB httpfs reads `gs://` or https URLs. httpfs is LOADed
 *   from the extension directory baked into the image (never downloaded at
 *   runtime) before lock; `allowed_paths` is exactly those URLs; persistent
 *   secrets are off. A GCS secret, when needed, is SCOPEd to the same gs://
 *   objects.
 *
 * Signed URLs in direct mode: the agent can see them (`duckdb_views()`,
 * `current_setting('allowed_paths')`, error text). Results and errors are
 * scrubbed of the URL and its signature, but a determined query (substring
 * tricks) could still reconstruct it. That is acceptable: the URL grants a
 * read of exactly the parquet the viewer's browser already receives a signed
 * URL for via `__data/<name>.parquet`, it is read-only, and it expires.
 */
import fs from "node:fs";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { loggers } from "../logging";
import { loadBakedExtension } from "./duckdb-extensions";

const logger = loggers.api("apps-chat-query");

export type AppChatParquetMode = "copy" | "direct";

/** Credentials DuckDB httpfs uses for `gs://` (not for signed https URLs). */
export type AppChatGcsAuth =
  | { kind: "hmac"; keyId: string; secret: string }
  | { kind: "bearer"; token: string };

export interface AppDataTable {
  /** Binding name, used verbatim as the table name. */
  name: string;
  /** Local parquet path, `gs://bucket/key`, or a signed https URL. */
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
  /**
   * Force copy vs direct. When omitted, inferred from the table `file`
   * values: every path is a URL → direct, otherwise copy.
   */
  mode?: AppChatParquetMode;
  /** Required when any table is a `gs://` object (not a signed https URL). */
  gcsAuth?: AppChatGcsAuth;
}

const DEFAULT_MAX_ROWS = 200;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Distro CA bundles DuckDB httpfs tries to open for TLS. */
const CA_CERT_CANDIDATES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/etc/ssl/cert.pem",
];

/** First existing system CA bundle, or null if none are present. */
export function systemCaCertFile(): string | null {
  return CA_CERT_CANDIDATES.find(candidate => fs.existsSync(candidate)) ?? null;
}

/** SQL string literal. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** SQL identifier. Binding names may contain `-`, so always quote. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function isRemoteParquetSource(file: string): boolean {
  return /^(gs|https?):\/\//i.test(file);
}

export function inferAppChatParquetMode(
  tables: AppDataTable[],
): AppChatParquetMode {
  if (tables.length > 0 && tables.every(t => isRemoteParquetSource(t.file))) {
    return "direct";
  }
  return "copy";
}

function gcsObjectUrls(tables: AppDataTable[]): string[] {
  return tables.map(t => t.file).filter(file => /^gs:\/\//i.test(file));
}

/** DuckDB `CREATE SECRET` for httpfs `gs://` reads. HMAC or OAuth bearer. */
export function gcsSecretSql(
  auth: AppChatGcsAuth,
  scopeUrls: string[],
): string {
  const scope =
    scopeUrls.length > 0
      ? `, SCOPE [${scopeUrls.map(literal).join(", ")}]`
      : "";
  if (auth.kind === "hmac") {
    return `CREATE SECRET __mako_gcs (TYPE gcs, KEY_ID ${literal(auth.keyId)}, SECRET ${literal(auth.secret)}${scope})`;
  }
  return `CREATE SECRET __mako_gcs (TYPE gcs, PROVIDER config, BEARER_TOKEN ${literal(auth.token)}${scope})`;
}

async function lockAfterAllowlist(
  connection: DuckDBConnection,
  tables: AppDataTable[],
  extraPaths: string[] = [],
): Promise<void> {
  const paths = [...tables.map(t => t.file), ...extraPaths]
    .map(literal)
    .join(", ");
  await connection.run(`SET allowed_paths = [${paths}]`);
  await connection.run("SET autoinstall_known_extensions = false");
  await connection.run("SET autoload_known_extensions = false");
  await connection.run("SET enable_external_access = false");
  await connection.run("SET lock_configuration = true");
}

async function createBindingViews(
  connection: DuckDBConnection,
  tables: AppDataTable[],
): Promise<void> {
  for (const table of tables) {
    await connection.run(
      `CREATE VIEW ${quoteIdent(table.name)} AS SELECT * FROM read_parquet(${literal(table.file)})`,
    );
  }
}

/**
 * Replace each remote source URL with the path the viewer's browser uses for
 * it, and blank any GCS V4 signature left over (a partial or re-encoded URL).
 */
export function scrubRemoteSources(
  text: string,
  tables: AppDataTable[],
): string {
  let out = text;
  for (const table of tables) {
    if (!isRemoteParquetSource(table.file)) continue;
    const placeholder = `__data/${table.name}.parquet`;
    out = out.split(table.file).join(placeholder);
    const bare = table.file.split("?")[0];
    if (bare !== table.file) out = out.split(bare).join(placeholder);
  }
  return out.replace(
    /(X-Goog-(?:Signature|Credential)=)[^&\s'"]+/gi,
    "$1[redacted]",
  );
}

function scrubValue(value: unknown, tables: AppDataTable[]): unknown {
  if (typeof value === "string") return scrubRemoteSources(value, tables);
  if (Array.isArray(value)) return value.map(v => scrubValue(v, tables));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, scrubValue(v, tables)]),
    );
  }
  return value;
}

/**
 * Strip CREATE SECRET literals and remote source URLs from DuckDB errors so
 * HMAC/bearer secrets never log and signed URLs never reach the agent.
 */
export function redactDuckDbError(
  error: unknown,
  tables: AppDataTable[] = [],
): Error {
  const msg = error instanceof Error ? error.message : String(error);
  const redacted = scrubRemoteSources(
    msg
      .replace(/SECRET '[^']*'/gi, "SECRET '[redacted]'")
      .replace(/BEARER_TOKEN '[^']*'/gi, "BEARER_TOKEN '[redacted]'")
      .replace(/KEY_ID '[^']*'/gi, "KEY_ID '[redacted]'"),
    tables,
  );
  if (error instanceof Error && redacted === msg) return error;
  return new Error(redacted, {
    cause: error instanceof Error ? error : undefined,
  });
}

async function openLockedDown(
  tables: AppDataTable[],
  options: Pick<AppDataQueryOptions, "mode" | "gcsAuth"> = {},
): Promise<{
  instance: DuckDBInstance;
  connection: DuckDBConnection;
  mode: AppChatParquetMode;
}> {
  const mode = options.mode ?? inferAppChatParquetMode(tables);
  if (
    tables.some(t => isRemoteParquetSource(t.file)) &&
    tables.some(t => !isRemoteParquetSource(t.file))
  ) {
    throw new Error(
      "App chat parquet sources must be all local or all remote, not mixed",
    );
  }
  const instance = await DuckDBInstance.create(":memory:", {
    threads: "2",
    memory_limit: "512MB",
  });
  const connection = await instance.connect();
  try {
    if (mode === "direct") {
      await loadBakedExtension(connection, "httpfs");
      // httpfs otherwise tries ~/.duckdb/stored_secrets, which the
      // locked-down filesystem would then refuse (and fail the query).
      await connection.run("SET allow_persistent_secrets = false");
      await connection.run("SET allow_community_extensions = false");
      const gsUrls = gcsObjectUrls(tables);
      if (gsUrls.length > 0) {
        if (!options.gcsAuth) {
          throw new Error(
            "Direct GCS parquet reads need HMAC keys or an OAuth bearer token",
          );
        }
        await connection.run(gcsSecretSql(options.gcsAuth, gsUrls));
      }
      // httpfs still opens a CA bundle even when verification is off; without
      // this path in allowed_paths, real HTTPS/gs:// reads fail after lock.
      const caCert = systemCaCertFile();
      if (caCert) {
        await connection.run(`SET ca_cert_file = ${literal(caCert)}`);
        await connection.run("SET enable_server_cert_verification = true");
      }
      await lockAfterAllowlist(connection, tables, caCert ? [caCert] : []);
    } else {
      await lockAfterAllowlist(connection, tables);
    }
    await createBindingViews(connection, tables);
  } catch (error) {
    connection.closeSync();
    instance.closeSync();
    throw redactDuckDbError(error, tables);
  }
  return { instance, connection, mode };
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

  const openedAt = Date.now();
  const { instance, connection, mode } = await openLockedDown(tables, options);
  const sandboxMs = Date.now() - openedAt;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    connection.interrupt();
  }, timeoutMs);
  const onAbort = () => connection.interrupt();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const queryStarted = Date.now();
  try {
    const reader = await connection.streamAndReadUntil(sql, maxRows + 1);
    const names = reader.columnNames();
    const types = reader.columnTypes();
    const rawRows = reader.getRowObjectsJson() as Record<string, unknown>[];
    const rows =
      mode === "direct"
        ? (rawRows.map(row => scrubValue(row, tables)) as Record<
            string,
            unknown
          >[])
        : rawRows;
    const queryMs = Date.now() - queryStarted;
    logger.debug("App chat parquet query", {
      mode,
      queryMs,
      sandboxMs,
      totalMs: Date.now() - openedAt,
      tables: tables.length,
    });
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
    throw mode === "direct" ? redactDuckDbError(error, tables) : error;
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
  options: Pick<AppDataQueryOptions, "mode" | "gcsAuth"> = {},
): Promise<AppTableSummary[]> {
  if (tables.length === 0) return [];
  const openedAt = Date.now();
  const { instance, connection, mode } = await openLockedDown(tables, options);
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
          error: redactDuckDbError(error, tables).message,
        });
      }
    }
    logger.debug("App chat parquet describe", {
      mode,
      totalMs: Date.now() - openedAt,
      tables: tables.length,
    });
    return out;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
