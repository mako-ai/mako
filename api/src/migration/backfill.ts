/**
 * Resumable MongoDB -> Postgres backfill engine.
 *
 * Design guarantees:
 *   - Deterministic `_id ASC` cursor pagination persisted in `migration_backfill_jobs`.
 *   - Idempotent upserts: domain handlers apply an `updatedAt` guard
 *     (`WHERE tbl.updated_at IS NULL OR EXCLUDED.updated_at >= tbl.updated_at`)
 *     so stale backfill reads never overwrite live dual-writes.
 *   - Tombstone check against `migration_tombstones` prevents resurrecting entities
 *     deleted while backfill is in flight.
 *   - Closed-UTC-day helper (`isClosedUtcDay`) prevents double-counting `$inc` daily
 *     rollup counters (`app_usage_daily`, `skill_usage_daily`).
 *   - Orphan/corrupt legacy documents are recorded in `migration_quarantine` instead
 *     of aborting the entire batch.
 */
import { and, eq, inArray, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { getPgDirectDb, type MakoPgDb } from "../database/pg/client";
import {
  generateUuidv7,
  normalizeEntityId,
  parseEntityId,
} from "../database/pg/id-codec";
import {
  GLOBAL_SCOPE_KEY,
  migrationBackfillJobs,
  migrationQuarantine,
  migrationTombstones,
} from "../database/pg/schema/control-plane";
import { loggers } from "../logging";
import { chunkRows, chunkValues, dedupByKey } from "./bulk-helpers";
import type { BackfillProgressSummary, MigrationDomain } from "./types";

const logger = loggers.migration();

/** Default lease duration (10 minutes) before an abandoned `running` backfill job can be reclaimed. */
export const DEFAULT_BACKFILL_LEASE_MS = 10 * 60 * 1000;

/** Thrown when another worker currently holds an active lease on the `(domain, scope)` backfill job. */
export class BackfillJobLockedError extends Error {
  constructor(domain: string, scopeKey: string) {
    super(
      `Backfill job for domain "${domain}" (scope "${scopeKey}") is already running with an active lease.`,
    );
    this.name = "BackfillJobLockedError";
  }
}

/** Thrown when a running backfill worker discovers its lease was stolen or cleared before checkpointing. */
export class BackfillLeaseLostError extends Error {
  constructor(domain: string, scopeKey: string) {
    super(
      `Backfill lease lost for domain "${domain}" (scope "${scopeKey}") before checkpoint update.`,
    );
    this.name = "BackfillLeaseLostError";
  }
}

export interface BackfillItem<TDoc = unknown> {
  /** Monotonic cursor value (typically Mongo `_id` as 24-hex ObjectId or string). */
  cursor: string;
  /** Canonical Postgres entity ID (lowercase UUID string or text PK) used for tombstone checks. */
  entityId: string;
  /** Optional workspace ID (24-hex ObjectId or UUID). */
  workspaceId?: string | null;
  /** Optional per-item target table override for multi-table composite domain handlers. */
  targetTable?: string;
  /** Optional per-item Mongo collection override for quarantine records in composite handlers. */
  collectionName?: string;
  doc: TDoc;
}

export type BackfillValidationResult =
  | { ok: true }
  | { ok: false; reason: string; sanitizedPayload?: Record<string, unknown> };

export interface BackfillDomainHandler<TDoc = unknown> {
  domain: MigrationDomain;
  collectionName: string;
  targetTable: string;
  /**
   * Fetch the next batch strictly after `afterCursor` ordered by `_id ASC`.
   * Return fewer than `limit` rows when the collection/scope is exhausted.
   */
  fetchBatch(params: {
    afterCursor: string | null;
    limit: number;
    workspaceId: string | null;
  }): Promise<Array<BackfillItem<TDoc>>>;
  /**
   * Optional per-batch prefetch hook invoked once right before `validate` runs
   * on non-tombstoned items in a batch. Allows handlers to batch-prefetch FK
   * existence sets and user UUID lookup maps in O(1) Postgres queries instead
   * of per-row SELECTs inside `validate()`.
   */
  prepareBatch?: (
    items: Array<BackfillItem<TDoc>>,
    db: MakoPgDb,
  ) => Promise<void> | void;
  /** Optional validation (e.g. FK existence, closed UTC day check). Failed items are quarantined. */
  validate?: (
    item: BackfillItem<TDoc>,
    db: MakoPgDb,
  ) => Promise<BackfillValidationResult> | BackfillValidationResult;
  /**
   * Idempotently upsert `items` into Postgres (using `ON CONFLICT DO UPDATE` guarded by
   * `updated_at` or `ON CONFLICT DO NOTHING` for immutable tables).
   *
   * **Tombstone atomicity contract:** Implementations MUST guard each INSERT with
   * `notTombstonedSql(targetTable, entityId)` (`INSERT ... SELECT ... WHERE NOT EXISTS
   * (SELECT 1 FROM migration_tombstones ...)`) so a concurrent live delete racing with
   * backfill can never be resurrected. `runBackfill()` also re-checks tombstones inside
   * the upsert transaction immediately before invoking `upsertBatch()`.
   *
   * Returns the number of rows upserted.
   */
  upsertBatch(items: Array<BackfillItem<TDoc>>, db: MakoPgDb): Promise<number>;
}

const backfillRegistry = new Map<string, BackfillDomainHandler<any>>();

export function registerBackfillDomain<TDoc>(
  handler: BackfillDomainHandler<TDoc>,
): void {
  backfillRegistry.set(handler.domain, handler);
}

export function getBackfillDomain(
  domain: MigrationDomain,
): BackfillDomainHandler | undefined {
  return backfillRegistry.get(domain);
}

export function listBackfillDomains(): string[] {
  return [...backfillRegistry.keys()].sort();
}

export function clearBackfillRegistryForTests(): void {
  backfillRegistry.clear();
}

/** Return the UTC date string (`YYYY-MM-DD`) for `now`. */
export function currentUtcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * True iff `day` (`YYYY-MM-DD`) is strictly before the current UTC day.
 * Counter rollup backfills (`app_usage_daily`, `skill_usage_daily`) only process
 * closed UTC days to avoid racing live `$inc` dual-writes on today's bucket.
 */
export function isClosedUtcDay(day: string, now: Date = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return false;
  }
  return day < currentUtcDay(now);
}

/**
 * Build a SQL `NOT EXISTS` predicate against `migration_tombstones` so backfill
 * `INSERT ... SELECT ... WHERE ${notTombstonedSql(tableName, entityId)}` checks
 * tombstones atomically in the same statement as the upsert.
 *
 * Accepts either a raw entity ID string (normalized via `normalizeEntityId`) or
 * a SQL expression (e.g. a column/alias from a `VALUES` CTE).
 */
export function notTombstonedSql(
  tableName: string,
  entityId: string | SQL,
): SQL {
  const idExpr =
    typeof entityId === "string"
      ? sql`${normalizeEntityId(entityId)}`
      : entityId;
  return sql`NOT EXISTS (
    SELECT 1 FROM "migration_tombstones" AS _mt
    WHERE _mt."table_name" = ${tableName}
      AND _mt."entity_id" = ${idExpr}
  )`;
}

/** Return the subset of `entityIds` that currently have a tombstone for `tableName`. */
export async function findTombstonedEntityIds(
  db: MakoPgDb,
  tableName: string,
  entityIds: string[],
): Promise<Set<string>> {
  if (entityIds.length === 0) return new Set();
  const normalized = [...new Set(entityIds.map(normalizeEntityId))];
  const out = new Set<string>();
  for (const chunk of chunkValues(normalized)) {
    const rows = await db
      .select({ entityId: migrationTombstones.entityId })
      .from(migrationTombstones)
      .where(
        and(
          eq(migrationTombstones.tableName, tableName),
          inArray(migrationTombstones.entityId, chunk),
        ),
      );
    for (const r of rows) {
      out.add(normalizeEntityId(r.entityId));
    }
  }
  return out;
}

export interface QuarantineEntry {
  domain: string;
  collectionName: string;
  mongoId: string;
  workspaceId?: string | null;
  reason: string;
  payload?: Record<string, unknown>;
}

/**
 * Persist an unmigratable/orphaned Mongo record into `migration_quarantine`.
 * Deduplicates unresolved rows via the partial unique index
 * `uq_migration_quarantine_unresolved (domain, collection_name, mongo_id) WHERE resolved_at IS NULL`.
 *
 * Returns `true` if a new quarantine row was inserted, or `false` if an
 * unresolved quarantine entry already existed for this document.
 */
export async function quarantineRecord(
  db: MakoPgDb,
  entry: QuarantineEntry,
): Promise<boolean> {
  const wsUuid = entry.workspaceId
    ? (parseEntityId(entry.workspaceId)?.uuid ?? null)
    : null;
  const inserted = await db
    .insert(migrationQuarantine)
    .values({
      domain: entry.domain,
      collectionName: entry.collectionName,
      mongoId: entry.mongoId,
      workspaceId: wsUuid,
      reason: entry.reason,
      payload: entry.payload ?? null,
      quarantinedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [
        migrationQuarantine.domain,
        migrationQuarantine.collectionName,
        migrationQuarantine.mongoId,
      ],
      where: sql`${migrationQuarantine.resolvedAt} IS NULL`,
    })
    .returning({ id: migrationQuarantine.id });
  return inserted.length > 0;
}

/**
 * Bulk-insert unmigratable/orphaned Mongo records into `migration_quarantine`.
 * Deduplicates unresolved rows via `uq_migration_quarantine_unresolved` and
 * returns the number of newly inserted quarantine rows.
 */
export async function quarantineRecordsBatch(
  db: MakoPgDb,
  entries: readonly QuarantineEntry[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const deduped = dedupByKey(
    entries,
    e => `${e.domain}\0${e.collectionName}\0${e.mongoId}`,
    existing => existing,
  );
  const now = new Date();
  let insertedCount = 0;
  for (const chunk of chunkRows(deduped, 7, 300)) {
    const inserted = await db
      .insert(migrationQuarantine)
      .values(
        chunk.map(entry => ({
          domain: entry.domain,
          collectionName: entry.collectionName,
          mongoId: entry.mongoId,
          workspaceId: entry.workspaceId
            ? (parseEntityId(entry.workspaceId)?.uuid ?? null)
            : null,
          reason: entry.reason,
          payload: entry.payload ?? null,
          quarantinedAt: now,
        })),
      )
      .onConflictDoNothing({
        target: [
          migrationQuarantine.domain,
          migrationQuarantine.collectionName,
          migrationQuarantine.mongoId,
        ],
        where: sql`${migrationQuarantine.resolvedAt} IS NULL`,
      })
      .returning({ id: migrationQuarantine.id });
    insertedCount += inserted.length;
  }
  return insertedCount;
}

export interface RunBackfillOptions {
  domain: MigrationDomain;
  /** Optional workspace scope (24-hex ObjectId or UUID). */
  workspaceId?: string | null;
  batchSize?: number;
  /** Maximum batches to run before pausing (useful for bounded cron runs and tests). */
  maxBatches?: number;
  dryRun?: boolean;
  /** Ignore any saved checkpoint and restart from the beginning. */
  resetCursor?: boolean;
  /** Lease duration (ms) before a stale `running` job may be reclaimed (default 10m). */
  leaseTimeoutMs?: number;
  db?: MakoPgDb;
  handler?: BackfillDomainHandler<any>;
}

export async function runBackfill(
  options: RunBackfillOptions,
): Promise<BackfillProgressSummary> {
  const handler = options.handler ?? getBackfillDomain(options.domain);
  if (!handler) {
    throw new Error(
      `No backfill handler registered for domain "${options.domain}". ` +
        `Registered domains: ${listBackfillDomains().join(", ") || "(none)"}`,
    );
  }

  const db = options.db ?? getPgDirectDb();
  const batchSize = Math.max(1, options.batchSize ?? 1000);
  const dryRun = options.dryRun ?? false;
  const leaseTimeoutMs = Math.max(
    1,
    options.leaseTimeoutMs ?? DEFAULT_BACKFILL_LEASE_MS,
  );

  let scopeKey = GLOBAL_SCOPE_KEY;
  let workspaceUuid: string | null = null;
  if (options.workspaceId) {
    const parsed = parseEntityId(options.workspaceId);
    if (!parsed) {
      throw new Error(
        `Invalid workspaceId for backfill: ${JSON.stringify(options.workspaceId)}`,
      );
    }
    scopeKey = parsed.uuid;
    workspaceUuid = parsed.uuid;
  }

  let lastCursor: string | null = null;
  let rowsProcessed = 0;
  let rowsUpserted = 0;
  let rowsSkippedTombstone = 0;
  let rowsQuarantined = 0;

  const startedAt = new Date();
  const leaseToken = generateUuidv7();

  if (dryRun) {
    if (!options.resetCursor) {
      const existing = await db
        .select()
        .from(migrationBackfillJobs)
        .where(
          and(
            eq(migrationBackfillJobs.domain, options.domain),
            eq(migrationBackfillJobs.scopeKey, scopeKey),
          ),
        );
      if (existing[0]) {
        lastCursor = existing[0].lastCursor;
        rowsProcessed = existing[0].rowsProcessed;
        rowsUpserted = existing[0].rowsUpserted;
        rowsSkippedTombstone = existing[0].rowsSkippedTombstone;
        rowsQuarantined = existing[0].rowsQuarantined;
      }
    }
  } else {
    // Atomically claim the job lease. Succeeds only if no job row exists yet,
    // the job is not currently `running`, or an existing `running` job's lease
    // has expired (`updated_at < now - leaseTimeoutMs`).
    const leaseCutoff = new Date(startedAt.getTime() - leaseTimeoutMs);
    const conflictSet = options.resetCursor
      ? {
          status: "running" as const,
          leaseToken,
          lastCursor: null,
          rowsProcessed: 0,
          rowsUpserted: 0,
          rowsSkippedTombstone: 0,
          rowsQuarantined: 0,
          errorMessage: null,
          startedAt,
          completedAt: null,
          updatedAt: startedAt,
        }
      : {
          status: "running" as const,
          leaseToken,
          errorMessage: null,
          startedAt,
          completedAt: null,
          updatedAt: startedAt,
        };

    const claimed = await db
      .insert(migrationBackfillJobs)
      .values({
        domain: options.domain,
        scopeKey,
        workspaceId: workspaceUuid,
        status: "running",
        leaseToken,
        lastCursor: null,
        rowsProcessed: 0,
        rowsUpserted: 0,
        rowsSkippedTombstone: 0,
        rowsQuarantined: 0,
        errorMessage: null,
        startedAt,
        completedAt: null,
        updatedAt: startedAt,
      })
      .onConflictDoUpdate({
        target: [migrationBackfillJobs.domain, migrationBackfillJobs.scopeKey],
        set: conflictSet,
        setWhere: or(
          ne(migrationBackfillJobs.status, "running"),
          lt(migrationBackfillJobs.updatedAt, leaseCutoff),
        ),
      })
      .returning();

    if (claimed.length === 0) {
      throw new BackfillJobLockedError(options.domain, scopeKey);
    }

    const job = claimed[0];
    lastCursor = job.lastCursor;
    rowsProcessed = job.rowsProcessed;
    rowsUpserted = job.rowsUpserted;
    rowsSkippedTombstone = job.rowsSkippedTombstone;
    rowsQuarantined = job.rowsQuarantined;
  }

  let batchesRun = 0;
  let finalStatus: "completed" | "paused" = "completed";

  try {
    while (true) {
      if (options.maxBatches != null && batchesRun >= options.maxBatches) {
        finalStatus = "paused";
        break;
      }

      const batch = await handler.fetchBatch({
        afterCursor: lastCursor,
        limit: batchSize,
        workspaceId: options.workspaceId ?? null,
      });

      if (batch.length === 0) {
        break;
      }

      batchesRun += 1;
      rowsProcessed += batch.length;

      const idsByTable = new Map<string, string[]>();
      for (const item of batch) {
        const tbl = item.targetTable ?? handler.targetTable;
        const list = idsByTable.get(tbl);
        if (list) {
          list.push(item.entityId);
        } else {
          idsByTable.set(tbl, [item.entityId]);
        }
      }

      const tombstonedEntries = await Promise.all(
        [...idsByTable.entries()].map(
          async ([tbl, ids]) =>
            [tbl, await findTombstonedEntityIds(db, tbl, ids)] as const,
        ),
      );
      const tombstonedByTable = new Map<string, Set<string>>(tombstonedEntries);

      const nonTombstoned: Array<BackfillItem<any>> = [];
      for (const item of batch) {
        const tbl = item.targetTable ?? handler.targetTable;
        if (tombstonedByTable.get(tbl)?.has(normalizeEntityId(item.entityId))) {
          rowsSkippedTombstone += 1;
          continue;
        }
        nonTombstoned.push(item);
      }

      if (handler.prepareBatch && nonTombstoned.length > 0) {
        await handler.prepareBatch(nonTombstoned, db);
      }

      const eligible: Array<BackfillItem<any>> = [];
      const pendingQuarantines: QuarantineEntry[] = [];
      for (const item of nonTombstoned) {
        if (handler.validate) {
          const verdict = await handler.validate(item, db);
          if (!verdict.ok) {
            if (!dryRun) {
              pendingQuarantines.push({
                domain: options.domain,
                collectionName: item.collectionName ?? handler.collectionName,
                mongoId: item.cursor,
                workspaceId: item.workspaceId ?? options.workspaceId ?? null,
                reason: verdict.reason,
                payload: verdict.sanitizedPayload,
              });
            } else {
              rowsQuarantined += 1;
            }
            continue;
          }
        }
        eligible.push(item);
      }

      lastCursor = batch[batch.length - 1].cursor;

      if (!dryRun) {
        // Atomically commit quarantine inserts, final tombstone re-check,
        // upsertBatch, and CAS cursor/heartbeat update in a single transaction.
        // If `upsertBatch` fails or the lease was stolen, the entire batch
        // (including quarantine inserts and upserts) rolls back cleanly.
        const nextRowsProcessed = rowsProcessed;
        const txOutcome = await db.transaction(async tx => {
          const txDb = tx as unknown as MakoPgDb;
          const quarantinedInBatch =
            pendingQuarantines.length > 0
              ? await quarantineRecordsBatch(txDb, pendingQuarantines)
              : 0;

          let skippedLate = 0;
          let upserted = 0;
          if (eligible.length > 0) {
            const eligibleIdsByTable = new Map<string, string[]>();
            for (const item of eligible) {
              const tbl = item.targetTable ?? handler.targetTable;
              const list = eligibleIdsByTable.get(tbl);
              if (list) {
                list.push(item.entityId);
              } else {
                eligibleIdsByTable.set(tbl, [item.entityId]);
              }
            }
            const lateTombstonedByTable = new Map<string, Set<string>>();
            for (const [tbl, ids] of eligibleIdsByTable) {
              lateTombstonedByTable.set(
                tbl,
                await findTombstonedEntityIds(txDb, tbl, ids),
              );
            }
            const stillEligible: Array<BackfillItem<any>> = [];
            for (const item of eligible) {
              const tbl = item.targetTable ?? handler.targetTable;
              if (
                lateTombstonedByTable
                  .get(tbl)
                  ?.has(normalizeEntityId(item.entityId))
              ) {
                skippedLate += 1;
                continue;
              }
              stillEligible.push(item);
            }
            if (stillEligible.length > 0) {
              upserted = await handler.upsertBatch(stillEligible, txDb);
            }
          }

          const updated = await txDb
            .update(migrationBackfillJobs)
            .set({
              lastCursor,
              rowsProcessed: nextRowsProcessed,
              rowsUpserted: rowsUpserted + upserted,
              rowsSkippedTombstone: rowsSkippedTombstone + skippedLate,
              rowsQuarantined: rowsQuarantined + quarantinedInBatch,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(migrationBackfillJobs.domain, options.domain),
                eq(migrationBackfillJobs.scopeKey, scopeKey),
                eq(migrationBackfillJobs.status, "running"),
                eq(migrationBackfillJobs.leaseToken, leaseToken),
              ),
            )
            .returning({ domain: migrationBackfillJobs.domain });
          if (updated.length === 0) {
            throw new BackfillLeaseLostError(options.domain, scopeKey);
          }

          return { upserted, skippedLate, quarantinedInBatch };
        });
        rowsQuarantined += txOutcome.quarantinedInBatch;
        rowsSkippedTombstone += txOutcome.skippedLate;
        rowsUpserted += txOutcome.upserted;
      } else {
        rowsUpserted += eligible.length;
      }

      if (batch.length < batchSize) {
        break;
      }
    }

    if (!dryRun) {
      const now = new Date();
      const finished = await db
        .update(migrationBackfillJobs)
        .set({
          status: finalStatus,
          leaseToken: null,
          lastCursor,
          rowsProcessed,
          rowsUpserted,
          rowsSkippedTombstone,
          rowsQuarantined,
          completedAt: finalStatus === "completed" ? now : null,
          updatedAt: now,
        })
        .where(
          and(
            eq(migrationBackfillJobs.domain, options.domain),
            eq(migrationBackfillJobs.scopeKey, scopeKey),
            eq(migrationBackfillJobs.status, "running"),
            eq(migrationBackfillJobs.leaseToken, leaseToken),
          ),
        )
        .returning({ domain: migrationBackfillJobs.domain });
      if (finished.length === 0) {
        throw new BackfillLeaseLostError(options.domain, scopeKey);
      }
    }

    logger.info("Backfill run finished", {
      domain: options.domain,
      scopeKey,
      status: finalStatus,
      batchesRun,
      rowsProcessed,
      rowsUpserted,
      rowsSkippedTombstone,
      rowsQuarantined,
      dryRun,
    });

    return {
      domain: options.domain,
      scopeKey,
      status: finalStatus,
      lastCursor,
      batchesRun,
      rowsProcessed,
      rowsUpserted,
      rowsSkippedTombstone,
      rowsQuarantined,
      dryRun,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (!dryRun && !(error instanceof BackfillLeaseLostError)) {
      await db
        .update(migrationBackfillJobs)
        .set({
          status: "failed",
          leaseToken: null,
          errorMessage,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(migrationBackfillJobs.domain, options.domain),
            eq(migrationBackfillJobs.scopeKey, scopeKey),
            eq(migrationBackfillJobs.leaseToken, leaseToken),
          ),
        );
    }
    logger.error("Backfill run failed", {
      domain: options.domain,
      scopeKey,
      lastCursor,
      errorMessage,
    });
    throw error;
  }
}
