-- Phase 1B: workspaces_core + github_installations domain tables (10 tables)
--   workspaces, workspace_api_keys, workspace_members, workspace_invites,
--   workspace_user_handles, mcp_oauth_clients, mcp_oauth_codes,
--   mcp_oauth_tokens, acp_plan_grants, github_installations
--
-- Depends on 0002_phase1_auth (`users.id` uuid UUIDv7).
-- All user columns are native `uuid` referencing `users(id)`:
--   - Audit/creator & reserved-handle columns: nullable `ON DELETE SET NULL`.
--   - Grant-bearing columns (members, OAuth codes/tokens, ACP grants): `NOT NULL ON DELETE CASCADE`.
-- sessions.active_workspace_id -> workspaces(id) is attached by the deferred
-- post-backfill step (`post-backfill/0003a_sessions_workspace_fk.sql`), NOT here.

CREATE TABLE IF NOT EXISTS "workspaces" (
  "id" uuid PRIMARY KEY,
  "name" text NOT NULL,
  "slug" text NOT NULL
    CONSTRAINT "workspaces_slug_normalized_check" CHECK (
      "slug" = lower(btrim("slug")) AND length("slug") > 0
    ),
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "settings_max_databases" integer NOT NULL DEFAULT 5,
  "settings_max_members" integer NOT NULL DEFAULT 10,
  "settings_billing_tier" text NOT NULL DEFAULT 'free'
    CONSTRAINT "workspaces_settings_billing_tier_check" CHECK (
      "settings_billing_tier" IN ('free', 'pro', 'enterprise')
    ),
  "settings_disabled_model_ids" text[] NOT NULL DEFAULT '{}'::text[],
  "settings_auto_join" jsonb,
  "settings_link_previews" boolean,
  "billing_stripe_customer_id" text,
  "billing_stripe_subscription_id" text,
  "billing_subscription_status" text
    CONSTRAINT "workspaces_billing_subscription_status_check" CHECK (
      "billing_subscription_status" IS NULL
      OR "billing_subscription_status" IN (
        'active', 'past_due', 'canceled', 'trialing',
        'incomplete', 'incomplete_expired', 'unpaid', 'paused'
      )
    ),
  "billing_current_period_start" timestamptz,
  "billing_current_period_end" timestamptz,
  "billing_usage_quota_usd" double precision NOT NULL DEFAULT 5,
  "billing_hard_limit_usd" double precision DEFAULT 5,
  "billing_plan" text NOT NULL DEFAULT 'free'
    CONSTRAINT "workspaces_billing_plan_check" CHECK (
      "billing_plan" IN ('free', 'pro', 'enterprise')
    ),
  "billing_last_reported_overage_cents" integer NOT NULL DEFAULT 0,
  "billing_pending_reported_overage_cents" integer,
  "billing_pending_meter_event_idempotency_key" text,
  "workspace_repos" jsonb,
  "workflows_hatchet_token_encrypted" text,
  "workflows_live" jsonb,
  "workflows_active" text[],
  "workflows_webhooks_encrypted" jsonb,
  "workflows_last_needed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workspaces_slug"
  ON "workspaces" ("slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspaces_created_by"
  ON "workspaces" ("created_by")
  WHERE "created_by" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspaces_stripe_customer"
  ON "workspaces" ("billing_stripe_customer_id")
  WHERE "billing_stripe_customer_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspaces_stripe_subscription"
  ON "workspaces" ("billing_stripe_subscription_id")
  WHERE "billing_stripe_subscription_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspaces_workflows_live"
  ON "workspaces" ("id")
  WHERE "workflows_live" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_api_keys" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "key_hash" text NOT NULL,
  "prefix" text NOT NULL,
  "scopes" text[],
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "agent_run" boolean,
  "record_writes" boolean,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workspace_api_keys_key_hash"
  ON "workspace_api_keys" ("key_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_api_keys_ws_name"
  ON "workspace_api_keys" ("workspace_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_api_keys_ws_creator"
  ON "workspace_api_keys" ("workspace_id", "created_by")
  WHERE "created_by" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_members" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" text NOT NULL
    CONSTRAINT "workspace_members_role_check" CHECK (
      "role" IN ('owner', 'admin', 'member', 'viewer')
    ),
  "joined_at" timestamptz NOT NULL DEFAULT now(),
  "is_default_membership" boolean,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workspace_members_ws_user"
  ON "workspace_members" ("workspace_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_members_user"
  ON "workspace_members" ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workspace_members_default"
  ON "workspace_members" ("user_id")
  WHERE "is_default_membership" = true;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_invites" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "email" text NOT NULL
    CONSTRAINT "workspace_invites_email_normalized_check" CHECK (
      "email" = lower(btrim("email")) AND length("email") > 0
    ),
  "token" text NOT NULL,
  "role" text NOT NULL
    CONSTRAINT "workspace_invites_role_check" CHECK (
      "role" IN ('admin', 'member', 'viewer')
    ),
  "invited_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "expires_at" timestamptz NOT NULL,
  "accepted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workspace_invites_token"
  ON "workspace_invites" ("token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_invites_ws_email"
  ON "workspace_invites" ("workspace_id", "email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_invites_email_pending"
  ON "workspace_invites" ("email")
  WHERE "accepted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_invites_expires_at"
  ON "workspace_invites" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_user_handles" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "handle" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workspace_user_handles_ws_user"
  ON "workspace_user_handles" ("workspace_id", "user_id")
  WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workspace_user_handles_ws_handle"
  ON "workspace_user_handles" ("workspace_id", "handle");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_clients" (
  "id" uuid PRIMARY KEY,
  "client_id" text NOT NULL,
  "client_name" text,
  "redirect_uris" text[] NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_mcp_oauth_clients_client_id"
  ON "mcp_oauth_clients" ("client_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_codes" (
  "id" uuid PRIMARY KEY,
  "code_hash" text NOT NULL,
  "client_id" text NOT NULL REFERENCES "mcp_oauth_clients"("client_id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "redirect_uri" text NOT NULL,
  "code_challenge" text NOT NULL,
  "scopes" text[] NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_mcp_oauth_codes_code_hash"
  ON "mcp_oauth_codes" ("code_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_oauth_codes_expires_at"
  ON "mcp_oauth_codes" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_tokens" (
  "id" uuid PRIMARY KEY,
  "access_token_hash" text NOT NULL,
  "refresh_token_hash" text NOT NULL,
  "client_id" text NOT NULL REFERENCES "mcp_oauth_clients"("client_id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "agent_session_id" text,
  "scopes" text[] NOT NULL,
  "access_expires_at" timestamptz NOT NULL,
  "refresh_expires_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_mcp_oauth_tokens_access_hash"
  ON "mcp_oauth_tokens" ("access_token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_mcp_oauth_tokens_refresh_hash"
  ON "mcp_oauth_tokens" ("refresh_token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_oauth_tokens_ws_user"
  ON "mcp_oauth_tokens" ("workspace_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_oauth_tokens_agent_session"
  ON "mcp_oauth_tokens" ("agent_session_id")
  WHERE "agent_session_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_oauth_tokens_refresh_expires_at"
  ON "mcp_oauth_tokens" ("refresh_expires_at")
  WHERE "refresh_expires_at" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acp_plan_grants" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "agent_session_id" text NOT NULL,
  "plan_digest" text NOT NULL,
  "grants" text[] NOT NULL,
  "status" text NOT NULL
    CONSTRAINT "acp_plan_grants_status_check" CHECK (
      "status" IN ('approved', 'revoked')
    ),
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_acp_plan_grants_agent_session"
  ON "acp_plan_grants" ("agent_session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_acp_plan_grants_ws_user"
  ON "acp_plan_grants" ("workspace_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_acp_plan_grants_expires_at"
  ON "acp_plan_grants" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_installations" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "installation_id" bigint NOT NULL,
  "account_login" text NOT NULL,
  "account_type" text NOT NULL DEFAULT 'Organization'
    CONSTRAINT "github_installations_account_type_check" CHECK (
      "account_type" IN ('Organization', 'User')
    ),
  "repository_selection" text NOT NULL DEFAULT 'all'
    CONSTRAINT "github_installations_repo_selection_check" CHECK (
      "repository_selection" IN ('all', 'selected')
    ),
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_github_installations_ws_inst"
  ON "github_installations" ("workspace_id", "installation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_github_installations_inst_id"
  ON "github_installations" ("installation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_github_installations_ws_account"
  ON "github_installations" ("workspace_id", "account_login");
