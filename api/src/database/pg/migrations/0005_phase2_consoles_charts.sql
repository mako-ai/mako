-- Phase 2A-2: Consoles & Charts (`consoles_charts` domain — 7 tables)
-- Tables: console_folders, saved_consoles, entity_versions, notebook_folders,
--         notebook_indexes, favourites, scheduled_query_runs.
--
-- Deferred cross-domain FK: `saved_consoles.connection_id -> database_connections(id)`
-- is intentionally NOT attached here; run `post-backfill/0005a_consoles_connection_fk.sql`
-- once both `connections` and `consoles_charts` backfills have completed.

CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- 1. console_folders (Mongo: consolefolders)
CREATE TABLE IF NOT EXISTS "console_folders" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "parent_id" uuid REFERENCES "console_folders"("id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  "is_private" boolean NOT NULL DEFAULT false,
  "owner_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "access" text NOT NULL DEFAULT 'private'
    CHECK ("access" IN ('private', 'workspace')),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_console_folders_ws_parent"
  ON "console_folders" ("workspace_id", "parent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_console_folders_ws_owner"
  ON "console_folders" ("workspace_id", "owner_id", "is_private");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_console_folders_ws_access"
  ON "console_folders" ("workspace_id", "access");
--> statement-breakpoint

-- 2. saved_consoles (Mongo: savedconsoles)
CREATE TABLE IF NOT EXISTS "saved_consoles" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "folder_id" uuid REFERENCES "console_folders"("id") ON DELETE SET NULL,
  "connection_id" uuid,
  "database_name" text,
  "database_id" text,
  "name" text NOT NULL,
  "description" text,
  "description_embedding" vector(1536),
  "embedding_model" text,
  "description_generated_at" timestamptz,
  "path" text,
  "source_blob_sha" text,
  "description_source_sha" text,
  "description_source" text
    CHECK ("description_source" IS NULL OR "description_source" IN ('authored', 'generated')),
  "code" text NOT NULL,
  "language" text NOT NULL
    CHECK ("language" IN ('sql', 'javascript', 'mongodb')),
  "chart_spec" jsonb,
  "results_view_mode" text
    CHECK ("results_view_mode" IS NULL OR "results_view_mode" IN ('table', 'json', 'chart')),
  "mongo_options" jsonb,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "owner_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "is_private" boolean NOT NULL DEFAULT false,
  "is_saved" boolean NOT NULL DEFAULT false,
  "access" text NOT NULL DEFAULT 'private'
    CHECK ("access" IN ('private', 'workspace')),
  "workspace_role" text NOT NULL DEFAULT 'viewer'
    CHECK ("workspace_role" IN ('viewer', 'editor')),
  "shared_with" jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof("shared_with") = 'array'),
  -- Flattened schedule & scheduledRun for indexed every-minute CAS claims
  "schedule_cron" text,
  "schedule_timezone" text,
  "scheduled_run_next_at" timestamptz,
  "scheduled_run_last_at" timestamptz,
  "scheduled_run_last_status" text
    CHECK ("scheduled_run_last_status" IS NULL OR "scheduled_run_last_status" IN ('success', 'error')),
  "scheduled_run_last_error" text,
  "scheduled_run_last_duration_ms" integer,
  "scheduled_run_last_rows_affected" bigint,
  "scheduled_run_last_row_count" bigint,
  "scheduled_run_count" integer NOT NULL DEFAULT 0,
  "scheduled_run_consecutive_failures" integer NOT NULL DEFAULT 0,
  "scheduled_run_permanent_failures" integer,
  "scheduled_run_paused_at" timestamptz,
  "scheduled_run_paused_reason" text,
  -- Concurrency, realtime diff & execution telemetry
  "version" integer NOT NULL DEFAULT 1,
  "draft_revision" integer NOT NULL DEFAULT 1,
  "last_draft_origin" text
    CHECK ("last_draft_origin" IS NULL OR "last_draft_origin" IN ('user', 'agent')),
  "last_run" jsonb,
  "last_executed_at" timestamptz,
  "execution_count" integer NOT NULL DEFAULT 0,
  "last_external_used_at" timestamptz,
  "external_use_count" integer NOT NULL DEFAULT 0,
  "last_external_source" text
    CHECK ("last_external_source" IS NULL OR "last_external_source" IN ('api', 'mcp')),
  "is_deleted" boolean NOT NULL DEFAULT false,
  "deleted_at" timestamptz,
  "search_tsv" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("name", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("description", '')), 'B')
  ) STORED,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_saved_consoles_ws_folder"
  ON "saved_consoles" ("workspace_id", "folder_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_saved_consoles_ws_path"
  ON "saved_consoles" ("workspace_id", "path")
  WHERE "path" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_saved_consoles_shared_with_gin"
  ON "saved_consoles" USING gin ("shared_with" jsonb_path_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_saved_consoles_ws_saved"
  ON "saved_consoles" ("workspace_id", "is_saved")
  WHERE "is_deleted" = false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_saved_consoles_ws_access_owner"
  ON "saved_consoles" ("workspace_id", "access", "owner_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_saved_consoles_connection"
  ON "saved_consoles" ("connection_id")
  WHERE "connection_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_saved_consoles_ws_sched_next"
  ON "saved_consoles" ("workspace_id", "scheduled_run_next_at")
  WHERE "scheduled_run_next_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_saved_consoles_sched_due"
  ON "saved_consoles" ("scheduled_run_next_at")
  WHERE "schedule_cron" IS NOT NULL
    AND "schedule_cron" <> ''
    AND "scheduled_run_next_at" IS NOT NULL
    AND "is_deleted" = false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_saved_consoles_ws_ext_used"
  ON "saved_consoles" ("workspace_id", "last_external_used_at")
  WHERE "last_external_used_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_saved_consoles_embedding_hnsw"
  ON "saved_consoles" USING hnsw ("description_embedding" vector_cosine_ops)
  WHERE "description_embedding" IS NOT NULL AND "is_deleted" = false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_saved_consoles_search_tsv"
  ON "saved_consoles" USING gin ("search_tsv");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_saved_consoles_name_trgm"
  ON "saved_consoles" USING gin ("name" gin_trgm_ops)
  WHERE "is_deleted" = false;
--> statement-breakpoint

-- 3. entity_versions (Mongo: entity_versions — immutable append-only console snapshots)
CREATE TABLE IF NOT EXISTS "entity_versions" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL CHECK ("entity_type" = 'console'),
  "entity_id" uuid NOT NULL,
  "version" integer NOT NULL CHECK ("version" >= 1),
  "snapshot" jsonb NOT NULL,
  "saved_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "saved_by_name" text NOT NULL,
  "comment" text NOT NULL DEFAULT '',
  "restored_from" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "entity_versions_entity_type_ver_unique" UNIQUE ("entity_id", "entity_type", "version")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entity_versions_entity_ver"
  ON "entity_versions" ("entity_id", "version" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entity_versions_ws_type_at"
  ON "entity_versions" ("workspace_id", "entity_type", "created_at" DESC);
--> statement-breakpoint

-- 4. notebook_folders (Mongo: notebookfolders)
CREATE TABLE IF NOT EXISTS "notebook_folders" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "parent_id" uuid REFERENCES "notebook_folders"("id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  "owner_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "access" text NOT NULL DEFAULT 'private'
    CHECK ("access" IN ('private', 'workspace')),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notebook_folders_ws_parent"
  ON "notebook_folders" ("workspace_id", "parent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notebook_folders_ws_access"
  ON "notebook_folders" ("workspace_id", "access");
--> statement-breakpoint

-- 5. notebook_indexes (Mongo: notebookindexes)
CREATE TABLE IF NOT EXISTS "notebook_indexes" (
  "id" uuid PRIMARY KEY,
  "notebook_id" text NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "folder_id" uuid REFERENCES "notebook_folders"("id") ON DELETE SET NULL,
  "owner_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "access" text NOT NULL DEFAULT 'private'
    CHECK ("access" IN ('private', 'workspace')),
  "path" text,
  "checkpoint_blob_sha" text,
  "workspace_role" text NOT NULL DEFAULT 'viewer'
    CHECK ("workspace_role" IN ('viewer', 'editor')),
  "shared_with" jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof("shared_with") = 'array'),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "notebook_indexes_ws_nb_unique" UNIQUE ("workspace_id", "notebook_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notebook_indexes_ws_folder"
  ON "notebook_indexes" ("workspace_id", "folder_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notebook_indexes_ws_access_owner"
  ON "notebook_indexes" ("workspace_id", "access", "owner_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notebook_indexes_shared_with_gin"
  ON "notebook_indexes" USING gin ("shared_with" jsonb_path_ops);
--> statement-breakpoint

-- 6. favourites (Mongo: favourites — self-referential per-user bookmark tree)
CREATE TABLE IF NOT EXISTS "favourites" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "parent_id" uuid REFERENCES "favourites"("id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  "type" text NOT NULL CHECK ("type" IN ('folder', 'item')),
  "title" text,
  "kind" text CHECK ("kind" IS NULL OR "kind" IN ('app', 'console', 'notebook')),
  "ref_id" text,
  "position" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "favourites_type_fields_check" CHECK (
    ("type" = 'folder' AND "kind" IS NULL AND "ref_id" IS NULL) OR
    ("type" = 'item' AND "kind" IS NOT NULL AND "ref_id" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_favourites_tree_order"
  ON "favourites" ("workspace_id", "user_id", "parent_id", "position", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_favourites_item_unique"
  ON "favourites" ("workspace_id", "user_id", "kind", "ref_id")
  WHERE "type" = 'item';
--> statement-breakpoint

-- 7. scheduled_query_runs (Mongo: scheduled_query_runs — 90d sparse TTL on completed_at)
CREATE TABLE IF NOT EXISTS "scheduled_query_runs" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  -- Soft ref (no FK cascade): preserves run history across workspace repo disconnect/reconnect
  -- when saved_consoles rows are purged and later re-created with deterministic derived IDs.
  "console_id" uuid NOT NULL,
  "triggered_at" timestamptz NOT NULL DEFAULT now(),
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "status" text NOT NULL CHECK ("status" IN ('queued', 'running', 'success', 'error')),
  "trigger_type" text NOT NULL CHECK ("trigger_type" IN ('schedule', 'manual')),
  "triggered_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "duration_ms" integer,
  "rows_affected" bigint,
  "row_count" bigint,
  "error_message" text,
  "error_code" text,
  "inngest_run_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scheduled_query_runs_ws_console_triggered"
  ON "scheduled_query_runs" ("workspace_id", "console_id", "triggered_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scheduled_query_runs_completed_at"
  ON "scheduled_query_runs" ("completed_at")
  WHERE "completed_at" IS NOT NULL;
