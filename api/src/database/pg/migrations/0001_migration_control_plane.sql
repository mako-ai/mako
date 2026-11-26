-- Phase 0: Migration control-plane tables (rollout state, backfill checkpoints, tombstones, quarantine)

CREATE TABLE IF NOT EXISTS "migration_domain_state" (
  "domain" text NOT NULL,
  "scope_key" text NOT NULL DEFAULT 'global',
  "workspace_id" uuid,
  "mode" text NOT NULL DEFAULT 'mongo_only'
    CHECK ("mode" IN (
      'mongo_only',
      'dual_write_mongo_read',
      'dual_write_shadow_compare',
      'dual_write_pg_read',
      'pg_only'
    )),
  "shadow_sample_rate" real NOT NULL DEFAULT 0
    CHECK ("shadow_sample_rate" >= 0 AND "shadow_sample_rate" <= 1),
  "updated_by" text,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "migration_domain_state_pkey" PRIMARY KEY ("domain", "scope_key"),
  CONSTRAINT "migration_domain_state_scope_check" CHECK (
    ("scope_key" = 'global' AND "workspace_id" IS NULL)
    OR ("scope_key" <> 'global' AND "workspace_id" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_migration_domain_state_workspace"
  ON "migration_domain_state" ("workspace_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "migration_backfill_jobs" (
  "domain" text NOT NULL,
  "scope_key" text NOT NULL DEFAULT 'global',
  "workspace_id" uuid,
  "status" text NOT NULL DEFAULT 'pending'
    CHECK ("status" IN ('pending', 'running', 'paused', 'completed', 'failed')),
  "last_cursor" text,
  "rows_processed" bigint NOT NULL DEFAULT 0,
  "rows_upserted" bigint NOT NULL DEFAULT 0,
  "rows_skipped_tombstone" bigint NOT NULL DEFAULT 0,
  "rows_quarantined" bigint NOT NULL DEFAULT 0,
  "error_message" text,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "migration_backfill_jobs_pkey" PRIMARY KEY ("domain", "scope_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "migration_tombstones" (
  "table_name" text NOT NULL,
  "entity_id" text NOT NULL,
  "deleted_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "migration_tombstones_pkey" PRIMARY KEY ("table_name", "entity_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_migration_tombstones_deleted_at"
  ON "migration_tombstones" ("deleted_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "migration_quarantine" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "domain" text NOT NULL,
  "collection_name" text NOT NULL,
  "mongo_id" text NOT NULL,
  "workspace_id" uuid,
  "reason" text NOT NULL,
  "payload" jsonb,
  "quarantined_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_migration_quarantine_domain_col"
  ON "migration_quarantine" ("domain", "collection_name", "mongo_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_migration_quarantine_unresolved"
  ON "migration_quarantine" ("domain", "resolved_at");
