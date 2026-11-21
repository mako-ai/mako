/**
 * The shapes every query path shares: what a caller asks for
 * (`QueryExecuteOptions` and its preview/streaming/read variants) and what
 * comes back. `services/database-connection.service.ts` re-exports them, so
 * callers may import either path.
 */
import type { QueryLabels } from "../services/bigquery-labels";
import type { BigQueryJobPriority } from "../services/bigquery-job-priority";
import type { PreviewPageInfo } from "../services/query-pagination.service";

/**
 * A query as callers hand it over: SQL (or MongoDB shell / KV command) text,
 * or a structured MongoDB request (`{ collection, operation, ... }`).
 */
export type DatabaseQuery = string | object;

export interface QueryResult {
  success: boolean;
  // Rows (or an engine's raw result object) as each engine returns them;
  // 140+ callers read it as they like, so it stays loose here.
  data?: any;
  error?: string;
  rowCount?: number;
  fields?: any[];
  /** Rows were cut at the caller's `maxRows`: `data` holds the first ones. */
  truncated?: boolean;
  /** BigQuery submission may have succeeded and the job was not observed terminal. */
  bigQueryJobOutcomeUnknown?: true;
}

export interface QueryField {
  name: string;
  type?: string;
}

export interface QueryPreviewResult {
  success: boolean;
  rows?: Record<string, unknown>[];
  error?: string;
  rowCount?: number;
  fields?: QueryField[];
  pageInfo?: PreviewPageInfo;
  warnings?: string[];
}

export interface StreamingQueryResult {
  success: boolean;
  totalRows: number;
  error?: string;
}

export interface ConnectionTestResult {
  success: boolean;
  error?: string;
}

export interface CancelResult {
  success: boolean;
  error?: string;
}

/** What an engine answers for an executionId it is not running. */
export const QUERY_NOT_FOUND = "Query not found or already completed";

/**
 * Options for query execution
 * Used consistently across all database drivers
 */
export interface QueryExecuteOptions {
  /**
   * Cap on how long an engine may wait for a sleeping server to wake before
   * it runs the query (ClickHouse Cloud). Interactive callers that hold an
   * HTTP request open (schema tree, autocomplete) pass a short cap.
   */
  maxWakeTimeoutMs?: number;
  /** Set once checkConnectionWrite ran at an outer entry point. */
  writeChecked?: boolean;
  /**
   * Run in a read-only transaction (or setting) without readOnly's lexical
   * single-SELECT rule: set by checkConnectionWrite for a person's reads.
   */
  readOnlyTransaction?: boolean;
  /** Target database name (for cluster/server-level connections) */
  databaseName?: string;
  /** Sub-database ID (e.g., Cloudflare D1 database UUID) */
  databaseId?: string;
  /** Batch size for paginated queries (BigQuery) */
  batchSize?: number;
  /** Location/region for query execution (BigQuery) */
  location?: string;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Execution ID for job tracking (enables cancellation) */
  executionId?: string;
  /**
   * Enforce read-only execution at the database/session layer. Unsupported
   * engines fail closed instead of falling back to lexical SQL checks.
   */
  readOnly?: boolean;
  /**
   * Who runs this query when it is not the person or workflow of the
   * request being served, e.g. "user:<id>" for a scheduled console run as
   * its owner (access/connection-writes.ts).
   */
  actor?: string;
  /**
   * BigQuery only: max time to poll jobs.query until jobComplete (default 5m).
   * Large MERGE/DML jobs need a higher value or we return a false timeout while BQ keeps running.
   */
  bigQueryJobMaxWaitMs?: number;
  /**
   * BigQuery only: the job's priority. Unset: the enclosing
   * withBigQueryJobPriority context, else INTERACTIVE. Sync writes pass
   * syncWritePriority() (BATCH). With BATCH, bigQueryJobMaxWaitMs counts
   * from the job's start, not its creation. See bigquery-job-priority.ts.
   */
  priority?: BigQueryJobPriority;
  /**
   * BigQuery only: fail the job rather than bill more than this many bytes
   * (`maximumBytesBilled`). Unset: no cap. Set for agent and MCP reads.
   */
  maximumBytesBilled?: number;
  /**
   * The most rows to read, where the engine can stop early (MongoDB shell
   * queries read their cursor up to it). Engines that cannot ignore it; the
   * caller cuts their result (query-row-cap.ts).
   */
  maxRows?: number;
  /**
   * Given each batch of rows as it is read (BigQuery: each result page).
   * Throwing stops the read; the query fails with that error.
   */
  onRows?: (rows: Record<string, unknown>[]) => void;
  /**
   * BigQuery only: job labels for cost attribution, merged over the
   * enclosing withQueryLabels context (these win). See bigquery-labels.ts.
   */
  labels?: QueryLabels;
  /**
   * BigQuery only: called once the job exists, with its id and location.
   * The CDC table write lease records it (sync-cdc/table-write-lease.ts).
   */
  onJobStarted?: (job: { jobId: string; location?: string }) => void;
  /** Cloud SQL only: older spelling of `databaseName`. */
  dbName?: string;
}

export interface QueryPreviewOptions extends QueryExecuteOptions {
  pageSize?: number;
  cursor?: string | null;
}

/**
 * Options for streaming query execution (cursor-based reading)
 */
export interface StreamingQueryOptions {
  /** Batch size for streaming reads */
  batchSize?: number;
  /** Callback for each batch of rows */
  onBatch: (rows: Record<string, unknown>[]) => Promise<void>;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Target database name (for cluster mode) */
  databaseName?: string;
}

/** `executeQueryReadingRows`: every batch goes to `onRows` as it is read. */
export interface ReadingRowsOptions extends QueryExecuteOptions {
  onRows: (rows: Record<string, unknown>[]) => void;
  /** Statement timeout for the cursor read and BigQuery's job wait. */
  timeoutMs?: number;
}

/**
 * A cursor read (Postgres): `onRows` may be async (awaited before the next
 * batch, so a slow consumer applies backpressure); `fetchRows` sets the
 * batch size; `keepRows: false` streams without accumulating `data`.
 */
export interface CursorReadOptions extends Omit<QueryExecuteOptions, "onRows"> {
  onRows: (rows: Record<string, unknown>[]) => void | Promise<void>;
  timeoutMs?: number;
  fetchRows?: number;
  keepRows?: boolean;
}
