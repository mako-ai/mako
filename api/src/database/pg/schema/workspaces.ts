/**
 * Phase 1B (`workspaces_core` + `github_installations`) platform Postgres Drizzle schema.
 *
 * Covers the 10 global workspace, access-control, and GitHub App tables:
 *   - `workspaces`             (Mongo `workspaces`; settings/billing/workflows flattened, `apiKeys[]` unpacked)
 *   - `workspace_api_keys`     (Mongo `workspaces.apiKeys[]`; preserves subdoc `_id` for `query_executions.api_key_id`)
 *   - `workspace_members`      (Mongo `workspacemembers`)
 *   - `workspace_invites`      (Mongo `workspaceinvites`)
 *   - `workspace_user_handles` (Mongo `workspace_user_handles`; reserved handles outlive deleted users)
 *   - `mcp_oauth_clients`      (Mongo `mcpoauthclients`)
 *   - `mcp_oauth_codes`        (Mongo `mcpoauthcodes`)
 *   - `mcp_oauth_tokens`       (Mongo `mcpoauthtokens`)
 *   - `acp_plan_grants`        (Mongo `acpplangrants`)
 *   - `github_installations`   (Mongo `github_installations`; workspace repos, Apps, and dbt)
 *
 * Conventions (rfcs/postgres-migration.md, Decision #1 & #3):
 *   - Every ObjectId PK/FK is a bijective RFC 9562 UUIDv8 (`objectIdToUuid` / `toWireId`).
 *   - Every user reference column is native `uuid` referencing `users(id)` (RFC 9562 UUIDv7):
 *       * Audit/creator columns (`workspaces.created_by`, `workspace_api_keys.created_by`,
 *         `workspace_invites.invited_by`, `github_installations.created_by`) and
 *         `workspace_user_handles.user_id` are nullable `ON DELETE SET NULL` so legacy
 *         `"system"`/deleted creators backfill cleanly and handles stay reserved if a user is deleted.
 *       * Grant-bearing columns (`workspace_members.user_id`, `mcp_oauth_codes.user_id`,
 *         `mcp_oauth_tokens.user_id`, `acp_plan_grants.user_id`) are `NOT NULL ON DELETE CASCADE`.
 *   - Optional Mongo fields keep `undefined` ↔ `NULL` fidelity (no coalescing to `[]`/`false`),
 *     most importantly `workspace_api_keys.scopes` (NULL = legacy unrestricted key).
 *   - USD amounts are `double precision` so JS `Number` round-trips losslessly.
 *   - Encrypted values (`workflows.hatchetToken`, `workflows.webhooks`) are copied
 *     verbatim as opaque AES `iv:ciphertext` strings — never decrypted by the mapper.
 *   - `sessions.active_workspace_id -> workspaces(id)` is attached AFTER the
 *     `workspaces_core` backfill (`post-backfill/0003a_sessions_workspace_fk.sql`),
 *     never inside `0003`.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

export const BILLING_TIERS = ["free", "pro", "enterprise"] as const;
export type BillingTier = (typeof BILLING_TIERS)[number];

export const BILLING_PLANS = ["free", "pro", "enterprise"] as const;
export type BillingPlan = (typeof BILLING_PLANS)[number];

export const SUBSCRIPTION_STATUSES = [
  "active",
  "past_due",
  "canceled",
  "trialing",
  "incomplete",
  "incomplete_expired",
  "unpaid",
  "paused",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const WORKSPACE_MEMBER_ROLES = [
  "owner",
  "admin",
  "member",
  "viewer",
] as const;
export type WorkspaceMemberRole = (typeof WORKSPACE_MEMBER_ROLES)[number];

export const WORKSPACE_INVITE_ROLES = ["admin", "member", "viewer"] as const;
export type WorkspaceInviteRole = (typeof WORKSPACE_INVITE_ROLES)[number];

export const ACP_PLAN_GRANT_STATUSES = ["approved", "revoked"] as const;
export type AcpPlanGrantStatus = (typeof ACP_PLAN_GRANT_STATUSES)[number];

export const GITHUB_ACCOUNT_TYPES = ["Organization", "User"] as const;
export type GitHubAccountType = (typeof GITHUB_ACCOUNT_TYPES)[number];

export const GITHUB_REPO_SELECTIONS = ["all", "selected"] as const;
export type GitHubRepoSelection = (typeof GITHUB_REPO_SELECTIONS)[number];

/** `settings.autoJoin` (apps.md §28). */
export interface WorkspaceAutoJoinJson {
  domains: string[];
  role: "member" | "viewer";
}

/** One `workspaceRepos[]` entry (legacy `appsRepo` is normalized into this array). */
export interface WorkspaceRepoBindingJson {
  provider: "github";
  installationId?: number;
  owner: string;
  repo: string;
  defaultBranch: string;
  subdirectory: string;
  linkedBy?: string;
  /** ISO-8601 string in JSONB; mapper converts to/from `Date`. */
  linkedAt?: string;
}

/** `workflows.live` slot. */
export interface WorkflowSlotJson {
  sha?: string;
  tree?: string;
  names?: string[];
  running?: { sha?: string };
  failed?: { sha?: string; error?: string };
}

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** Nullable UUIDv7 FK: NULL for legacy `"system"`/deleted creators. */
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),

    // settings.*
    settingsMaxDatabases: integer("settings_max_databases")
      .notNull()
      .default(5),
    settingsMaxMembers: integer("settings_max_members").notNull().default(10),
    settingsBillingTier: text("settings_billing_tier")
      .$type<BillingTier>()
      .notNull()
      .default("free"),
    settingsDisabledModelIds: text("settings_disabled_model_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    settingsAutoJoin:
      jsonb("settings_auto_join").$type<WorkspaceAutoJoinJson>(),
    /** Tri-state: NULL = default (enabled), false = disabled. */
    settingsLinkPreviews: boolean("settings_link_previews"),

    // billing.*
    billingStripeCustomerId: text("billing_stripe_customer_id"),
    billingStripeSubscriptionId: text("billing_stripe_subscription_id"),
    billingSubscriptionStatus: text(
      "billing_subscription_status",
    ).$type<SubscriptionStatus>(),
    billingCurrentPeriodStart: timestamp("billing_current_period_start", {
      withTimezone: true,
    }),
    billingCurrentPeriodEnd: timestamp("billing_current_period_end", {
      withTimezone: true,
    }),
    billingUsageQuotaUsd: doublePrecision("billing_usage_quota_usd")
      .notNull()
      .default(5),
    /** NULL = unlimited (explicit Mongo `null`), distinct from the default 5. */
    billingHardLimitUsd: doublePrecision("billing_hard_limit_usd").default(5),
    billingPlan: text("billing_plan")
      .$type<BillingPlan>()
      .notNull()
      .default("free"),
    billingLastReportedOverageCents: integer(
      "billing_last_reported_overage_cents",
    )
      .notNull()
      .default(0),
    /** 2-phase overage CAS claim (usage-reporting.ts). */
    billingPendingReportedOverageCents: integer(
      "billing_pending_reported_overage_cents",
    ),
    billingPendingMeterEventIdempotencyKey: text(
      "billing_pending_meter_event_idempotency_key",
    ),

    /** NULL = Mongo `workspaceRepos` undefined (and no legacy `appsRepo`). */
    workspaceRepos:
      jsonb("workspace_repos").$type<WorkspaceRepoBindingJson[]>(),

    // workflows.* (NULL columns = Mongo `workflows` subfield undefined)
    workflowsHatchetTokenEncrypted: text("workflows_hatchet_token_encrypted"),
    workflowsLive: jsonb("workflows_live").$type<WorkflowSlotJson>(),
    workflowsActive: text("workflows_active").array(),
    workflowsWebhooksEncrypted: jsonb("workflows_webhooks_encrypted").$type<
      Record<string, string>
    >(),
    workflowsLastNeededAt: timestamp("workflows_last_needed_at", {
      withTimezone: true,
    }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "workspaces_slug_normalized_check",
      sql`${table.slug} = lower(btrim(${table.slug})) AND length(${table.slug}) > 0`,
    ),
    check(
      "workspaces_settings_billing_tier_check",
      sql`${table.settingsBillingTier} IN ('free', 'pro', 'enterprise')`,
    ),
    check(
      "workspaces_billing_plan_check",
      sql`${table.billingPlan} IN ('free', 'pro', 'enterprise')`,
    ),
    check(
      "workspaces_billing_subscription_status_check",
      sql`${table.billingSubscriptionStatus} IS NULL OR ${table.billingSubscriptionStatus} IN ('active', 'past_due', 'canceled', 'trialing', 'incomplete', 'incomplete_expired', 'unpaid', 'paused')`,
    ),
    uniqueIndex("uq_workspaces_slug").on(table.slug),
    index("idx_workspaces_created_by")
      .on(table.createdBy)
      .where(sql`${table.createdBy} IS NOT NULL`),
    index("idx_workspaces_stripe_customer")
      .on(table.billingStripeCustomerId)
      .where(sql`${table.billingStripeCustomerId} IS NOT NULL`),
    index("idx_workspaces_stripe_subscription")
      .on(table.billingStripeSubscriptionId)
      .where(sql`${table.billingStripeSubscriptionId} IS NOT NULL`),
    index("idx_workspaces_workflows_live")
      .on(table.id)
      .where(sql`${table.workflowsLive} IS NOT NULL`),
  ],
);

export const workspaceApiKeys = pgTable(
  "workspace_api_keys",
  {
    /** Bijective UUIDv8 of `apiKeys[]._id` (referenced by `query_executions.api_key_id`). */
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    prefix: text("prefix").notNull(),
    /** NULL = legacy unrestricted key; non-null array = scoped key. NEVER coalesce to `{}`. */
    scopes: text("scopes").array(),
    /** Nullable UUIDv7 FK: NULL for system/worker keys or deleted creators. */
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /** NULL = Mongo field absent (falsy). */
    agentRun: boolean("agent_run"),
    recordWrites: boolean("record_writes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Throttled to at most one write per key per 60s on the auth hot path. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  table => [
    uniqueIndex("uq_workspace_api_keys_key_hash").on(table.keyHash),
    index("idx_workspace_api_keys_ws_name").on(table.workspaceId, table.name),
    index("idx_workspace_api_keys_ws_creator")
      .on(table.workspaceId, table.createdBy)
      .where(sql`${table.createdBy} IS NOT NULL`),
  ],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<WorkspaceMemberRole>().notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** True only for the onboarding auto-created workspace; NULL otherwise. */
    isDefaultMembership: boolean("is_default_membership"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "workspace_members_role_check",
      sql`${table.role} IN ('owner', 'admin', 'member', 'viewer')`,
    ),
    uniqueIndex("uq_workspace_members_ws_user").on(
      table.workspaceId,
      table.userId,
    ),
    index("idx_workspace_members_user").on(table.userId),
    /** Race guard for concurrent default-workspace onboarding requests. */
    uniqueIndex("uq_workspace_members_default")
      .on(table.userId)
      .where(sql`${table.isDefaultMembership} = true`),
  ],
);

export const workspaceInvites = pgTable(
  "workspace_invites",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    token: text("token").notNull(),
    role: text("role").$type<WorkspaceInviteRole>().notNull(),
    /** Nullable UUIDv7 FK: deleting the inviter preserves pending invite history. */
    invitedBy: uuid("invited_by").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    /** Mongo has no timestamps here: backfilled from the ObjectId timestamp. */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "workspace_invites_email_normalized_check",
      sql`${table.email} = lower(btrim(${table.email})) AND length(${table.email}) > 0`,
    ),
    check(
      "workspace_invites_role_check",
      sql`${table.role} IN ('admin', 'member', 'viewer')`,
    ),
    uniqueIndex("uq_workspace_invites_token").on(table.token),
    index("idx_workspace_invites_ws_email").on(table.workspaceId, table.email),
    index("idx_workspace_invites_email_pending")
      .on(table.email)
      .where(sql`${table.acceptedAt} IS NULL`),
    index("idx_workspace_invites_expires_at").on(table.expiresAt),
  ],
);

export const workspaceUserHandles = pgTable(
  "workspace_user_handles",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Nullable UUIDv7 FK (`ON DELETE SET NULL`): keeps the handle reserved even if the user is deleted. */
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    handle: text("handle").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    uniqueIndex("uq_workspace_user_handles_ws_user")
      .on(table.workspaceId, table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    uniqueIndex("uq_workspace_user_handles_ws_handle").on(
      table.workspaceId,
      table.handle,
    ),
  ],
);

export const mcpOAuthClients = pgTable(
  "mcp_oauth_clients",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    clientId: text("client_id").notNull(),
    clientName: text("client_name"),
    redirectUris: text("redirect_uris").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [uniqueIndex("uq_mcp_oauth_clients_client_id").on(table.clientId)],
);

export const mcpOAuthCodes = pgTable(
  "mcp_oauth_codes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    codeHash: text("code_hash").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => mcpOAuthClients.clientId, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    scopes: text("scopes").array().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  table => [
    uniqueIndex("uq_mcp_oauth_codes_code_hash").on(table.codeHash),
    index("idx_mcp_oauth_codes_expires_at").on(table.expiresAt),
  ],
);

export const mcpOAuthTokens = pgTable(
  "mcp_oauth_tokens",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    accessTokenHash: text("access_token_hash").notNull(),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => mcpOAuthClients.clientId, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentSessionId: text("agent_session_id"),
    scopes: text("scopes").array().notNull(),
    accessExpiresAt: timestamp("access_expires_at", {
      withTimezone: true,
    }).notNull(),
    /** NULL = non-expiring grant (idle TTL disabled or legacy); never reaped. */
    refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    uniqueIndex("uq_mcp_oauth_tokens_access_hash").on(table.accessTokenHash),
    uniqueIndex("uq_mcp_oauth_tokens_refresh_hash").on(table.refreshTokenHash),
    index("idx_mcp_oauth_tokens_ws_user").on(table.workspaceId, table.userId),
    index("idx_mcp_oauth_tokens_agent_session")
      .on(table.agentSessionId)
      .where(sql`${table.agentSessionId} IS NOT NULL`),
    index("idx_mcp_oauth_tokens_refresh_expires_at")
      .on(table.refreshExpiresAt)
      .where(sql`${table.refreshExpiresAt} IS NOT NULL`),
  ],
);

export const acpPlanGrants = pgTable(
  "acp_plan_grants",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentSessionId: text("agent_session_id").notNull(),
    planDigest: text("plan_digest").notNull(),
    grants: text("grants").array().notNull(),
    status: text("status").$type<AcpPlanGrantStatus>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "acp_plan_grants_status_check",
      sql`${table.status} IN ('approved', 'revoked')`,
    ),
    uniqueIndex("uq_acp_plan_grants_agent_session").on(table.agentSessionId),
    index("idx_acp_plan_grants_ws_user").on(table.workspaceId, table.userId),
    index("idx_acp_plan_grants_expires_at").on(table.expiresAt),
  ],
);

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** GitHub App installation ID (bigint avoids int32 overflow; fits JS safe integer). */
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type")
      .$type<GitHubAccountType>()
      .notNull()
      .default("Organization"),
    repositorySelection: text("repository_selection")
      .$type<GitHubRepoSelection>()
      .notNull()
      .default("all"),
    /** Nullable UUIDv7 FK: deleting the installer preserves the workspace binding. */
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "github_installations_account_type_check",
      sql`${table.accountType} IN ('Organization', 'User')`,
    ),
    check(
      "github_installations_repo_selection_check",
      sql`${table.repositorySelection} IN ('all', 'selected')`,
    ),
    uniqueIndex("uq_github_installations_ws_inst").on(
      table.workspaceId,
      table.installationId,
    ),
    index("idx_github_installations_inst_id").on(table.installationId),
    index("idx_github_installations_ws_account").on(
      table.workspaceId,
      table.accountLogin,
    ),
  ],
);

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type NewWorkspaceRow = typeof workspaces.$inferInsert;
export type WorkspaceApiKeyRow = typeof workspaceApiKeys.$inferSelect;
export type NewWorkspaceApiKeyRow = typeof workspaceApiKeys.$inferInsert;
export type WorkspaceMemberRow = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMemberRow = typeof workspaceMembers.$inferInsert;
export type WorkspaceInviteRow = typeof workspaceInvites.$inferSelect;
export type NewWorkspaceInviteRow = typeof workspaceInvites.$inferInsert;
export type WorkspaceUserHandleRow = typeof workspaceUserHandles.$inferSelect;
export type NewWorkspaceUserHandleRow =
  typeof workspaceUserHandles.$inferInsert;
export type McpOAuthClientRow = typeof mcpOAuthClients.$inferSelect;
export type NewMcpOAuthClientRow = typeof mcpOAuthClients.$inferInsert;
export type McpOAuthCodeRow = typeof mcpOAuthCodes.$inferSelect;
export type NewMcpOAuthCodeRow = typeof mcpOAuthCodes.$inferInsert;
export type McpOAuthTokenRow = typeof mcpOAuthTokens.$inferSelect;
export type NewMcpOAuthTokenRow = typeof mcpOAuthTokens.$inferInsert;
export type AcpPlanGrantRow = typeof acpPlanGrants.$inferSelect;
export type NewAcpPlanGrantRow = typeof acpPlanGrants.$inferInsert;
export type GitHubInstallationRow = typeof githubInstallations.$inferSelect;
export type NewGitHubInstallationRow = typeof githubInstallations.$inferInsert;
