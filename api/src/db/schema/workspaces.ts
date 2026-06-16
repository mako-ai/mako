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

import { users } from "./auth";

/**
 * Tenancy domain (was Mongo `workspaces`, `workspacemembers`,
 * `workspaceinvites`, plus the embedded `workspace.apiKeys[]` array which is
 * normalized here into its own `workspace_api_keys` table).
 *
 * Mongo `_id` ObjectIds map to uuids via `objectIdToUuid`. User references
 * (`created_by`, `user_id`, `invited_by`) carry the existing user uuid.
 */

export interface WorkspaceSettings {
  maxDatabases?: number;
  maxMembers?: number;
  billingTier?: string;
  customPrompt?: string;
  disabledModelIds?: string[];
}

export interface WorkspaceBilling {
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  subscriptionStatus?: string | null;
  plan?: string | null;
  usageQuotaUsd?: number | null;
  hardLimitUsd?: number | null;
  [key: string]: unknown;
}

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    // `created_by` is a mapped user uuid but intentionally has no FK: legacy
    // data may attribute creation to deleted users or sentinels (system/agent).
    createdBy: uuid("created_by").notNull(),
    settings: jsonb("settings").$type<WorkspaceSettings>(),
    billing: jsonb("billing").$type<WorkspaceBilling>(),
    selfDirective: text("self_directive").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    uniqueIndex("workspaces_slug_unique").on(table.slug),
    index("workspaces_created_by_idx").on(table.createdBy),
  ],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role")
      .$type<"owner" | "admin" | "member" | "viewer">()
      .notNull(),
    isDefaultMembership: boolean("is_default_membership"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    uniqueIndex("workspace_members_unique").on(table.workspaceId, table.userId),
    index("workspace_members_user_idx").on(table.userId),
  ],
);

export const workspaceInvites = pgTable(
  "workspace_invites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    token: text("token").notNull(),
    role: text("role").$type<"admin" | "member" | "viewer">().notNull(),
    invitedBy: uuid("invited_by").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    uniqueIndex("workspace_invites_token_unique").on(table.token),
    index("workspace_invites_workspace_idx").on(table.workspaceId),
  ],
);

export const workspaceApiKeys = pgTable(
  "workspace_api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    prefix: text("prefix").notNull(),
    createdBy: uuid("created_by"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    uniqueIndex("workspace_api_keys_hash_unique").on(table.keyHash),
    index("workspace_api_keys_workspace_idx").on(table.workspaceId),
  ],
);

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type NewWorkspaceRow = typeof workspaces.$inferInsert;
export type WorkspaceMemberRow = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMemberRow = typeof workspaceMembers.$inferInsert;
export type WorkspaceInviteRow = typeof workspaceInvites.$inferSelect;
export type NewWorkspaceInviteRow = typeof workspaceInvites.$inferInsert;
export type WorkspaceApiKeyRow = typeof workspaceApiKeys.$inferSelect;
export type NewWorkspaceApiKeyRow = typeof workspaceApiKeys.$inferInsert;
