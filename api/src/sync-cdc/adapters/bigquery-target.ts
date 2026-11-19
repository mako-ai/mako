/**
 * What every BigQuery adapter step works against — the resolved client,
 * project, dataset, destination connection and dataset location — plus the
 * shared quota-retry wrapper and logger.
 */
import type { BigQuery } from "@google-cloud/bigquery";
import type { IDatabaseConnection } from "../../database/workspace-schema";
import type { QueryExecuteOptions } from "../../databases/query-types";
import { databaseConnectionService } from "../../services/database-connection.service";
import { loggers } from "../../logging";
import { escId } from "./bigquery-sql";
import {
  syncWritePriority,
  type BigQueryJobPriority,
} from "../../services/bigquery-job-priority";

export const bqLog = loggers.sync("cdc.adapter.bigquery");

export interface BigQueryTarget {
  bq: InstanceType<typeof BigQuery>;
  projectId: string;
  dataset: string;
  destination: IDatabaseConnection;
  datasetLocation: string | undefined;
}

/** `project`.`dataset`.`table`, quoted. */
export function fullTableName(target: BigQueryTarget, table: string): string {
  return `${escId(target.projectId)}.${escId(target.dataset)}.${escId(table)}`;
}

/** Run one statement in the dataset's location. */
export function runBigQuery(
  target: BigQueryTarget,
  sql: string,
  options: {
    bigQueryJobMaxWaitMs?: number;
    priority?: BigQueryJobPriority;
    onJobStarted?: QueryExecuteOptions["onJobStarted"];
  } = {},
) {
  return databaseConnectionService.executeQuery(target.destination, sql, {
    location: target.datasetLocation,
    ...options,
  });
}

/**
 * Run one statement that writes synced rows (MERGE, DELETE, UPDATE, CREATE
 * AS SELECT) at the sync-write priority: BATCH unless BQ_SYNC_WRITE_PRIORITY
 * says INTERACTIVE (services/bigquery-job-priority.ts). Metadata reads and
 * DDL use runBigQuery and stay INTERACTIVE: they use almost no slots.
 */
export function runBigQueryWrite(
  target: BigQueryTarget,
  sql: string,
  options: {
    bigQueryJobMaxWaitMs?: number;
    onJobStarted?: QueryExecuteOptions["onJobStarted"];
  } = {},
) {
  return runBigQuery(target, sql, {
    ...options,
    priority: syncWritePriority(),
  });
}

// ---------------------------------------------------------------------------
// Retry helper for BigQuery quota / rate-limit errors (HTTP 403 rateLimitExceeded,
// 429 quotaExceeded, or error messages mentioning "quota").
// ---------------------------------------------------------------------------

function isQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("quota") ||
    msg.includes("rate limit") ||
    msg.includes("ratelimitexceeded") ||
    msg.includes("exceeded") ||
    /exceeded.*quota|quota.*exceeded/i.test(err.message)
  );
}

export async function retryOnQuota<T>(
  fn: () => Promise<T>,
  opts: { label: string; maxRetries?: number } = { label: "BigQuery op" },
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 4;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isQuotaError(err)) throw err;
      const backoffMs = Math.min(30_000, 5_000 * 2 ** attempt);
      bqLog.warn(`${opts.label}: quota error, retrying in ${backoffMs}ms`, {
        attempt: attempt + 1,
        maxRetries,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
}
