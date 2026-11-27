/**
 * Phase 1A (`auth` domain) platform Postgres Drizzle schema (Decision #3).
 *
 * Covers the 6 global authentication tables:
 *   - `users`               (UUIDv7 `id` PK + `legacy_id` text UNIQUE for backfill & rewriting)
 *   - `user_attributions`   (1:1 write-once signup attribution, `user_id` uuid PK/FK)
 *   - `oauth_accounts`      (bijective ObjectId -> UUIDv8 PK, `user_id` uuid FK)
 *   - `sessions`            (SHA-256 `token_hash` PK, starts EMPTY in PG — never backfilled)
 *   - `email_verifications` (UUIDv4 text PK)
 *   - `desktop_auth_codes`  (SHA-256 base64url text PK, `user_id` uuid FK)
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const ONBOARDING_COMPANY_SIZES = [
  "hobby",
  "startup",
  "growth",
  "enterprise",
] as const;

export type OnboardingCompanySize = (typeof ONBOARDING_COMPANY_SIZES)[number];

export const SIGNUP_METHODS = ["email", "google", "github"] as const;
export type SignupMethod = (typeof SIGNUP_METHODS)[number];

export const OAUTH_PROVIDERS = ["google", "github"] as const;
export type OAuthProviderName = (typeof OAUTH_PROVIDERS)[number];

export const EMAIL_VERIFICATION_TYPES = [
  "registration",
  "link_password",
  "password_reset",
] as const;
export type EmailVerificationType = (typeof EMAIL_VERIFICATION_TYPES)[number];

export const users = pgTable(
  "users",
  {
    /** Canonical RFC 9562 UUIDv7 user identifier. */
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    /** Original Mongo `_id` (15-char Lucia ID, old UUIDv4, or matching UUIDv7). */
    legacyId: text("legacy_id").unique(),
    email: text("email").notNull().unique(),
    /** Optional legacy display name carried by some Mongo user documents. */
    name: text("name"),
    hashedPassword: text("hashed_password"),
    emailVerified: boolean("email_verified").notNull().default(false),
    onboardingCompletedAt: timestamp("onboarding_completed_at", {
      withTimezone: true,
    }),
    onboardingCompanySize: text(
      "onboarding_company_size",
    ).$type<OnboardingCompanySize>(),
    onboardingRole: text("onboarding_role"),
    onboardingPrimaryDatabase: text("onboarding_primary_database"),
    onboardingDataWarehouse: text("onboarding_data_warehouse"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "users_email_normalized_check",
      sql`${table.email} = lower(btrim(${table.email})) AND length(${table.email}) > 0`,
    ),
    check(
      "users_onboarding_company_size_check",
      sql`${table.onboardingCompanySize} IS NULL OR ${table.onboardingCompanySize} IN ('hobby', 'startup', 'growth', 'enterprise')`,
    ),
  ],
);

export const userAttributions = pgTable(
  "user_attributions",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    sid: text("sid"),
    gclid: text("gclid"),
    signupMethod: text("signup_method").$type<SignupMethod>().notNull(),
    country: text("country"),
    firstTouch: jsonb("first_touch")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastTouch: jsonb("last_touch")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "user_attributions_signup_method_check",
      sql`${table.signupMethod} IN ('email', 'google', 'github')`,
    ),
    index("idx_user_attributions_gclid")
      .on(table.gclid)
      .where(sql`${table.gclid} IS NOT NULL`),
  ],
);

export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    /** Bijective ObjectId -> RFC 9562 UUIDv8 during dual-run; native UUID afterwards. */
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<OAuthProviderName>().notNull(),
    providerUserId: text("provider_user_id").notNull(),
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "oauth_accounts_provider_check",
      sql`${table.provider} IN ('google', 'github')`,
    ),
    uniqueIndex("uq_oauth_accounts_provider_uid").on(
      table.provider,
      table.providerUserId,
    ),
    index("idx_oauth_accounts_user_id").on(table.userId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 hex hash of the raw `auth_session` cookie token (raw token stays only in cookie). */
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Nullable workspace UUID; FK to `workspaces(id)` is deferred until Phase 1B post-backfill. */
    activeWorkspaceId: uuid("active_workspace_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    index("idx_sessions_user_id").on(table.userId),
    index("idx_sessions_expires_at").on(table.expiresAt),
  ],
);

export const emailVerifications = pgTable(
  "email_verifications",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    code: text("code").notNull(),
    type: text("type").$type<EmailVerificationType>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "email_verifications_email_normalized_check",
      sql`${table.email} = lower(btrim(${table.email})) AND length(${table.email}) > 0`,
    ),
    check(
      "email_verifications_type_check",
      sql`${table.type} IN ('registration', 'link_password', 'password_reset')`,
    ),
    index("idx_email_verifications_email_type").on(table.email, table.type),
    index("idx_email_verifications_expires_at").on(table.expiresAt),
  ],
);

export const desktopAuthCodes = pgTable(
  "desktop_auth_codes",
  {
    /** SHA-256 base64url hash of the one-time raw desktop auth code. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    challenge: text("challenge").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    index("idx_desktop_auth_codes_expires_at").on(table.expiresAt),
    index("idx_desktop_auth_codes_user_id").on(table.userId),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type UserAttributionRow = typeof userAttributions.$inferSelect;
export type NewUserAttributionRow = typeof userAttributions.$inferInsert;
export type OAuthAccountRow = typeof oauthAccounts.$inferSelect;
export type NewOAuthAccountRow = typeof oauthAccounts.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type EmailVerificationRow = typeof emailVerifications.$inferSelect;
export type NewEmailVerificationRow = typeof emailVerifications.$inferInsert;
export type DesktopAuthCodeRow = typeof desktopAuthCodes.$inferSelect;
export type NewDesktopAuthCodeRow = typeof desktopAuthCodes.$inferInsert;
