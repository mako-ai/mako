/**
 * Shared Parquet materialization core.
 *
 * The single "query -> Parquet artifact" pipeline used by BOTH dashboard data
 * sources and app data bindings: schema probe -> streaming query -> node
 * DuckDB Parquet build -> artifact store upload. Callers own everything
 * domain-specific (definition hashes, artifact keys, cache metadata writes,
 * run records, snapshots, queueing).
 *
 * Error semantics are strict by design: a failed stream must fail the build —
 * silently producing an empty or truncated "ready" artifact is worse than an
 * error. The schema probe can be lenient (fall back to runtime column
 * inference) where drivers don't support probing, e.g. MongoDB executables.
 */

import { promises as fsPromises } from "fs";
import type { IDatabaseConnection } from "../database/workspace-schema";
import {
  buildParquetFromBatches,
  type FieldMeta,
} from "../utils/streaming-parquet-builder";
import { storeArtifact } from "./dashboard-cache.service";
import { databaseConnectionService } from "./database-connection.service";
import { checkPreviewQuerySafety } from "./query-pagination.service";
import { loggers } from "../logging";

const logger = loggers.api("parquet-build");

/** Default/maximum rows materialized into a single Parquet artifact. */
export const PARQUET_ROW_LIMIT = 500_000;

const STREAM_BATCH_SIZE = 5000;

/** SQL string, or a MongoDB executable descriptor (dashboard data sources). */
export type ExecutableQuery =
  | string
  | { collection: string; operation: string; query: string };

/**
 * Read-only gate for SQL materialization queries. Materialization runs
 * user/agent-editable code against the source connection, so it must never
 * execute DDL/DML.
 *
 * The gate only applies to SQL — `checkPreviewQuerySafety` is a SQL analyzer
 * that requires the statement to start with `SELECT`/`WITH`, so it would
 * wrongly reject non-SQL executables. MongoDB executables (both structured
 * descriptors and JS shell strings like `db.users.aggregate([...])`) and
 * Cloudflare KV are validated by their own drivers/execution paths and are
 * skipped here. Pass the source `databaseType` so non-SQL sources are exempt.
 */
export function assertReadOnlyMaterializationQuery(
  executableQuery: ExecutableQuery,
  databaseType?: string,
): void {
  // Structured executables (e.g. MongoDB find/aggregate descriptors) are not SQL.
  if (typeof executableQuery !== "string") return;
  // Non-SQL sources use their own read-only semantics, not the SQL analyzer.
  if (databaseType === "mongodb" || databaseType === "cloudflare-kv") return;
  const safety = checkPreviewQuerySafety(executableQuery);
  if (!safety.safe) {
    throw new Error(
      `Query failed read-only safety checks: ${safety.errors.join(" ")}`,
    );
  }
}

export interface BuildQueryParquetFileInput {
  connection: IDatabaseConnection;
  executableQuery: ExecutableQuery;
  databaseId?: string;
  databaseName?: string;
  /** Capped at PARQUET_ROW_LIMIT-style limits by the caller; default 500k. */
  rowLimit?: number;
  /** Local temp-file name base, e.g. `app-{appId}-{bindingId}`. */
  filenameBase: string;
  /**
   * `strict`: a failed schema probe fails the build (the probe executes the
   * query, so a probe failure means the query itself is broken).
   * `lenient`: fall back to runtime column inference (needed where probing is
   * unsupported, e.g. MongoDB executables).
   */
  schemaProbe?: "strict" | "lenient";
  /** Progress callback per inserted batch (heartbeats, run events). */
  onBatchInserted?: (totalRows: number) => Promise<void>;
}

export interface BuiltParquetFile {
  /** Local temp file; pass to `storeParquetArtifactFile` (which deletes it). */
  filePath: string;
  rowCount: number;
  byteSize: number;
}

/**
 * Execute a query and stream its results into a local Parquet file.
 * Throws on any query failure — never returns a partial result.
 */
export async function buildQueryParquetFile(
  input: BuildQueryParquetFileInput,
): Promise<BuiltParquetFile> {
  const {
    connection,
    executableQuery,
    databaseId,
    databaseName,
    filenameBase,
    onBatchInserted,
  } = input;

  assertReadOnlyMaterializationQuery(executableQuery, connection.type);

  // The driver-level `readOnly` gate is a SQL analyzer: it requires string
  // queries to be a single SELECT/WITH and fails closed for engines it can't
  // validate (MongoDB JS-shell code, Cloudflare KV). Those sources can never
  // pass it, so materializing them read-only errors out. They're exempted here
  // exactly as `assertReadOnlyMaterializationQuery` exempts them above — their
  // read-only safety is the source driver's own execution path, not this gate.
  const enforceReadOnly =
    connection.type !== "mongodb" && connection.type !== "cloudflare-kv";

  let fields: FieldMeta[] = [];
  try {
    const schemaResult =
      await databaseConnectionService.getStreamingQueryFields(
        connection,
        executableQuery,
        { databaseId, databaseName, readOnly: enforceReadOnly },
      );
    if (schemaResult.success && schemaResult.fields) {
      fields = schemaResult.fields;
    } else if (input.schemaProbe !== "lenient") {
      throw new Error(schemaResult.error || "Failed to resolve query schema");
    } else {
      logger.warn("Schema probe failed, falling back to runtime inference", {
        filenameBase,
        error: schemaResult.error,
      });
    }
  } catch (error) {
    if (input.schemaProbe !== "lenient") throw error;
    logger.warn("Schema probe failed, falling back to runtime inference", {
      filenameBase,
      error,
    });
  }

  return await buildParquetFromBatches({
    filenameBase,
    rowLimit: input.rowLimit ?? PARQUET_ROW_LIMIT,
    fields,
    onBatchInserted,
    streamBatches: async insertBatch => {
      const streamResult =
        await databaseConnectionService.executeStreamingQuery(
          connection,
          executableQuery,
          {
            batchSize: STREAM_BATCH_SIZE,
            databaseId,
            databaseName,
            onBatch: insertBatch,
            readOnly: enforceReadOnly,
          },
        );
      // A mid-stream failure must fail the build — otherwise a silently
      // truncated (or empty) artifact would be reported as "ready".
      if (!streamResult.success) {
        throw new Error(streamResult.error || "Streaming query failed");
      }
    },
  });
}

/**
 * Upload a built Parquet file to the shared artifact store and remove the
 * local temp file (always, even when the upload fails).
 */
export async function storeParquetArtifactFile(input: {
  filePath: string;
  artifactKey: string;
  metadata?: Record<string, string>;
}): Promise<void> {
  try {
    await storeArtifact(input.filePath, input.artifactKey, input.metadata);
  } finally {
    await fsPromises.rm(input.filePath, { force: true }).catch(() => undefined);
  }
}
