/**
 * Shared Parquet materialization core.
 *
 * The single "query -> Parquet artifact" pipeline used by app data bindings:
 * schema probe -> streaming query -> node
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
  parquetWriteArtifactMetadata,
  type ParquetCodec,
  type ParquetWriteOptions,
} from "../utils/parquet-compression";
import {
  buildParquetFromBatches,
  type FieldMeta,
} from "../utils/streaming-parquet-builder";
import { storeArtifact } from "./artifact-store.service";
import { databaseConnectionService } from "./database-connection.service";
import { isWrite } from "../access/connection-writes";
import { checkPreviewQuerySafety } from "./query-pagination.service";
import { reportBindingPhase } from "../apps/binding-progress";
import { parquetRowLimits } from "../utils/parquet-row-limit";
import { loggers } from "../logging";

const logger = loggers.api("parquet-build");

const STREAM_BATCH_SIZE = 5000;

/** SQL string, or a MongoDB executable descriptor. */
export type ExecutableQuery =
  string | { collection: string; operation: string; query: string };

/**
 * Read-only gate for SQL materialization queries. Materialization runs
 * user/agent-editable code against the source connection, so it must never
 * execute DDL/DML.
 *
 * The gate only applies to SQL — `checkPreviewQuerySafety` is a SQL analyzer
 * that requires the statement to start with `SELECT`/`WITH`, so it would
 * wrongly reject non-SQL executables. MongoDB executables (both structured
 * descriptors and JS shell strings like `db.users.aggregate([...])`) and
 * Cloudflare KV are judged by their operation or shell method instead
 * (`isWrite`): a binding only reads. Pass the source `databaseType`.
 */
export function assertReadOnlyMaterializationQuery(
  executableQuery: ExecutableQuery,
  databaseType?: string,
): void {
  if (
    typeof executableQuery !== "string" ||
    databaseType === "mongodb" ||
    databaseType === "cloudflare-kv"
  ) {
    if (isWrite(databaseType ?? "mongodb", executableQuery)) {
      throw new Error(
        "Query failed read-only safety checks: a binding can only read.",
      );
    }
    return;
  }
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
  /** Default: PARQUET_ROW_LIMIT (parquetRowLimits().defaultRowLimit). */
  rowLimit?: number;
  /** See StreamingParquetOptions.onRowLimit; default `truncate`. */
  onRowLimit?: "truncate" | "fail";
  /** See StreamingParquetOptions.countRowsUpTo. */
  countRowsUpTo?: number;
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
  /**
   * Codec options for the COPY. Omitted = SNAPPY. App bindings pass
   * `appBindingParquetWriteOptions()` (env-configurable, default ZSTD).
   */
  writeOptions?: ParquetWriteOptions;
}

export interface BuiltParquetFile {
  /** Local temp file; pass to `storeParquetArtifactFile` (which deletes it). */
  filePath: string;
  rowCount: number;
  byteSize: number;
  compression: ParquetCodec;
  zstdLevel?: number;
  rowGroupSize?: number;
  encodeDurationMs: number;
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
  // An app's phase stream (binding-progress.ts): the warehouse has the query
  // until the first batch lands, then rows are being written.
  reportBindingPhase("querying_warehouse");

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
    rowLimit: input.rowLimit ?? parquetRowLimits().defaultRowLimit,
    onRowLimit: input.onRowLimit,
    countRowsUpTo: input.countRowsUpTo,
    writeOptions: input.writeOptions,
    fields,
    onBatchInserted: async totalRows => {
      reportBindingPhase("writing_parquet", { rowsWritten: totalRows });
      await onBatchInserted?.(totalRows);
    },
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
  build?: BuiltParquetFile;
}): Promise<void> {
  const metadata = {
    ...input.metadata,
    ...(input.build ? parquetWriteArtifactMetadata(input.build) : {}),
  };
  try {
    await storeArtifact(input.filePath, input.artifactKey, metadata);
  } finally {
    await fsPromises.rm(input.filePath, { force: true }).catch(() => undefined);
  }
}
