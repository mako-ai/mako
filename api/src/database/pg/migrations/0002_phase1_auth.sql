-- Phase 1A: Auth domain tables (Decision #3: UUIDv7 users.id + legacy_id, SHA-256 token_hash sessions)

CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY,
  "legacy_id" text UNIQUE,
  "email" text NOT NULL UNIQUE
    CONSTRAINT "users_email_normalized_check" CHECK (
      "email" = lower(btrim("email")) AND length("email") > 0
    ),
  "name" text,
  "hashed_password" text,
  "email_verified" boolean NOT NULL DEFAULT false,
  "onboarding_completed_at" timestamptz,
  "onboarding_company_size" text
    CONSTRAINT "users_onboarding_company_size_check" CHECK (
      "onboarding_company_size" IS NULL
      OR "onboarding_company_size" IN ('hobby', 'startup', 'growth', 'enterprise')
    ),
  "onboarding_role" text,
  "onboarding_primary_database" text,
  "onboarding_data_warehouse" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_attributions" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "sid" text,
  "gclid" text,
  "signup_method" text NOT NULL
    CONSTRAINT "user_attributions_signup_method_check" CHECK (
      "signup_method" IN ('email', 'google', 'github')
    ),
  "country" text,
  "first_touch" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_touch" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "captured_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_attributions_gclid"
  ON "user_attributions" ("gclid")
  WHERE "gclid" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_accounts" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider" text NOT NULL
    CONSTRAINT "oauth_accounts_provider_check" CHECK (
      "provider" IN ('google', 'github')
    ),
  "provider_user_id" text NOT NULL,
  "email" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_oauth_accounts_provider_uid"
  ON "oauth_accounts" ("provider", "provider_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_oauth_accounts_user_id"
  ON "oauth_accounts" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
  "token_hash" text PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "expires_at" timestamptz NOT NULL,
  "active_workspace_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sessions_user_id"
  ON "sessions" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sessions_expires_at"
  ON "sessions" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_verifications" (
  "id" text PRIMARY KEY,
  "email" text NOT NULL
    CONSTRAINT "email_verifications_email_normalized_check" CHECK (
      "email" = lower(btrim("email")) AND length("email") > 0
    ),
  "code" text NOT NULL,
  "type" text NOT NULL
    CONSTRAINT "email_verifications_type_check" CHECK (
      "type" IN ('registration', 'link_password', 'password_reset')
    ),
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_verifications_email_type"
  ON "email_verifications" ("email", "type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_verifications_expires_at"
  ON "email_verifications" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "desktop_auth_codes" (
  "id" text PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "challenge" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_desktop_auth_codes_expires_at"
  ON "desktop_auth_codes" ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_desktop_auth_codes_user_id"
  ON "desktop_auth_codes" ("user_id");
