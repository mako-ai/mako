-- Phase 2A-1: connections domain tables (5 tables)
--   database_connections, source_connections, connection_access_events,
--   connection_write_events, connector_definitions
--
-- Depends on 0002_phase1_auth (`users.id` uuid UUIDv7) and
-- 0003_phase1_workspaces (`workspaces.id` uuid UUIDv8).
-- All ObjectId PKs/FKs use bijective RFC 9562 UUIDv8 so Mongo-resident flows,
-- CDC, webhooks, and connector_boxes continue referencing canonical 24-hex IDs.
-- All user columns are native `uuid REFERENCES users(id) ON DELETE SET NULL`.

CREATE TABLE IF NOT EXISTS "database_connections" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "type" text NOT NULL
    CONSTRAINT "database_connections_type_check" CHECK (
      "type" IN (
        'mongodb',
        'postgresql',
        'redshift',
        'cloudsql-postgres',
        'mysql',
        'sqlite',
        'mssql',
        'bigquery',
        'clickhouse',
        'cloudflare-d1',
        'cloudflare-kv'
      )
    ),
  "connection_encrypted" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "is_demo" boolean NOT NULL DEFAULT false,
  "allow_agent_writes" boolean NOT NULL DEFAULT false,
  "writers" jsonb,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "last_connected_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_database_connections_ws_created"
  ON "database_connections" ("workspace_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_database_connections_ws_name"
  ON "database_connections" ("workspace_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_database_connections_ws_demo"
  ON "database_connections" ("workspace_id")
  WHERE "is_demo" = true;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_connections" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "type" text NOT NULL,
  "description" text,
  "config_encrypted" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "settings" jsonb NOT NULL DEFAULT '{"sync_batch_size":100,"rate_limit_delay_ms":200}'::jsonb,
  "target_database_ids" uuid[] NOT NULL DEFAULT '{}'::uuid[],
  "writers" jsonb,
  "live_reads" boolean NOT NULL DEFAULT false,
  "live_readers" jsonb,
  "managers" uuid[],
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "last_synced_at" timestamptz,
  "is_active" boolean NOT NULL DEFAULT true,
  "key_request_token_hash" text,
  "key_request_expires_at" timestamptz,
  "key_request_fields" text[],
  "key_request_requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "key_request_created_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_source_connections_key_request_atomic" CHECK (
    (
      "key_request_token_hash" IS NULL
      AND "key_request_expires_at" IS NULL
      AND "key_request_fields" IS NULL
      AND "key_request_created_at" IS NULL
    )
    OR (
      "key_request_token_hash" IS NOT NULL
      AND "key_request_expires_at" IS NOT NULL
      AND "key_request_fields" IS NOT NULL
      AND "key_request_created_at" IS NOT NULL
    )
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_source_connections_ws_created"
  ON "source_connections" ("workspace_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_source_connections_ws_type"
  ON "source_connections" ("workspace_id", "type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_source_connections_ws_name"
  ON "source_connections" ("workspace_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_source_connections_active_type"
  ON "source_connections" ("type")
  WHERE "is_active" = true;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_source_connections_key_request_token"
  ON "source_connections" ("workspace_id", "key_request_token_hash")
  WHERE "key_request_token_hash" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connection_access_events" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL,
  "kind" text NOT NULL
    CONSTRAINT "connection_access_events_kind_check" CHECK (
      "kind" IN ('database', 'source')
    ),
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "actor_raw" text,
  "via" text NOT NULL
    CONSTRAINT "connection_access_events_via_check" CHECK (
      "via" IN ('app', 'mcp', 'api')
    ),
  "changes" jsonb NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_connection_access_events_ws_conn_at"
  ON "connection_access_events" ("workspace_id", "connection_id", "at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connection_write_events" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL,
  "principal" text NOT NULL,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "target" text,
  "allowed" boolean NOT NULL,
  "status" integer,
  "error" text,
  "at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_connection_write_events_ws_conn_at"
  ON "connection_write_events" ("workspace_id", "connection_id", "at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_connection_write_events_conn_at"
  ON "connection_write_events" ("connection_id", "at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_connection_write_events_at"
  ON "connection_write_events" ("at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_definitions" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "runtime" text NOT NULL DEFAULT 'node',
  "entry" text NOT NULL DEFAULT 'connector.ts',
  "sha" text NOT NULL,
  "source_sha" text NOT NULL,
  "spec" jsonb,
  "status" text NOT NULL DEFAULT 'indexed'
    CONSTRAINT "connector_definitions_status_check" CHECK (
      "status" IN ('indexed', 'verified', 'blocked', 'retrying')
    ),
  "blocked_reason" text,
  "index_retry_attempts" integer,
  "next_index_retry_at" timestamptz,
  "entities" text[] NOT NULL DEFAULT '{}'::text[],
  "has_icon" boolean NOT NULL DEFAULT false,
  "last_checked_at" timestamptz,
  "last_check_error" text,
  "build" jsonb,
  "registry" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_connector_definitions_ws_slug"
  ON "connector_definitions" ("workspace_id", "slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_connector_definitions_retrying_due"
  ON "connector_definitions" ("next_index_retry_at")
  WHERE "status" = 'retrying';
