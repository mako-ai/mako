-- Phase 3 (Part 1): MCP domain tables (4 tables)
--   mcp_servers, mcp_connection_configs, mcp_oauth_flows, mcp_tool_grants
--
-- Depends on 0002_phase1_auth (`users.id` uuid UUIDv7) and 0003_phase1_workspaces (`workspaces.id` uuid).
-- Key Decision #3 adaptation:
--   MongoDB uses `userId: ""` / `configUserId: ""` as a sentinel for workspace-shared credentials;
--   Postgres uses `user_id IS NULL` / `config_user_id IS NULL` with `UNIQUE NULLS NOT DISTINCT`.
-- Encrypted columns (`oauth_client_information_encrypted`, `headers_encrypted`,
-- `oauth_tokens_encrypted`, `code_verifier_encrypted`) store opaque ciphertext verbatim.

CREATE TABLE IF NOT EXISTS "mcp_servers" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL
    CONSTRAINT "mcp_servers_name_len_check" CHECK (char_length("name") <= 100),
  "description" text
    CONSTRAINT "mcp_servers_description_len_check" CHECK (
      "description" IS NULL OR char_length("description") <= 500
    ),
  "connector_type" text NOT NULL DEFAULT 'custom',
  "transport_type" text NOT NULL DEFAULT 'http'
    CONSTRAINT "mcp_servers_transport_type_check" CHECK ("transport_type" IN ('http')),
  "transport_url" text NOT NULL,
  "auth_type" text NOT NULL DEFAULT 'api_key'
    CONSTRAINT "mcp_servers_auth_type_check" CHECK ("auth_type" IN ('none', 'api_key', 'oauth')),
  "auth_performer" text NOT NULL DEFAULT 'workspace'
    CONSTRAINT "mcp_servers_auth_performer_check" CHECK ("auth_performer" IN ('workspace', 'user')),
  "write_scope" text NOT NULL DEFAULT 'read'
    CONSTRAINT "mcp_servers_write_scope_check" CHECK ("write_scope" IN ('read', 'write_safe', 'write_destructive')),
  "tool_policy_default_restriction" text NOT NULL DEFAULT 'always'
    CONSTRAINT "mcp_servers_tool_policy_default_check" CHECK (
      "tool_policy_default_restriction" IN ('always', 'ask', 'block')
    ),
  "tool_policy_restrictions" jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT "mcp_servers_tool_policy_restrictions_check" CHECK (
      jsonb_typeof("tool_policy_restrictions") = 'object'
    ),
  "cached_tools" jsonb NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT "mcp_servers_cached_tools_check" CHECK (
      jsonb_typeof("cached_tools") = 'array'
    ),
  "oauth_client_information_encrypted" text,
  "status" text NOT NULL DEFAULT 'created'
    CONSTRAINT "mcp_servers_status_check" CHECK (
      "status" IN ('created', 'awaiting_auth', 'connected', 'error')
    ),
  "last_error" text,
  "last_connected_at" timestamptz,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "mcp_servers_ws_name_unique" UNIQUE ("workspace_id", "name")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_servers_ws_active"
  ON "mcp_servers" ("workspace_id", "is_active");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_connection_configs" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "server_id" uuid NOT NULL REFERENCES "mcp_servers"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "headers_encrypted" jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT "mcp_connection_configs_headers_check" CHECK (
      jsonb_typeof("headers_encrypted") = 'object'
    ),
  "oauth_tokens_encrypted" text,
  "oauth_expires_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "mcp_connection_configs_server_user_unique" UNIQUE NULLS NOT DISTINCT ("server_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_conn_configs_ws"
  ON "mcp_connection_configs" ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_conn_configs_user"
  ON "mcp_connection_configs" ("user_id")
  WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_flows" (
  "id" uuid PRIMARY KEY,
  "state" text NOT NULL CONSTRAINT "mcp_oauth_flows_state_unique" UNIQUE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "server_id" uuid NOT NULL REFERENCES "mcp_servers"("id") ON DELETE CASCADE,
  "config_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "started_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "code_verifier_encrypted" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_oauth_flows_created_at"
  ON "mcp_oauth_flows" ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_tool_grants" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "server_id" uuid NOT NULL REFERENCES "mcp_servers"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "tool_name" text NOT NULL,
  "decision" text NOT NULL
    CONSTRAINT "mcp_tool_grants_decision_check" CHECK (
      "decision" IN ('always_allow', 'always_deny')
    ),
  "last_used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "mcp_tool_grants_server_user_tool_unique" UNIQUE ("server_id", "user_id", "tool_name")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_tool_grants_ws_user"
  ON "mcp_tool_grants" ("workspace_id", "user_id");
