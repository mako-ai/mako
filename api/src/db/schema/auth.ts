import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Identity & auth domain (was Mongo `users`, `sessions`, `oauthaccounts`,
 * `emailverifications`, `desktopauthcodes` in `database/schema.ts`).
 *
 * `users.id` keeps the existing UUID-v4 string identity (no conversion needed).
 * `sessions.id` is a 64-hex token, so it is `text`, not `uuid`.
 */

export interface UserOnboarding {
  completedAt?: string | null;
  companySize?: "hobby" | "startup" | "growth" | "enterprise" | null;
  role?: string | null;
  primaryDatabase?: string | null;
  dataWarehouse?: string | null;
}

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    hashedPassword: text("hashed_password"),
    emailVerified: boolean("email_verified").notNull().default(false),
    onboarding: jsonb("onboarding").$type<UserOnboarding>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [uniqueIndex("users_email_unique").on(table.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    activeWorkspaceId: uuid("active_workspace_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"google" | "github">().notNull(),
    providerUserId: text("provider_user_id").notNull(),
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    uniqueIndex("oauth_provider_user_unique").on(
      table.provider,
      table.providerUserId,
    ),
    index("oauth_user_id_idx").on(table.userId),
  ],
);

export const emailVerifications = pgTable(
  "email_verifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    code: text("code").notNull(),
    type: text("type")
      .$type<"registration" | "link_password" | "password_reset">()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    index("email_verifications_email_idx").on(table.email),
    index("email_verifications_expires_at_idx").on(table.expiresAt),
  ],
);

export const desktopAuthCodes = pgTable(
  "desktop_auth_codes",
  {
    // SHA-256 hash of the raw code (semantic key, not a uuid).
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
  table => [index("desktop_auth_codes_expires_at_idx").on(table.expiresAt)],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type OAuthAccountRow = typeof oauthAccounts.$inferSelect;
export type NewOAuthAccountRow = typeof oauthAccounts.$inferInsert;
export type EmailVerificationRow = typeof emailVerifications.$inferSelect;
export type NewEmailVerificationRow = typeof emailVerifications.$inferInsert;
export type DesktopAuthCodeRow = typeof desktopAuthCodes.$inferSelect;
export type NewDesktopAuthCodeRow = typeof desktopAuthCodes.$inferInsert;
