/**
 * Phase 0 control-plane tables for incremental MongoDB -> Neon Postgres migration.
 *
 * These tables live exclusively in Postgres and coordinate:
 *   - `migration_domain_state`: per-domain and per-workspace rollout stages
 *   - `migration_backfill_jobs`: resumable cursor checkpoints for batch backfills
 *   - `migration_tombstones`: delete markers preventing stale backfill resurrections
 *   - `migration_quarantine`: orphaned/corrupt legacy Mongo docs skipped during backfill
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const MIGRATION_MODES = [
  "mongo_only",
  "dual_write_mongo_read",
  "dual_write_shadow_compare",
  "dual_write_pg_read",
  "pg_only",
] as const;

export type MigrationMode = (typeof MIGRATION_MODES)[number];

export const BACKFILL_JOB_STATUSES = [
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
] as const;

export type BackfillJobStatus = (typeof BACKFILL_JOB_STATUSES)[number];

/** Scope key literal used for domain-wide (global) state rows. */
export const GLOBAL_SCOPE_KEY = "global";

export const migrationDomainState = pgTable(
  "migration_domain_state",
  {
    domain: text("domain").notNull(),
    /** `'global'` for domain default, or lowercase workspace UUID string for a workspace override. */
    scopeKey: text("scope_key").notNull().default(GLOBAL_SCOPE_KEY),
    workspaceId: uuid("workspace_id"),
    mode: text("mode").$type<MigrationMode>().notNull().default("mongo_only"),
    /** Probability in [0, 1] for shadow-compare reads (Stage 3) or reverse shadow reads (Stage 4). */
    shadowSampleRate: real("shadow_sample_rate").notNull().default(0),
    updatedBy: text("updated_by"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    primaryKey({
      name: "migration_domain_state_pkey",
      columns: [table.domain, table.scopeKey],
    }),
    index("idx_migration_domain_state_workspace").on(table.workspaceId),
  ],
);

export const migrationBackfillJobs = pgTable(
  "migration_backfill_jobs",
  {
    domain: text("domain").notNull(),
    /** `'global'` or lowercase workspace UUID string. */
    scopeKey: text("scope_key").notNull().default(GLOBAL_SCOPE_KEY),
    workspaceId: uuid("workspace_id"),
    status: text("status")
      .$type<BackfillJobStatus>()
      .notNull()
      .default("pending"),
    /** Last processed MongoDB `_id` (24-hex ObjectId or string cursor). */
    lastCursor: text("last_cursor"),
    rowsProcessed: bigint("rows_processed", { mode: "number" })
      .notNull()
      .default(0),
    rowsUpserted: bigint("rows_upserted", { mode: "number" })
      .notNull()
      .default(0),
    rowsSkippedTombstone: bigint("rows_skipped_tombstone", { mode: "number" })
      .notNull()
      .default(0),
    rowsQuarantined: bigint("rows_quarantined", { mode: "number" })
      .notNull()
      .default(0),
    errorMessage: text("error_message"),
    /** Unique lease token held by the currently running backfill worker for CAS checkpointing. */
    leaseToken: text("lease_token"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    primaryKey({
      name: "migration_backfill_jobs_pkey",
      columns: [table.domain, table.scopeKey],
    }),
  ],
);

export const migrationTombstones = pgTable(
  "migration_tombstones",
  {
    tableName: text("table_name").notNull(),
    /** Canonical entity identifier (lowercase UUID string or text PK). */
    entityId: text("entity_id").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    primaryKey({
      name: "migration_tombstones_pkey",
      columns: [table.tableName, table.entityId],
    }),
    index("idx_migration_tombstones_deleted_at").on(table.deletedAt),
  ],
);

export const migrationQuarantine = pgTable(
  "migration_quarantine",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domain: text("domain").notNull(),
    collectionName: text("collection_name").notNull(),
    mongoId: text("mongo_id").notNull(),
    workspaceId: uuid("workspace_id"),
    reason: text("reason").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  table => [
    index("idx_migration_quarantine_domain_col").on(
      table.domain,
      table.collectionName,
      table.mongoId,
    ),
    index("idx_migration_quarantine_unresolved").on(
      table.domain,
      table.resolvedAt,
    ),
    uniqueIndex("uq_migration_quarantine_unresolved")
      .on(table.domain, table.collectionName, table.mongoId)
      .where(sql`${table.resolvedAt} IS NULL`),
  ],
);

export type MigrationDomainStateRow = typeof migrationDomainState.$inferSelect;
export type MigrationBackfillJobRow = typeof migrationBackfillJobs.$inferSelect;
export type MigrationTombstoneRow = typeof migrationTombstones.$inferSelect;
export type MigrationQuarantineRow = typeof migrationQuarantine.$inferSelect;
