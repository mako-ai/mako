-- Phase 2B: apps_metadata (10 tables) + usage_stats (7 tables)
--   apps_metadata:
--     app_projects, app_index, app_index_heads, app_embeddings, app_lifecycle,
--     app_deploy_commit_statuses, app_worktrees, app_binding_state,
--     app_binding_drafts, app_binding_jobs
--   usage_stats:
--     app_usage_daily, app_usage_events, app_feed_snapshots, skill_usage_daily,
--     llm_usage, query_executions, connection_verifications
--
-- Depends on 0002_phase1_auth (`users.id` uuid UUIDv7) and
-- 0003_phase1_workspaces (`workspaces`, `workspace_api_keys`).
-- Deferred post-backfill FK: `post-backfill/0006a_conn_verif_connection_fk.sql`
-- attaches `connection_verifications.connection_id -> database_connections(id)`
-- once `connections` backfill completes.

CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- Sub-Domain: apps_metadata (10 tables)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "app_projects" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "slug" text,
  "path" text,
  "description" text,
  "access" text NOT NULL DEFAULT 'private'
    CONSTRAINT "app_projects_access_check" CHECK ("access" IN ('private', 'workspace')),
  "workspace_role" text
    CONSTRAINT "app_projects_workspace_role_check" CHECK (
      "workspace_role" IS NULL OR "workspace_role" IN ('viewer', 'editor')
    ),
  "shared_with" jsonb
    CONSTRAINT "app_projects_shared_with_array_check" CHECK (
      "shared_with" IS NULL OR jsonb_typeof("shared_with") = 'array'
    ),
  "owner_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "default_branch" text NOT NULL DEFAULT 'main',
  "cloud_repo_owner" text,
  "cloud_repo_name" text,
  "published_sha" text,
  "chat_enabled" boolean,
  "published_at" timestamptz,
  "last_deploy_error" jsonb,
  "binding_refresh_errors" jsonb,
  "deploy_progress" jsonb,
  "public_share_enabled" boolean NOT NULL DEFAULT false,
  "public_share_token" text,
  "public_share_password_hash" text,
  "public_share_password_encrypted" text,
  "public_share_created_at" timestamptz,
  "public_share_created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "public_share_allow_live_queries" boolean NOT NULL DEFAULT false,
  "env" jsonb
    CONSTRAINT "app_projects_env_array_check" CHECK (
      "env" IS NULL OR jsonb_typeof("env") = 'array'
    ),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_projects_ws_updated"
  ON "app_projects" ("workspace_id", "updated_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_projects_owner"
  ON "app_projects" ("owner_id")
  WHERE "owner_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_projects_ws_slug"
  ON "app_projects" ("workspace_id", "slug")
  WHERE "slug" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_projects_shared_with_gin"
  ON "app_projects" USING gin ("shared_with" jsonb_path_ops)
  WHERE "shared_with" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_projects_share_tok"
  ON "app_projects" ("public_share_token")
  WHERE "public_share_token" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_projects_ws_path"
  ON "app_projects" ("workspace_id", "path")
  WHERE "path" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_projects_published"
  ON "app_projects" ("workspace_id")
  WHERE "published_sha" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_index" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "app_id" uuid NOT NULL,
  "path" text NOT NULL,
  "slug" text NOT NULL,
  "scope" text NOT NULL
    CONSTRAINT "app_index_scope_check" CHECK ("scope" IN ('workspace', 'private')),
  "owner_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "tree_oid" text NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "has_manifest_id" boolean NOT NULL DEFAULT false,
  "duplicate_of" uuid,
  "schedules" jsonb NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT "app_index_schedules_array_check" CHECK (jsonb_typeof("schedules") = 'array'),
  "tables" text[],
  "binding_tables" jsonb
    CONSTRAINT "app_index_binding_tables_array_check" CHECK (
      "binding_tables" IS NULL OR jsonb_typeof("binding_tables") = 'array'
    ),
  "bindings" text[],
  "author_email" text,
  "first_commit_at" timestamptz,
  "thumbnail" jsonb,
  "icon" jsonb,
  "indexed_sha" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_app_index_app_id"
  ON "app_index" ("app_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_app_index_ws_path"
  ON "app_index" ("workspace_id", "path");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_index_ws_app"
  ON "app_index" ("workspace_id", "app_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_index_ws_slug"
  ON "app_index" ("workspace_id", "slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_index_slug_scope"
  ON "app_index" ("slug", "scope");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_index_heads" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "sha" text NOT NULL,
  "schema_version" integer,
  "folders" text[] NOT NULL DEFAULT '{}'::text[],
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_app_index_heads_ws"
  ON "app_index_heads" ("workspace_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_embeddings" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "app_id" uuid NOT NULL,
  "path" text NOT NULL,
  "tree_oid" text NOT NULL,
  "doc_hash" text NOT NULL,
  "embedding_model" text NOT NULL,
  "vector" vector(1536) NOT NULL,
  "terms" text[],
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_app_embeddings_ws_app"
  ON "app_embeddings" ("workspace_id", "app_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_lifecycle" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "app_id" uuid NOT NULL,
  "verified_at" timestamptz,
  "verified_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "stale_since" timestamptz,
  "stale_notified_to" text[],
  "schedules_paused_at" timestamptz,
  "archived_at" timestamptz,
  "archived_from" text,
  "archived_to" text,
  "restored_at" timestamptz,
  "restored_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_app_lifecycle_ws_app"
  ON "app_lifecycle" ("workspace_id", "app_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_lifecycle_paused"
  ON "app_lifecycle" ("schedules_paused_at")
  WHERE "schedules_paused_at" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_deploy_commit_statuses" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "app_id" uuid NOT NULL,
  "sha" text NOT NULL,
  "state" text NOT NULL
    CONSTRAINT "app_deploy_commit_statuses_state_check" CHECK (
      "state" IN ('pending', 'success', 'failure', 'superseded')
    ),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_app_deploy_commit_statuses_ws_app_sha"
  ON "app_deploy_commit_statuses" ("workspace_id", "app_id", "sha");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_deploy_commit_statuses_ws_app_state"
  ON "app_deploy_commit_statuses" ("workspace_id", "app_id", "state");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_worktrees" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "project_id" uuid,
  "actor_id" text NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "branch" text NOT NULL DEFAULT 'main',
  "last_activity_at" timestamptz,
  "active_until" timestamptz,
  "idle_paused_at" timestamptz[],
  "idle_pause_hold_until" timestamptz,
  "idle_pause_hold_set_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "app_worktrees_user_actor_check" CHECK (
    "user_id" IS NULL OR "actor_id" = "user_id"::text
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_app_worktrees_ws_actor"
  ON "app_worktrees" ("workspace_id", "actor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_worktrees_user"
  ON "app_worktrees" ("user_id")
  WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_worktrees_updated"
  ON "app_worktrees" ("updated_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_binding_state" (
  "id" uuid PRIMARY KEY,
  "project_id" uuid NOT NULL,
  "name" text NOT NULL,
  "last_materialized_at" timestamptz,
  "last_row_count" bigint,
  "public_refresh_at" timestamptz,
  "history" jsonb
    CONSTRAINT "app_binding_state_history_array_check" CHECK (
      "history" IS NULL OR jsonb_typeof("history") = 'array'
    ),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_app_binding_state_project_name"
  ON "app_binding_state" ("project_id", "name");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_binding_drafts" (
  "id" uuid PRIMARY KEY,
  "project_id" uuid NOT NULL,
  "hash" text NOT NULL,
  "kind" text NOT NULL
    CONSTRAINT "app_binding_drafts_kind_check" CHECK ("kind" IN ('build', 'failure')),
  "name" text NOT NULL,
  "key" text,
  "built_at" timestamptz,
  "row_count" bigint,
  "byte_size" bigint,
  "failures" integer,
  "until" timestamptz,
  "error" text,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_binding_drafts_lookup"
  ON "app_binding_drafts" ("project_id", "hash", "kind", "expires_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_binding_drafts_expires"
  ON "app_binding_drafts" ("project_id", "expires_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_binding_jobs" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL,
  "name" text NOT NULL,
  "kind" text
    CONSTRAINT "app_binding_jobs_kind_check" CHECK (
      "kind" IS NULL OR "kind" IN ('materialize', 'dev-build')
    ),
  "actor_id" text NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "can_write" boolean NOT NULL DEFAULT false,
  "unregistered" boolean,
  "request" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'queued'
    CONSTRAINT "app_binding_jobs_status_check" CHECK (
      "status" IN ('queued', 'running', 'ready', 'error')
    ),
  "result" jsonb,
  "error" text,
  "error_status" integer,
  "heartbeat_at" timestamptz,
  "progress" jsonb,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_binding_jobs_proj_exp"
  ON "app_binding_jobs" ("project_id", "expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_binding_jobs_status"
  ON "app_binding_jobs" ("status", "heartbeat_at");
--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- Sub-Domain: usage_stats (7 tables)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "app_usage_daily" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "app_id" uuid NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "anon_id" text,
  "visitor_key" text NOT NULL,
  "day" date NOT NULL,
  "opens" integer NOT NULL DEFAULT 0,
  "active_seconds" integer NOT NULL DEFAULT 0,
  "sources_app" integer NOT NULL DEFAULT 0,
  "sources_share" integer NOT NULL DEFAULT 0,
  "sources_embed" integer NOT NULL DEFAULT 0,
  "first_at" timestamptz NOT NULL,
  "last_at" timestamptz NOT NULL,
  CONSTRAINT "app_usage_daily_viewer_exclusive" CHECK (
    NOT ("user_id" IS NOT NULL AND "anon_id" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_app_usage_daily_key"
  ON "app_usage_daily" ("workspace_id", "app_id", "visitor_key", "day");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_usage_daily_ws_day"
  ON "app_usage_daily" ("workspace_id", "day");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_usage_daily_ws_user_last"
  ON "app_usage_daily" ("workspace_id", "user_id", "last_at" DESC)
  WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_usage_daily_last_at"
  ON "app_usage_daily" ("last_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_usage_events" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "app_id" uuid NOT NULL,
  "at" timestamptz NOT NULL,
  "kind" text NOT NULL
    CONSTRAINT "app_usage_events_kind_check" CHECK ("kind" IN ('open', 'heartbeat')),
  "source" text NOT NULL
    CONSTRAINT "app_usage_events_source_check" CHECK ("source" IN ('app', 'share', 'embed')),
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "anon_id" text,
  "session_id" text,
  "referrer_kind" text
    CONSTRAINT "app_usage_events_referrer_kind_check" CHECK (
      "referrer_kind" IS NULL OR "referrer_kind" IN ('internal', 'external', 'direct')
    ),
  "ua_class" text NOT NULL
    CONSTRAINT "app_usage_events_ua_class_check" CHECK (
      "ua_class" IN ('desktop', 'mobile', 'bot', 'unknown')
    ),
  "throttled" boolean,
  "placement" jsonb,
  "backfill" text
    CONSTRAINT "app_usage_events_backfill_check" CHECK (
      "backfill" IS NULL OR "backfill" IN ('cloud-run', 'posthog')
    ),
  CONSTRAINT "app_usage_events_viewer_exclusive" CHECK (
    NOT ("user_id" IS NOT NULL AND "anon_id" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_usage_events_ws_app_at"
  ON "app_usage_events" ("workspace_id", "app_id", "at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_usage_events_ws_user_at"
  ON "app_usage_events" ("workspace_id", "user_id", "at")
  WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_usage_events_at"
  ON "app_usage_events" ("at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_feed_snapshots" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "popular" text[] NOT NULL DEFAULT '{}'::text[],
  "fresh" text[] NOT NULL DEFAULT '{}'::text[],
  "recommended" text[] NOT NULL DEFAULT '{}'::text[],
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_app_feed_snapshots_created"
  ON "app_feed_snapshots" ("created_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "skill_usage_daily" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "scope" text NOT NULL
    CONSTRAINT "skill_usage_daily_scope_check" CHECK ("scope" IN ('workspace', 'system')),
  "skill" text NOT NULL,
  "source" text NOT NULL
    CONSTRAINT "skill_usage_daily_source_check" CHECK ("source" IN ('agent', 'mcp')),
  "day" date NOT NULL,
  "loads" integer NOT NULL DEFAULT 0,
  "resource_reads" integer NOT NULL DEFAULT 0,
  "relevant_hits" integer NOT NULL DEFAULT 0,
  "first_at" timestamptz NOT NULL,
  "last_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_skill_usage_daily_key"
  ON "skill_usage_daily" ("workspace_id", "scope", "skill", "source", "day");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_usage_daily_ws_day"
  ON "skill_usage_daily" ("workspace_id", "day");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_usage_daily_last_at"
  ON "skill_usage_daily" ("last_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "llm_usage" (
  "id" uuid PRIMARY KEY,
  -- Soft UUID ref (NO FK): permanent billing ledger survives workspace deletion, matching Mongo.
  "workspace_id" uuid NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "chat_id" uuid,
  "invocation_type" text NOT NULL
    CONSTRAINT "llm_usage_invocation_type_check" CHECK (
      "invocation_type" IN (
        'chat', 'title_generation', 'description_generation',
        'embedding', 'version_comment', 'workflow', 'commit_message'
      )
    ),
  "model_id" text NOT NULL,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "cache_read_tokens" integer NOT NULL DEFAULT 0,
  "cache_write_tokens" integer NOT NULL DEFAULT 0,
  "reasoning_tokens" integer NOT NULL DEFAULT 0,
  "total_tokens" integer NOT NULL DEFAULT 0,
  "cost_usd" numeric(14, 8) NOT NULL DEFAULT 0,
  "steps" jsonb
    CONSTRAINT "llm_usage_steps_array_check" CHECK (
      "steps" IS NULL OR jsonb_typeof("steps") = 'array'
    ),
  "agent_id" text,
  "tags" text[],
  "duration_ms" integer,
  "workflow_id" text,
  "workflow_run_id" text,
  "workflow_step" text,
  "workflow_backfilled" boolean,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_ws_created"
  ON "llm_usage" ("workspace_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_ws_user_at"
  ON "llm_usage" ("workspace_id", "user_id", "created_at" DESC)
  WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_user_at"
  ON "llm_usage" ("user_id", "created_at" DESC)
  WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_chat_id"
  ON "llm_usage" ("chat_id")
  WHERE "chat_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_ws_wf_run"
  ON "llm_usage" ("workspace_id", "workflow_run_id")
  WHERE "workflow_run_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_ws_wf_created"
  ON "llm_usage" ("workspace_id", "workflow_id", "created_at" DESC)
  WHERE "workflow_id" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "query_executions" (
  "id" uuid PRIMARY KEY,
  "executed_at" timestamptz NOT NULL DEFAULT now(),
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "api_key_id" uuid REFERENCES "workspace_api_keys"("id") ON DELETE SET NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL,
  "database_name" text,
  "console_id" uuid,
  "source" text NOT NULL
    CONSTRAINT "query_executions_source_check" CHECK (
      "source" IN (
        'console_ui', 'console_ui_admin_override', 'api',
        'mcp', 'agent', 'flow', 'scheduled_query'
      )
    ),
  "database_type" text NOT NULL,
  "query_language" text NOT NULL
    CONSTRAINT "query_executions_query_language_check" CHECK (
      "query_language" IN ('sql', 'mongodb', 'javascript')
    ),
  "status" text NOT NULL
    CONSTRAINT "query_executions_status_check" CHECK (
      "status" IN ('success', 'error', 'cancelled', 'timeout')
    ),
  "execution_time_ms" integer NOT NULL,
  "row_count" integer,
  "error_type" text,
  "bytes_scanned" bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_query_exec_ws_at"
  ON "query_executions" ("workspace_id", "executed_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_query_exec_user_at"
  ON "query_executions" ("user_id", "executed_at" DESC)
  WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_query_exec_apikey_at"
  ON "query_executions" ("api_key_id", "executed_at" DESC)
  WHERE "api_key_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_query_exec_ws_status"
  ON "query_executions" ("workspace_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_query_exec_ws_console_at"
  ON "query_executions" ("workspace_id", "console_id", "executed_at" DESC)
  WHERE "console_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_query_exec_executed_at"
  ON "query_executions" ("executed_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "connection_verifications" (
  "id" uuid PRIMARY KEY,
  "verified_at" timestamptz NOT NULL DEFAULT now(),
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE SET NULL,
  "connection_id" uuid,
  "database_type" text NOT NULL,
  "trigger" text NOT NULL
    CONSTRAINT "connection_verifications_trigger_check" CHECK (
      "trigger" IN ('standalone_test', 'create_verify', 'update_verify', 'saved_test')
    ),
  "success" boolean NOT NULL,
  "duration_ms" integer NOT NULL,
  "error_class" text,
  "error_message" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_conn_verif_ws_at"
  ON "connection_verifications" ("workspace_id", "verified_at" DESC)
  WHERE "workspace_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_conn_verif_user_at"
  ON "connection_verifications" ("user_id", "verified_at" DESC)
  WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_conn_verif_fail_rollup"
  ON "connection_verifications" ("success", "error_class", "verified_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_conn_verif_verified_at"
  ON "connection_verifications" ("verified_at");
