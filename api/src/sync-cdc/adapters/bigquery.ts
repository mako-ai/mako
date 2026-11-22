/**
 * BigQuery CDC destination adapter. The class orchestrates; the work lives
 * in sibling modules:
 *
 * - bigquery-sql.ts    pure SQL: type contract, MERGE, partition pruning, DDL
 * - bigquery-schema.ts schema cache, INFORMATION_SCHEMA discovery, evolution
 * - bigquery-load.ts   Parquet staging loads, expiry, drop
 * - bigquery-target.ts resolved client type, quota retry, logger
 */
import { googleClientCredentials } from "../../connections/google-service-account";
import { inWorkspace } from "../../utils/workspace-scope";
import { BigQuery } from "@google-cloud/bigquery";
import {
  isLocalBigQueryEmulator,
  bigQueryEmulatorEndpoint,
} from "../../utils/bigquery-emulator";
import {
  DatabaseConnection,
  type IFlow,
  type IDatabaseConnection,
} from "../../database/workspace-schema";
import { enableLoadJobLabels } from "./bigquery-load-labels";
import {
  normalizePayloadKeys,
  providerEventTime,
  resolveSourceTimestamp,
  selectLatestChangePerRecord,
  withSyncedAt,
} from "../normalization";
import type { CdcStoredEvent } from "../events";
import type {
  CdcDestinationAdapter,
  CdcEntityLayout,
  LiveTableDescription,
} from "./registry";
import {
  claimUnprunedMergeWarning,
  type UnprunedMerge,
  type UnprunedMergeReason,
} from "./merge-prune-warning";
import type { ConnectorEntitySchema } from "../../connectors/base/BaseConnector";
import {
  MERGE_PRUNE_MAX_PARTITIONS,
  bigQueryStagingTableName,
  buildBigQueryRepartitionStatements,
  buildLivePartitionFilter,
  buildLivePartitionProbeQuery,
  buildMergeStatement,
  buildStagingAbsentColumnsQuery,
  resolveMergePartitioning,
  liveTableCreateColumns,
  escId,
  sqlString,
} from "./bigquery-sql";
import {
  addMissingLiveColumns,
  createLiveTableFromStaging,
  discoverMergeSchemas,
  evolveSchemaIfNeeded,
  getLiveTablePartitioning,
  getLiveTableMeta,
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
  currentQueryLabels,
  withQueryLabels,
} from "../../services/bigquery-labels";
import {
  tableWriteLeaseMaxWaitMs,
  withTableWriteLease,
  type AcquireTableWriteLeaseOptions,
  type CdcMergePath,
  type LeaseJobControl,
  type TableWriteLease,
} from "../table-write-lease";
import {
  bqLog as log,
  fullTableName,
  retryOnQuota,
  runBigQuery,
  runBigQueryWrite,
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
  /**
   * Test seam: runs after the partition probe and before the MERGE, inside
   * the table write lease. The race tests run a second writer here.
   */
  hooks?: {
    beforeMerge?: (ctx: {
      liveTable: string;
      path: CdcMergePath;
    }) => Promise<void>;
    /** Shorter lease backoff for tests. */
    lease?: Pick<
      AcquireTableWriteLeaseOptions,
      "backoffMinMs" | "backoffMaxMs"
    >;
  };
}

type FlowRef = Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;

const UNPRUNED_WARN_JOB_READ_TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

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

  /** The live table's cached metadata (see getLiveTableMeta). */
  async describeLiveTable(
    tableName: string,
  ): Promise<LiveTableDescription | undefined> {
    return getLiveTableMeta(await this.resolveBqClient(), tableName);
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

    let lease: TableWriteLease | undefined;
    const run = async (sql: string) => {
      const r = await runBigQueryWrite(target, sql, {
        bigQueryJobMaxWaitMs: 15 * 60 * 1000,
        onJobStarted: job => lease?.recordJob(job),
      });
      if (!r.success) throw new Error(r.error || `BigQuery DDL failed: ${sql}`);
      lease?.markJobDone();
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
    // Under the table write lease: a MERGE between the CTAS and the RENAME
    // would land in the table about to be dropped.
    await this.underTableWriteLease(
      target,
      live,
      { path: "repartition" },
      async held => {
        lease = held;
        await withQueryLabels(
          {
            mako_merge_path: "repartition",
            mako_lease_wait_ms:
              held !== undefined ? String(Math.round(held.waitMs)) : undefined,
          },
          async () => {
            await run(stmts.createTmp);
            await run(stmts.dropLive);
            await run(stmts.rename);
          },
        );
      },
    );

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
      const sourceTs =
        providerEventTime(event) ??
        resolveSourceTimestamp(payload, new Date(event.sourceTs));
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
        mergePath: "live",
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
      mergePath: "poll",
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
    _flow: FlowRef,
    flowId: string,
    entitySchema?: ConnectorEntitySchema,
    options?: {
      stagingSuffix?: string;
      knownStagingRowCount?: number;
      fullRead?: boolean;
      /** The columns some staged row lacks (prepareSparseBatch). Unset: read from staging. */
      absentColumns?: ReadonlySet<string>;
      /** Which write path merges: the lease wait and the `mako_merge_path` label. Default "final". */
      mergePath?: CdcMergePath;
    },
  ): Promise<{ written: number }> {
    const stagingTable = bigQueryStagingTableName(
      layout.tableName,
      flowId,
      options?.stagingSuffix,
    );
    return this.mergeStagingToLive(layout, stagingTable, entitySchema, {
      knownStagingRowCount: options?.knownStagingRowCount,
      fullRead: options?.fullRead,
      absentColumns: options?.absentColumns,
      mergePath: options?.mergePath ?? "final",
      flowId,
    });
  }

  /**
   * The columns some staging row lists in `_mako_absent_cols`. Returns
   * undefined when the query fails: the MERGE then reads every staged column
   * from live, which is correct and costs more.
   */
  private async resolveStagingAbsentColumns(
    target: BigQueryTarget,
    fullStaging: string,
    liveTable: string,
  ): Promise<Set<string> | undefined> {
    const result = await runBigQuery(
      target,
      buildStagingAbsentColumnsQuery(fullStaging),
    );
    if (!result.success) {
      log.warn("Absent-column probe failed; MERGE reads every live column", {
        liveTable,
        error: result.error,
      });
      return undefined;
    }
    const rows = (result.data as Array<{ c?: unknown }> | undefined) || [];
    return new Set(rows.map(r => String(r.c)));
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
      /** Called when a partitioned table merges without a partition filter. */
      onUnpruned?: (u: UnprunedMerge) => void;
    },
  ): Promise<string | undefined> {
    const table = await getLiveTablePartitioning(target, p.layout.tableName);
    const layoutField = p.layout.partitioning?.field;
    // Only a table known to be partitioned on a column can be scanned in full
    // by mistake. A layout that names another column is the likeliest cause.
    const unpruned = (
      reason: UnprunedMergeReason,
      detail?: Record<string, unknown>,
    ): undefined => {
      if (!table?.field) return undefined;
      p.onUnpruned?.({
        // A mismatch explains an unpruned MERGE only when the table could not
        // be pruned at all. Too many partitions stays too many partitions.
        reason:
          reason === "no_probe" &&
          layoutField &&
          layoutField.toLowerCase() !== table.field.toLowerCase()
            ? "layout_mismatch"
            : reason,
        tableField: table.field,
        tableGranularity: table.type,
        layoutField,
        layoutGranularity: p.layout.partitioning?.granularity,
        ...detail,
      });
      return undefined;
    };
    if (process.env.CDC_BQ_MERGE_PARTITION_PRUNE === "off") {
      return unpruned("no_probe", { detail: "pruning switched off" });
    }
    // Prune on the column the live table is partitioned on, which can differ
    // from the layout (resolveMergePartitioning).
    const pruneOn = resolveMergePartitioning({
      table,
      layout: p.layout.partitioning,
      liveTypes: p.liveTypes,
    });
    if (!pruneOn) {
      return unpruned("no_probe", {
        detail: "partition column is not a TIMESTAMP",
      });
    }
    const { field, granularity } = pruneOn;
    if (field !== p.layout.partitioning?.field) {
      log.info("Live table partition column differs from the layout", {
        liveTable: p.layout.tableName,
        tableField: field,
        layoutField: p.layout.partitioning?.field,
      });
    }
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
      return unpruned("no_probe", { detail: "partition probe failed" });
    }
    const rows = (result.data as Array<{ p?: unknown }> | undefined) || [];
    if (rows.length > MERGE_PRUNE_MAX_PARTITIONS) {
      log.info("MERGE spans too many partitions; merging unfiltered", {
        liveTable: p.layout.tableName,
        partitions: rows.length,
      });
      return unpruned("too_many_partitions", {
        partitions: rows.length,
        maxPartitions: MERGE_PRUNE_MAX_PARTITIONS,
      });
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

  /**
   * One structured warning per table per hour for a MERGE that read a
   * partitioned live table without a partition filter, with the job's billed
   * bytes once BigQuery reports them (a metadata read, never billed).
   */
  private async warnUnprunedMerge(
    target: BigQueryTarget,
    p: {
      unpruned: UnprunedMerge;
      liveTable: string;
      flowId?: string;
      path: CdcMergePath;
      job?: { jobId: string; location?: string };
    },
  ): Promise<void> {
    const key = `${target.projectId}.${target.dataset}.${p.liveTable}`;
    if (!claimUnprunedMergeWarning(key)) return;
    let totalBytesBilled: string | undefined;
    if (p.job) {
      try {
        const [meta] = await withTimeout(
          target.bq
            .job(p.job.jobId, {
              location: p.job.location ?? target.datasetLocation,
            })
            .getMetadata(),
          UNPRUNED_WARN_JOB_READ_TIMEOUT_MS,
        );
        totalBytesBilled = (
          meta as { statistics?: { query?: { totalBytesBilled?: string } } }
        )?.statistics?.query?.totalBytesBilled;
      } catch {
        // The bytes are extra detail: the warning stands without them.
      }
    }
    log.warn("MERGE ran without partition pruning on a partitioned table", {
      flowId: p.flowId,
      table: p.liveTable,
      dataset: target.dataset,
      path: p.path,
      reason: p.unpruned.reason,
      detail: p.unpruned.detail,
      tablePartitionField: p.unpruned.tableField,
      tablePartitionGranularity: p.unpruned.tableGranularity,
      layoutPartitionField: p.unpruned.layoutField,
      layoutPartitionGranularity: p.unpruned.layoutGranularity,
      partitions: p.unpruned.partitions,
      maxPartitions: p.unpruned.maxPartitions,
      jobId: p.job?.jobId,
      total_bytes_billed: totalBytesBilled,
    });
  }

  private async mergeStagingToLive(
    layout: CdcEntityLayout,
    stagingTable: string,
    entitySchema: ConnectorEntitySchema | undefined,
    options: {
      knownStagingRowCount?: number;
      fullRead?: boolean;
      absentColumns?: ReadonlySet<string>;
      mergePath: CdcMergePath;
      flowId?: string;
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

    const stagingRowCount = options.knownStagingRowCount ?? 0;

    // Airbyte-style write modes: "append" inserts staging rows as-is
    // (history accumulates); "overwrite" is handled by truncateLiveTable at
    // run start, then appends; default dedups via MERGE.
    const writeMode = layout.writeMode || "append_dedup";
    const insertCols = allColumns.filter(c => stagingCols.has(c));
    const insertColList = insertCols.map(escId).join(", ");
    const isDedup = writeMode !== "append" && writeMode !== "overwrite";
    // The MERGE reads from live only the columns some staged row lacks. The
    // in-memory path knows them. The bulk flush asks staging. This runs
    // before the lease: it reads staging only.
    const absentColumns =
      isDedup && stagedCols.has(ABSENT_COLUMNS_FIELD)
        ? (options.absentColumns ??
          (await this.resolveStagingAbsentColumns(
            target,
            fullStaging,
            liveTable,
          )))
        : undefined;
    const path = options.mergePath;

    // Set by the MERGE closure, read after the lease is released.
    let unpruned: UnprunedMerge | undefined;
    let mergeJob: { jobId: string; location?: string } | undefined;

    const runMerge = async (
      lease: TableWriteLease | undefined,
    ): Promise<void> => {
      // Every dedup path prunes. The probe and the MERGE run under the table
      // write lease, so no other writer moves or inserts a key in between.
      unpruned = undefined;
      const livePartitionFilter = isDedup
        ? await this.resolveLivePartitionFilter(target, {
            layout,
            fullLive,
            fullStaging,
            liveTypes,
            entitySchema,
            onUnpruned: u => {
              unpruned = u;
            },
          })
        : undefined;
      mergeJob = undefined;
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
            fullRead: options.fullRead,
            absentColumns,
          });

      log.info("Starting staging-to-live MERGE", {
        liveTable,
        stagingTable,
        dataset,
        stagingRowCount,
        columnCount: allColumns.length,
        schemaCacheHit,
        partitionPruned: livePartitionFilter !== undefined,
        absentColumns: absentColumns ? [...absentColumns] : undefined,
        path,
        leaseWaitMs: lease ? Math.round(lease.waitMs) : undefined,
      });

      if (isDedup && this.config.hooks?.beforeMerge) {
        await this.config.hooks.beforeMerge({ liveTable, path });
      }

      const maxWaitMs = mergeMaxWaitMs();
      await withQueryLabels(
        {
          mako_merge_path: path,
          mako_lease_wait_ms:
            lease !== undefined ? String(Math.round(lease.waitMs)) : undefined,
        },
        () =>
          retryOnQuota(
            async () => {
              const mergeResult = await runBigQueryWrite(target, mergeStmt, {
                bigQueryJobMaxWaitMs: maxWaitMs,
                onJobStarted: job => {
                  mergeJob = job;
                  lease?.recordJob(job);
                },
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
              lease?.markJobDone();
            },
            { label: `mergeStagingToLive:MERGE(${liveTable})` },
          ),
      );
    };

    // A plain INSERT (append, overwrite) probes nothing: no lease.
    if (isDedup) {
      await this.underTableWriteLease(
        target,
        liveTable,
        { path, flowId: options.flowId },
        runMerge,
      );
    } else {
      await runMerge(undefined);
    }

    // After the lease: a slow jobs.get must not hold the table's writer slot,
    // and nothing waits for the warning.
    if (unpruned) {
      void this.warnUnprunedMerge(target, {
        unpruned,
        liveTable,
        flowId: options.flowId,
        path,
        job: mergeJob,
      }).catch(() => undefined);
    }

    log.info("Merged staging to live via MERGE", {
      liveTable,
      stagingTable,
      dataset,
      stagingRowCount,
      skippedLiveAdds,
      path,
    });

    return { written: stagingRowCount };
  }

  /** Full Refresh | Overwrite: clear the live table (no-op when absent). */
  async truncateLiveTable(layout: CdcEntityLayout): Promise<void> {
    const target = await this.resolveBqClient();
    const result = await runBigQueryWrite(
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

  /** Read and cancel BigQuery jobs for the table write lease. */
  private leaseJobControl(target: BigQueryTarget): LeaseJobControl {
    const jobOf = (job: { jobId: string; location?: string }) =>
      target.bq.job(job.jobId, {
        location: job.location ?? target.datasetLocation,
      });
    return {
      isDone: async job => {
        try {
          const [meta] = await jobOf(job).getMetadata();
          return (
            (meta as { status?: { state?: string } })?.status?.state === "DONE"
          );
        } catch (err) {
          // A job BigQuery does not know is not running.
          if ((err as { code?: number } | null)?.code === 404) return true;
          throw err;
        }
      },
      cancel: async job => {
        await jobOf(job).cancel();
      },
    };
  }

  /**
   * Run `fn` holding the live table's write lease
   * (sync-cdc/table-write-lease.ts), keyed like the schema cache. Logs the
   * wait of every write.
   */
  private async underTableWriteLease<T>(
    target: BigQueryTarget,
    liveTable: string,
    p: { path: CdcMergePath; flowId?: string },
    fn: (lease: TableWriteLease | undefined) => Promise<T>,
  ): Promise<T> {
    const key = getSchemaCacheKey(target.projectId, target.dataset, liveTable);
    const flowId = p.flowId ?? currentQueryLabels().mako_flow;
    return withTableWriteLease(
      key,
      {
        path: p.path,
        flowId,
        maxWaitMs: tableWriteLeaseMaxWaitMs(p.path),
        jobs: this.leaseJobControl(target),
        ...this.config.hooks?.lease,
      },
      async lease => {
        if (lease) {
          log.info("Table write lease acquired", {
            flowId,
            table: liveTable,
            dataset: target.dataset,
            path: p.path,
            waitMs: Math.round(lease.waitMs),
          });
        }
        return fn(lease);
      },
    );
  }

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
    // Validated at use time: a stored key of another type is refused, and the
    // client gets the email and private key only.
    const credentials = googleClientCredentials(conn.service_account_json);
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
      // The emulator is a development tool. In production a destination that
      // names a local address is refused, so a tenant cannot redirect the
      // client. The endpoint is set on this client only, never through
      // process env, which every later BigQuery client in the process reads.
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "BigQuery destination: a local api_base_url is not allowed in production.",
        );
      }
      bqOptions.apiEndpoint = bigQueryEmulatorEndpoint(apiBaseUrl as string);
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
    mergePath: CdcMergePath;
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
          absentColumns: parquet.absentColumns,
          mergePath: params.mergePath,
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
          const result = await runBigQueryWrite(
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
