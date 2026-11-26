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
import { and, eq, inArray } from "drizzle-orm";
import { getPgDirectDb, type MakoPgDb } from "../database/pg/client";
import { parseEntityId } from "../database/pg/id-codec";
import {
  GLOBAL_SCOPE_KEY,
  migrationBackfillJobs,
  migrationQuarantine,
  migrationTombstones,
} from "../database/pg/schema/control-plane";
import { loggers } from "../logging";
import type { BackfillProgressSummary, MigrationDomain } from "./types";

const logger = loggers.migration();

export interface BackfillItem<TDoc = unknown> {
  /** Monotonic cursor value (typically Mongo `_id` as 24-hex ObjectId or string). */
  cursor: string;
  /** Canonical Postgres entity ID (lowercase UUID string or text PK) used for tombstone checks. */
  entityId: string;
  /** Optional workspace ID (24-hex ObjectId or UUID). */
  workspaceId?: string | null;
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
  /** Optional validation (e.g. FK existence, closed UTC day check). Failed items are quarantined. */
  validate?: (
    item: BackfillItem<TDoc>,
    db: MakoPgDb,
  ) => Promise<BackfillValidationResult> | BackfillValidationResult;
  /**
   * Idempotently upsert `items` into Postgres (using `ON CONFLICT DO UPDATE` guarded by
   * `updated_at` or `ON CONFLICT DO NOTHING` for immutable tables).
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

/** Return the subset of `entityIds` that currently have a tombstone for `tableName`. */
export async function findTombstonedEntityIds(
  db: MakoPgDb,
  tableName: string,
  entityIds: string[],
): Promise<Set<string>> {
  if (entityIds.length === 0) return new Set();
  const normalized = entityIds.map(id => id.toLowerCase());
  const rows = await db
    .select({ entityId: migrationTombstones.entityId })
    .from(migrationTombstones)
    .where(
      and(
        eq(migrationTombstones.tableName, tableName),
        inArray(migrationTombstones.entityId, normalized),
      ),
    );
  return new Set(rows.map(r => r.entityId.toLowerCase()));
}

export interface QuarantineEntry {
  domain: string;
  collectionName: string;
  mongoId: string;
  workspaceId?: string | null;
  reason: string;
  payload?: Record<string, unknown>;
}

/** Persist an unmigratable/orphaned Mongo record into `migration_quarantine`. */
export async function quarantineRecord(
  db: MakoPgDb,
  entry: QuarantineEntry,
): Promise<void> {
  const wsUuid = entry.workspaceId
    ? (parseEntityId(entry.workspaceId)?.uuid ?? null)
    : null;
  await db.insert(migrationQuarantine).values({
    domain: entry.domain,
    collectionName: entry.collectionName,
    mongoId: entry.mongoId,
    workspaceId: wsUuid,
    reason: entry.reason,
    payload: entry.payload ?? null,
    quarantinedAt: new Date(),
  });
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

  const startedAt = new Date();
  if (!dryRun) {
    await db
      .insert(migrationBackfillJobs)
      .values({
        domain: options.domain,
        scopeKey,
        workspaceId: workspaceUuid,
        status: "running",
        lastCursor,
        rowsProcessed,
        rowsUpserted,
        rowsSkippedTombstone,
        rowsQuarantined,
        errorMessage: null,
        startedAt,
        completedAt: null,
        updatedAt: startedAt,
      })
      .onConflictDoUpdate({
        target: [migrationBackfillJobs.domain, migrationBackfillJobs.scopeKey],
        set: {
          status: "running",
          lastCursor,
          rowsProcessed,
          rowsUpserted,
          rowsSkippedTombstone,
          rowsQuarantined,
          errorMessage: null,
          startedAt,
          completedAt: null,
          updatedAt: startedAt,
        },
      });
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

      const tombstoned = await findTombstonedEntityIds(
        db,
        handler.targetTable,
        batch.map(item => item.entityId),
      );

      const eligible: Array<BackfillItem<any>> = [];
      for (const item of batch) {
        if (tombstoned.has(item.entityId.toLowerCase())) {
          rowsSkippedTombstone += 1;
          continue;
        }
        if (handler.validate) {
          const verdict = await handler.validate(item, db);
          if (!verdict.ok) {
            rowsQuarantined += 1;
            if (!dryRun) {
              await quarantineRecord(db, {
                domain: options.domain,
                collectionName: handler.collectionName,
                mongoId: item.cursor,
                workspaceId: item.workspaceId ?? options.workspaceId ?? null,
                reason: verdict.reason,
                payload: verdict.sanitizedPayload,
              });
            }
            continue;
          }
        }
        eligible.push(item);
      }

      if (!dryRun && eligible.length > 0) {
        rowsUpserted += await handler.upsertBatch(eligible, db);
      } else if (dryRun) {
        rowsUpserted += eligible.length;
      }

      lastCursor = batch[batch.length - 1].cursor;

      if (!dryRun) {
        await db
          .update(migrationBackfillJobs)
          .set({
            lastCursor,
            rowsProcessed,
            rowsUpserted,
            rowsSkippedTombstone,
            rowsQuarantined,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(migrationBackfillJobs.domain, options.domain),
              eq(migrationBackfillJobs.scopeKey, scopeKey),
            ),
          );
      }

      if (batch.length < batchSize) {
        break;
      }
    }

    if (!dryRun) {
      const now = new Date();
      await db
        .update(migrationBackfillJobs)
        .set({
          status: finalStatus,
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
          ),
        );
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
    if (!dryRun) {
      await db
        .update(migrationBackfillJobs)
        .set({
          status: "failed",
          errorMessage,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(migrationBackfillJobs.domain, options.domain),
            eq(migrationBackfillJobs.scopeKey, scopeKey),
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
