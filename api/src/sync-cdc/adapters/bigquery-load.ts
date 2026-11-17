/**
 * BigQuery staging tables: build a CDC batch as Parquet, load it with a
 * (labelled) load job, give the table an expiry, drop it.
 */
import { promises as fs } from "fs";
import type { JobLoadMetadata } from "@google-cloud/bigquery";
import type { ConnectorEntitySchema } from "../../connectors/base/BaseConnector";
import { bigQueryJobLabels } from "../../services/bigquery-labels";
import {
  buildParquetFromBatches,
  type FieldMeta,
} from "../../utils/streaming-parquet-builder";
import { SYNC_REQUIRED_TIMESTAMP_COLUMNS } from "../normalization";
import { prepareSparseBatch } from "../sparse-rows";
import { canLabelLoadJobs } from "./bigquery-load-labels";
import {
  bqLog as log,
  fullTableName,
  retryOnQuota,
  runBigQuery,
  type BigQueryTarget,
} from "./bigquery-target";

/** A per-batch staging table outlives its batch only if the worker died. */
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Write `records` to a local Parquet file typed by the entity schema.
 * Without the schema fields every column defaults to VARCHAR and Date values
 * get JSON.stringify'd with extra quotes, which then SAFE_CAST to NULL on the
 * live side — wiping timestamps on update.
 *
 * Only columns that at least one record carries enter staging, even when
 * every value is null. A schema column no record carries stays out, so the
 * MERGE leaves it alone. Rows that lack a staged column carry it in
 * `_mako_absent_cols` (see sparse-rows.ts). The schema still types every
 * staged column.
 */
export function buildCdcParquet(
  entity: string,
  records: Record<string, unknown>[],
  entitySchema: ConnectorEntitySchema | undefined,
) {
  const { rows, presentColumns } = prepareSparseBatch(records);
  const schemaFields: FieldMeta[] | undefined = entitySchema
    ? Object.entries(entitySchema.fields)
        .filter(([name]) => presentColumns.has(name))
        .map(([name, f]) => ({
          name,
          type: f.type,
        }))
    : undefined;

  return buildParquetFromBatches({
    filenameBase: `cdc-${entity}`,
    fields: schemaFields,
    requiredTimestampColumns: SYNC_REQUIRED_TIMESTAMP_COLUMNS,
    streamBatches: async insertBatch => {
      await insertBatch(rows);
    },
  });
}

/**
 * Schema changes a staging load may make. A bulk backfill appends one Parquet
 * file per flush batch to the same staging table, and the first file creates
 * it. DuckDB 2.0 writes a column with no NULL in a file as REQUIRED, so that
 * first file can make a column REQUIRED. Without ALLOW_FIELD_RELAXATION the
 * next file with a NULL in that column (or without the column) fails with
 * "Field X has changed mode from REQUIRED to NULLABLE", on every retry.
 */
export const STAGING_SCHEMA_UPDATE_OPTIONS = [
  "ALLOW_FIELD_ADDITION",
  "ALLOW_FIELD_RELAXATION",
];

/** Append a Parquet file to a staging table with a load job. */
export async function loadParquetToStaging(
  target: BigQueryTarget,
  parquetPath: string,
  stagingTable: string,
  options?: { skipParquetCleanup?: boolean },
): Promise<{ loaded: number }> {
  const { bq, dataset, datasetLocation, destination } = target;
  const loadMetadata: JobLoadMetadata & { labels?: Record<string, string> } = {
    sourceFormat: "PARQUET",
    writeDisposition: "WRITE_APPEND",
    schemaUpdateOptions: [...STAGING_SCHEMA_UPDATE_OPTIONS],
  };
  // Moved to configuration.labels by bigquery-load-labels.ts.
  if (canLabelLoadJobs(bq)) {
    loadMetadata.labels = bigQueryJobLabels({
      workspaceId: destination.workspaceId,
    });
  }

  const jobMeta = await retryOnQuota(
    async () => {
      const [metadata] = await bq
        .dataset(dataset, { location: datasetLocation })
        .table(stagingTable)
        // A fresh copy per attempt: the SDK mutates what it is given.
        .load(parquetPath, { ...loadMetadata });

      const meta = metadata as {
        status?: { errorResult?: { message?: string } };
        statistics?: { load?: { outputRows?: unknown } };
      };
      if (meta?.status?.errorResult) {
        throw new Error(
          meta.status.errorResult.message || "BigQuery load job failed",
        );
      }
      return meta;
    },
    { label: `loadParquetToStaging(${stagingTable})` },
  );

  const loaded = Number(jobMeta?.statistics?.load?.outputRows || 0);

  if (!options?.skipParquetCleanup) {
    await fs.rm(parquetPath, { force: true }).catch(() => undefined);
  }

  log.info("Loaded Parquet to BigQuery staging table", {
    stagingTable,
    dataset,
    loaded,
  });

  return { loaded };
}

/**
 * Let BigQuery delete the staging table a day later on its own, for when
 * the worker dies mid-batch and the normal drop never runs.
 */
export async function expireStagingTable(
  target: BigQueryTarget,
  stagingTable: string,
): Promise<void> {
  const { bq, dataset, datasetLocation } = target;
  await bq
    .dataset(dataset, { location: datasetLocation })
    .table(stagingTable)
    .setMetadata({ expirationTime: String(Date.now() + STAGING_TTL_MS) })
    .catch(err => {
      log.warn("Could not set an expiry on the CDC staging table", {
        stagingTable,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

export async function dropStagingTable(
  target: BigQueryTarget,
  stagingTable: string,
  options?: { strict?: boolean },
): Promise<void> {
  const result = await runBigQuery(
    target,
    `DROP TABLE IF EXISTS ${fullTableName(target, stagingTable)}`,
  );
  if (options?.strict && !result.success) {
    throw new Error(
      `Could not drop staging table ${stagingTable}: ${result.error || "unknown error"}`,
    );
  }
  log.info("Cleaned up staging table", {
    stagingTable,
    dataset: target.dataset,
  });
}
