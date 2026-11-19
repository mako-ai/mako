/**
 * BigQuery CDC destination adapter. The class orchestrates; the work lives
 * in sibling modules:
 *
 * - bigquery-sql.ts    pure SQL: type contract, MERGE, partition pruning, DDL
 * - bigquery-schema.ts schema cache, INFORMATION_SCHEMA discovery, evolution
 * - bigquery-load.ts   Parquet staging loads, expiry, drop
 * - bigquery-target.ts resolved client type, quota retry, logger
 */
import { inWorkspace } from "../../utils/workspace-scope";
import { BigQuery } from "@google-cloud/bigquery";
import {
  isLocalBigQueryEmulator,
  bigQueryEmulatorEndpoint,
  bigQueryEmulatorHostPort,
} from "../../utils/bigquery-emulator";
import {
  DatabaseConnection,
  type IFlow,
  type IDatabaseConnection,
} from "../../database/workspace-schema";
import { enableLoadJobLabels } from "./bigquery-load-labels";
import {
  normalizePayloadKeys,
  resolveSourceTimestamp,
  selectLatestChangePerRecord,
  withSyncedAt,
} from "../normalization";
import type { CdcStoredEvent } from "../events";
import type { CdcDestinationAdapter, CdcEntityLayout } from "./registry";
import type { ConnectorEntitySchema } from "../../connectors/base/BaseConnector";
import {
  MERGE_PRUNE_MAX_PARTITIONS,
  bigQueryStagingTableName,
  buildBigQueryRepartitionStatements,
  buildLivePartitionFilter,
  buildLivePartitionProbeQuery,
  buildMergeStatement,
  liveTableCreateColumns,
  escId,
  sqlString,
} from "./bigquery-sql";
import {
  addMissingLiveColumns,
  createLiveTableFromStaging,
  discoverMergeSchemas,
  evolveSchemaIfNeeded,
  getSchemaCacheKey,
  hashEntitySchema,
  invalidateCachedSchema,
  setCachedSchema,
} from "./bigquery-schema";
import {
  buildCdcParquet,
  dropStagingTable,
  expireStagingTable,
  loadParquetToStaging,
} from "./bigquery-load";
import { ABSENT_COLUMNS_FIELD } from "../sparse-rows";
import {
  bqLog as log,
  fullTableName,
  retryOnQuota,
  runBigQuery,
  type BigQueryTarget,
} from "./bigquery-target";

export {
  MERGE_PRUNE_MAX_PARTITIONS,
  bigQueryClusterClause,
  bigQueryPartitionClause,
  buildBigQueryRepartitionStatements,
  buildLivePartitionFilter,
  buildLivePartitionProbeQuery,
  buildMergeStatement,
  mapLogicalTypeToBigQuery,
  type BigQueryRepartitionStatements,
  type BuildMergeStatementParams,
} from "./bigquery-sql";

interface BigQueryAdapterConfig {
  destinationDatabaseId: string;
  /** The flow\'s workspace: the destination is looked up in it only. */
  workspaceId: string;
  destinationDatabaseName?: string;
  tableDestination: {
    connectionId: string;
    schema: string;
    tableName: string;
  };
}

type FlowRef = Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;

/** Upper bound on a MERGE job's wait: BIGQUERY_MERGE_MAX_WAIT_MS, else 15 min. */
function mergeMaxWaitMs(): number {
  const fromEnv = Number.parseInt(
    process.env.BIGQUERY_MERGE_MAX_WAIT_MS || "",
    10,
  );
  return Number.isFinite(fromEnv) && fromEnv >= 10_000
    ? Math.min(fromEnv, 60 * 60 * 1000)
    : 15 * 60 * 1000;
}

function coerceToDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const epochMs = value > 1e12 ? value : value * 1000;
    const parsed = new Date(epochMs);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export class BigQueryDestinationAdapter implements CdcDestinationAdapter {
  readonly destinationType = "bigquery";
  readonly honoursAbsentColumns = true;

  constructor(private readonly config: BigQueryAdapterConfig) {}

  async ensureLiveTable(_layout: CdcEntityLayout): Promise<void> {
    await this.ensureDataset();
  }

  async repartitionLiveTable(
    layout: CdcEntityLayout,
  ): Promise<{ repartitioned: boolean }> {
    const target = await this.resolveBqClient();
    const { bq, projectId, dataset } = target;
    const live = layout.tableName;

    const [exists] = await bq.dataset(dataset).table(live).exists();
    if (!exists) return { repartitioned: false };

    const tmp = `${live}__repart_${Date.now().toString(36)}`;

    const run = async (sql: string) => {
      const r = await runBigQuery(target, sql, {
        bigQueryJobMaxWaitMs: 15 * 60 * 1000,
      });
      if (!r.success) throw new Error(r.error || `BigQuery DDL failed: ${sql}`);
    };

    // CREATE OR REPLACE a new-layout table from the current rows, drop the old
    // table, then rename the new one in. The caller pauses the stream so the
    // brief window where `live` is renamed is safe.
    const stmts = buildBigQueryRepartitionStatements({
      fullLive: fullTableName(target, live),
      fullTmp: fullTableName(target, tmp),
      liveName: live,
      layout,
    });
    await run(stmts.createTmp);
    await run(stmts.dropLive);
    await run(stmts.rename);

    invalidateCachedSchema(getSchemaCacheKey(projectId, dataset, live));
    log.info("Repartitioned live table in place", {
      liveTable: live,
      dataset,
      partition: layout.partitioning?.field,
      granularity: layout.partitioning?.granularity,
      cluster: layout.clustering?.fields,
    });
    return { repartitioned: true };
  }

  async applyEvents(params: {
    events: CdcStoredEvent[];
    layout: CdcEntityLayout;
    flow: FlowRef;
    entitySchema?: ConnectorEntitySchema;
  }): Promise<{ applied: number }> {
    if (params.events.length === 0) {
      return { applied: 0 };
    }

    const latest = selectLatestChangePerRecord(params.events);
    const fallbackDataSourceId = params.flow.dataSourceId
      ? String(params.flow.dataSourceId)
      : undefined;
    const upserts = latest.filter(event => event.operation === "upsert");
    const deletes = latest.filter(event => event.operation === "delete");
    const deleteMode =
      params.flow.deleteMode || params.layout.deleteMode || "hard";

    const toRow = (event: CdcStoredEvent, deletedAt: Date | null) => {
      const payload = normalizePayloadKeys(event.payload || {});
      const sourceTs = resolveSourceTimestamp(
        payload,
        new Date(event.sourceTs),
      );
      return withSyncedAt({
        ...payload,
        id: event.recordId,
        _dataSourceId: payload._dataSourceId ?? fallbackDataSourceId,
        _mako_source_ts: sourceTs,
        _mako_ingest_seq: Number(event.ingestSeq),
        _mako_deleted_at: deletedAt,
        is_deleted: deletedAt !== null,
        deleted_at: deletedAt,
      });
    };

    const rows: Record<string, unknown>[] = upserts.map(event =>
      toRow(event, null),
    );
    if (deleteMode === "soft") {
      for (const event of deletes) {
        rows.push(toRow(event, new Date()));
      }
    }

    if (rows.length > 0) {
      await this.writeViaParquet({
        records: rows,
        layout: params.layout,
        flow: params.flow,
        entitySchema: params.entitySchema,
        // Live consumer only: cdc/materialize is a singleton per flow+entity,
        // so nothing else writes this table between the probe and the MERGE.
        prunePartitions: true,
      });
    }

    if (deleteMode === "hard" && deletes.length > 0) {
      await this.hardDeleteBatch(params.layout, deletes, fallbackDataSourceId);
    }

    return { applied: latest.length };
  }

  async applyBatch(params: {
    records: Array<Record<string, unknown>>;
    layout: CdcEntityLayout;
    flow: FlowRef;
    entitySchema?: ConnectorEntitySchema;
  }): Promise<{ written: number }> {
    if (params.records.length === 0) {
      return { written: 0 };
    }

    const fallbackDataSourceId = params.flow.dataSourceId
      ? String(params.flow.dataSourceId)
      : undefined;

    const rows = params.records.map(record => {
      const payload = normalizePayloadKeys(record || {});
      const {
        deleted_at: _ignoredDeletedAt,
        deletedAt: _ignoredDeletedAtCamel,
        date_deleted: _ignoredDateDeleted,
        ...payloadWithoutDeletedAt
      } = payload as Record<string, unknown> & {
        deletedAt?: unknown;
        date_deleted?: unknown;
      };
      const makoDeletedAt = coerceToDate(payload._mako_deleted_at);
      return withSyncedAt({
        ...payloadWithoutDeletedAt,
        _dataSourceId: payload._dataSourceId ?? fallbackDataSourceId,
        _mako_source_ts: resolveSourceTimestamp(payload),
        _mako_ingest_seq:
          typeof payload._mako_ingest_seq === "number"
            ? payload._mako_ingest_seq
            : undefined,
        _mako_deleted_at: makoDeletedAt,
        deleted_at: makoDeletedAt,
      });
    });

    return this.writeViaParquet({
      records: rows,
      layout: params.layout,
      flow: params.flow,
      entitySchema: params.entitySchema,
    });
  }

  async loadStagingFromParquet(
    parquetPath: string,
    layout: CdcEntityLayout,
    flowId: string,
    options?: {
      stagingSuffix?: string;
      skipDrop?: boolean;
      skipParquetCleanup?: boolean;
    },
  ): Promise<{ loaded: number }> {
    await this.ensureDataset();
    const stagingTable = bigQueryStagingTableName(
      layout.tableName,
      flowId,
      options?.stagingSuffix,
    );
    const target = await this.resolveBqClient();
    if (!options?.skipDrop) {
      await dropStagingTable(target, stagingTable).catch(() => undefined);
    }
    return loadParquetToStaging(target, parquetPath, stagingTable, {
      skipParquetCleanup: options?.skipParquetCleanup,
    });
  }

  async mergeFromStaging(
    layout: CdcEntityLayout,
    flow: FlowRef,
    flowId: string,
    entitySchema?: ConnectorEntitySchema,
    options?: {
      stagingSuffix?: string;
      knownStagingRowCount?: number;
      prunePartitions?: boolean;
      fullRead?: boolean;
    },
  ): Promise<{ written: number }> {
    const stagingTable = bigQueryStagingTableName(
      layout.tableName,
      flowId,
      options?.stagingSuffix,
    );
    return this.mergeStagingToLive(layout, stagingTable, entitySchema, {
      knownStagingRowCount: options?.knownStagingRowCount,
      prunePartitions: options?.prunePartitions,
      fullRead: options?.fullRead,
    });
  }

  /**
   * Probe the live partitions that hold the staged keys and return the
   * constant ON-clause predicate for the MERGE (see buildLivePartitionFilter).
   * Returns undefined — MERGE unfiltered, as before — when the table is not
   * TIMESTAMP-partitioned, the batch spans too many partitions, or the probe
   * fails.
   */
  private async resolveLivePartitionFilter(
    target: BigQueryTarget,
    p: {
      layout: CdcEntityLayout;
      fullLive: string;
      fullStaging: string;
      liveTypes: Map<string, string>;
      entitySchema?: ConnectorEntitySchema;
    },
  ): Promise<string | undefined> {
    if (process.env.CDC_BQ_MERGE_PARTITION_PRUNE === "off") return undefined;
    const field = p.layout.partitioning?.field;
    if (!field) return undefined;
    if ((p.liveTypes.get(field) || "").toUpperCase() !== "TIMESTAMP") {
      return undefined;
    }
    const granularity = p.layout.partitioning?.granularity;
    const probe = buildLivePartitionProbeQuery({
      fullLive: p.fullLive,
      fullStaging: p.fullStaging,
      keyColumns: p.layout.keyColumns,
      partitionField: field,
      granularity,
      liveTypes: p.liveTypes,
      entitySchema: p.entitySchema,
      limit: MERGE_PRUNE_MAX_PARTITIONS,
    });
    const result = await runBigQuery(target, probe);
    if (!result.success) {
      log.warn("MERGE partition probe failed; merging unfiltered", {
        liveTable: p.layout.tableName,
        error: result.error,
      });
      return undefined;
    }
    const rows = (result.data as Array<{ p?: unknown }> | undefined) || [];
    if (rows.length > MERGE_PRUNE_MAX_PARTITIONS) {
      log.info("MERGE spans too many partitions; merging unfiltered", {
        liveTable: p.layout.tableName,
        partitions: rows.length,
      });
      return undefined;
    }
    const buckets = rows.map(r =>
      r.p == null ? null : String((r.p as { value?: unknown })?.value ?? r.p),
    );
    return buildLivePartitionFilter({
      partitionField: field,
      granularity,
      buckets,
    });
  }

  private async mergeStagingToLive(
    layout: CdcEntityLayout,
    stagingTable: string,
    entitySchema?: ConnectorEntitySchema,
    options?: {
      knownStagingRowCount?: number;
      prunePartitions?: boolean;
      fullRead?: boolean;
    },
  ): Promise<{ written: number }> {
    const target = await this.resolveBqClient();
    const { projectId, dataset } = target;
    const liveTable = layout.tableName;

    const fullLive = fullTableName(target, liveTable);
    const fullStaging = fullTableName(target, stagingTable);
    const liveCacheKey = getSchemaCacheKey(projectId, dataset, liveTable);

    // Always query staging schema (ephemeral table, not cacheable) but try
    // to reuse cached live schema to avoid the INFORMATION_SCHEMA round-trip.
    const {
      stagingCols: stagedCols,
      liveCols,
      liveTypes,
      schemaCacheHit,
      cachedLive,
    } = await discoverMergeSchemas(target, liveTable, stagingTable);
    // `_mako_absent_cols` steers the MERGE (sparse-rows.ts). It is not data:
    // keep it off the live table and out of plain INSERTs.
    const stagingCols = new Set(stagedCols);
    stagingCols.delete(ABSENT_COLUMNS_FIELD);

    if (stagingCols.size === 0) {
      log.info("Staging table not found or empty, nothing to merge", {
        stagingTable,
        liveTable,
        dataset,
      });
      return { written: 0 };
    }

    if (liveCols.size === 0) {
      await createLiveTableFromStaging(
        target,
        layout,
        liveTableCreateColumns(stagingCols, entitySchema),
        entitySchema,
        { liveCols, liveTypes },
      );
    }

    // --- Schema evolution: skip when connector schema hash hasn't changed ---
    const currentSchemaHash = entitySchema
      ? hashEntitySchema(entitySchema)
      : undefined;
    const skipEvolution =
      schemaCacheHit &&
      currentSchemaHash != null &&
      cachedLive?.schemaHash === currentSchemaHash;

    if (skipEvolution) {
      log.debug?.("Skipping schema evolution — connector schema unchanged", {
        liveTable,
        schemaHash: currentSchemaHash,
      });
    } else {
      await evolveSchemaIfNeeded(target, {
        fullLive,
        liveTable,
        liveCols,
        liveTypes,
        entitySchema,
      });
      if (currentSchemaHash) {
        setCachedSchema(liveCacheKey, new Map(liveTypes), currentSchemaHash);
      }
    }

    const { added: addedToLive, skipped: skippedLiveAdds } =
      await addMissingLiveColumns(target, {
        fullLive,
        liveTable,
        missing: [...stagingCols].filter(c => !liveCols.has(c)),
        entitySchema,
        liveCols,
        liveTypes,
      });
    if (addedToLive.length > 0) {
      invalidateCachedSchema(liveCacheKey);
      setCachedSchema(liveCacheKey, new Map(liveTypes), currentSchemaHash);
      log.info("Added missing columns to live table from staging", {
        liveTable,
        addedColumns: addedToLive,
      });
    }

    const allColumns = Array.from(liveCols);

    const keyColumns = layout.keyColumns;
    if ((layout.writeMode || "append_dedup") === "append_dedup") {
      const missingKeyInLive = keyColumns.filter(k => !liveCols.has(k));
      const missingKeyInStaging = keyColumns.filter(k => !stagingCols.has(k));
      if (missingKeyInLive.length > 0 || missingKeyInStaging.length > 0) {
        throw new Error(
          `Missing key columns for MERGE (live: [${missingKeyInLive.join(", ")}], staging: [${missingKeyInStaging.join(", ")}])`,
        );
      }
    }

    const stagingRowCount = options?.knownStagingRowCount ?? 0;

    // Airbyte-style write modes: "append" inserts staging rows as-is
    // (history accumulates); "overwrite" is handled by truncateLiveTable at
    // run start, then appends; default dedups via MERGE.
    const writeMode = layout.writeMode || "append_dedup";
    const insertCols = allColumns.filter(c => stagingCols.has(c));
    const insertColList = insertCols.map(escId).join(", ");
    const isDedup = writeMode !== "append" && writeMode !== "overwrite";
    const livePartitionFilter =
      isDedup && options?.prunePartitions
        ? await this.resolveLivePartitionFilter(target, {
            layout,
            fullLive,
            fullStaging,
            liveTypes,
            entitySchema,
          })
        : undefined;
    const mergeStmt = !isDedup
      ? `INSERT INTO ${fullLive} (${insertColList}) SELECT ${insertColList} FROM ${fullStaging}`
      : buildMergeStatement({
          fullLive,
          fullStaging,
          columns: allColumns,
          keyColumns,
          stagingCols: stagedCols,
          liveTypes,
          entitySchema,
          livePartitionFilter,
          fullRead: options?.fullRead,
        });

    log.info("Starting staging-to-live MERGE", {
      liveTable,
      stagingTable,
      dataset,
      stagingRowCount,
      columnCount: allColumns.length,
      schemaCacheHit,
      partitionPruned: livePartitionFilter !== undefined,
    });

    const maxWaitMs = mergeMaxWaitMs();
    await retryOnQuota(
      async () => {
        const mergeResult = await runBigQuery(target, mergeStmt, {
          bigQueryJobMaxWaitMs: maxWaitMs,
        });
        if (!mergeResult.success) {
          invalidateCachedSchema(liveCacheKey);
          log.error("BigQuery MERGE failed", {
            liveTable,
            stagingTable,
            error: mergeResult.error,
            mergePreview: mergeStmt.slice(0, 900),
          });
          throw new Error(mergeResult.error || "BigQuery MERGE failed");
        }
      },
      { label: `mergeStagingToLive:MERGE(${liveTable})` },
    );

    log.info("Merged staging to live via MERGE", {
      liveTable,
      stagingTable,
      dataset,
      stagingRowCount,
      skippedLiveAdds,
    });

    return { written: stagingRowCount };
  }

  /** Full Refresh | Overwrite: clear the live table (no-op when absent). */
  async truncateLiveTable(layout: CdcEntityLayout): Promise<void> {
    const target = await this.resolveBqClient();
    const result = await runBigQuery(
      target,
      `DELETE FROM ${fullTableName(target, layout.tableName)} WHERE TRUE`,
    );
    if (
      !result.success &&
      !/not found|does not exist/i.test(result.error || "")
    ) {
      throw new Error(
        result.error || "Failed to clear BigQuery live table for overwrite",
      );
    }
  }

  async cleanupStaging(
    layout: CdcEntityLayout,
    flowId: string,
    options?: { stagingSuffix?: string },
  ): Promise<void> {
    const stagingTable = bigQueryStagingTableName(
      layout.tableName,
      flowId,
      options?.stagingSuffix,
    );
    await dropStagingTable(await this.resolveBqClient(), stagingTable);
  }

  async prepareStaging(
    layout: CdcEntityLayout,
    flowId: string,
    options?: { stagingSuffix?: string; strict?: boolean },
  ): Promise<void> {
    await this.ensureDataset();
    const stagingTable = bigQueryStagingTableName(
      layout.tableName,
      flowId,
      options?.stagingSuffix,
    );
    const target = await this.resolveBqClient();
    if (options?.strict) {
      await dropStagingTable(target, stagingTable, { strict: true });
      return;
    }
    await dropStagingTable(target, stagingTable).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async resolveDestination(): Promise<IDatabaseConnection> {
    const doc = await DatabaseConnection.findOne(
      inWorkspace(this.config.destinationDatabaseId, this.config.workspaceId),
    );
    if (!doc) {
      throw new Error(
        `Destination connection ${this.config.destinationDatabaseId} not found`,
      );
    }
    return doc;
  }

  private _datasetLocation: string | undefined;
  private _resolvedClient?: BigQueryTarget;

  private async resolveBqClient(): Promise<BigQueryTarget> {
    if (this._resolvedClient) return this._resolvedClient;

    const destination = await this.resolveDestination();
    const conn = destination.connection as {
      service_account_json?: unknown;
      project_id?: string;
      location?: string;
      api_base_url?: string;
    };
    const credentials =
      typeof conn.service_account_json === "string"
        ? JSON.parse(conn.service_account_json)
        : conn.service_account_json;
    const projectId = conn.project_id as string;
    const dataset = this.config.tableDestination.schema;
    const connLocation: string | undefined = conn.location;
    const apiBaseUrl: string | undefined = conn.api_base_url;

    const bqOptions: ConstructorParameters<typeof BigQuery>[0] = {
      projectId,
      credentials,
      location: connLocation,
    };
    if (isLocalBigQueryEmulator(apiBaseUrl)) {
      // Point the SDK (Parquet load jobs, dataset metadata) at the local
      // emulator. The SDK only fully bypasses auth when BIGQUERY_EMULATOR_HOST
      // is set, so set it alongside the explicit apiEndpoint.
      bqOptions.apiEndpoint = bigQueryEmulatorEndpoint(apiBaseUrl as string);
      if (!process.env.BIGQUERY_EMULATOR_HOST) {
        process.env.BIGQUERY_EMULATOR_HOST = bigQueryEmulatorHostPort(
          apiBaseUrl as string,
        );
      }
    }
    const bq = new BigQuery(bqOptions);
    // Emulator jobs cost nothing; only a real client gets labelled loads.
    if (!isLocalBigQueryEmulator(apiBaseUrl)) enableLoadJobLabels(bq);

    if (!this._datasetLocation) {
      try {
        const [meta] = await bq.dataset(dataset).getMetadata();
        this._datasetLocation = meta.location;
      } catch {
        this._datasetLocation = connLocation;
      }
      log.info("Resolved dataset location", {
        dataset,
        location: this._datasetLocation,
        connLocation,
      });
    }

    this._resolvedClient = {
      bq,
      projectId,
      dataset,
      destination,
      datasetLocation: this._datasetLocation,
    };
    return this._resolvedClient;
  }

  private async ensureDataset(): Promise<void> {
    const { bq, dataset } = await this.resolveBqClient();
    await bq.dataset(dataset).get({ autoCreate: true });
  }

  private async writeViaParquet(params: {
    records: Record<string, unknown>[];
    layout: CdcEntityLayout;
    flow: FlowRef;
    entitySchema?: ConnectorEntitySchema;
    /** Probe live partitions and prune the MERGE (see resolveLivePartitionFilter). */
    prunePartitions?: boolean;
  }): Promise<{ written: number }> {
    if (params.records.length === 0) return { written: 0 };

    const flowId = String(params.flow._id);
    const stagingSuffix = `stg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    await this.ensureDataset();

    const parquet = await buildCdcParquet(
      params.layout.entity,
      params.records,
      params.entitySchema,
    );

    log.info("writeViaParquet: built Parquet for CDC batch", {
      table: params.layout.tableName,
      rows: params.records.length,
      parquetBytes: parquet.byteSize,
      flowId,
      stagingSuffix,
    });

    try {
      // The suffix is new on every call, so no table by that name exists:
      // skip the DROP TABLE IF EXISTS job before the load.
      const loadResult = await this.loadStagingFromParquet(
        parquet.filePath,
        params.layout,
        flowId,
        { stagingSuffix, skipDrop: true },
      );
      // The finally below drops the table, but not when the worker dies
      // mid-batch (deploy, timeout): such tables piled up for months, one
      // per crash. BigQuery deletes it on its own a day later regardless.
      await expireStagingTable(
        await this.resolveBqClient(),
        bigQueryStagingTableName(
          params.layout.tableName,
          flowId,
          stagingSuffix,
        ),
      );
      await this.mergeFromStaging(
        params.layout,
        params.flow,
        flowId,
        params.entitySchema,
        {
          stagingSuffix,
          knownStagingRowCount: loadResult.loaded,
          prunePartitions: params.prunePartitions,
        },
      );
    } finally {
      await this.cleanupStaging(params.layout, flowId, { stagingSuffix }).catch(
        err => {
          log.warn("Failed to cleanup CDC staging table", {
            flowId,
            table: params.layout.tableName,
            stagingSuffix,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
    }

    return { written: params.records.length };
  }

  private async hardDeleteBatch(
    layout: CdcEntityLayout,
    deletes: CdcStoredEvent[],
    fallbackDataSourceId: string | undefined,
  ): Promise<void> {
    const target = await this.resolveBqClient();
    const fullLive = fullTableName(target, layout.tableName);

    const ids = deletes.map(e => sqlString(String(e.recordId)));
    const CHUNK = 10_000;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      let where = `\`id\` IN (${chunk.join(", ")})`;
      if (fallbackDataSourceId) {
        where += ` AND \`_dataSourceId\` = ${sqlString(fallbackDataSourceId)}`;
      }
      await retryOnQuota(
        async () => {
          const result = await runBigQuery(
            target,
            `DELETE FROM ${fullLive} WHERE ${where}`,
          );
          if (!result.success) {
            const notFound =
              result.error && /not found|does not exist/i.test(result.error);
            if (notFound) {
              log.info("Skipping hard delete — live table does not exist yet", {
                table: layout.tableName,
              });
              return;
            }
            throw new Error(result.error || "BigQuery hard delete failed");
          }
        },
        { label: `hardDeleteBatch(${layout.tableName})` },
      );
    }

    log.info("Hard-deleted records from live table", {
      table: layout.tableName,
      count: deletes.length,
    });
  }
}
