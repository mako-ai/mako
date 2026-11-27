/**
 * Phase 3 (Part 1 — `mcp` domain) platform Postgres Drizzle schema.
 *
 * Covers the 4 MCP client tables (`0007_phase3_mcp.sql`):
 *   - `mcp_servers`            (workspace-level MCP server definitions)
 *   - `mcp_connection_configs` (workspace-shared `user_id IS NULL` or per-user credentials)
 *   - `mcp_oauth_flows`        (ephemeral 10m PKCE state; read-time SQL guard + hourly TTL reaper)
 *   - `mcp_tool_grants`        (per-user always_allow / always_deny grants, incl. `*`)
 *
 * All 4 encrypted fields (`oauth_client_information_encrypted`, `headers_encrypted`,
 * `oauth_tokens_encrypted`, `code_verifier_encrypted`) store opaque ciphertext verbatim.
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
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  IMcpCachedTool,
  McpAuthPerformer,
  McpAuthType,
  McpGrantDecision,
  McpServerStatus,
  McpToolRestriction,
  McpTransportType,
  McpWriteScope,
} from "../../models/mcp";
import { users } from "./auth";
import { workspaces } from "./workspaces";

export const mcpServers = pgTable(
  "mcp_servers",
  {
    /** Bijective ObjectId <-> RFC 9562 UUIDv8. */
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    connectorType: text("connector_type").notNull().default("custom"),
    transportType: text("transport_type")
      .$type<McpTransportType>()
      .notNull()
      .default("http"),
    transportUrl: text("transport_url").notNull(),
    authType: text("auth_type")
      .$type<McpAuthType>()
      .notNull()
      .default("api_key"),
    authPerformer: text("auth_performer")
      .$type<McpAuthPerformer>()
      .notNull()
      .default("workspace"),
    writeScope: text("write_scope")
      .$type<McpWriteScope>()
      .notNull()
      .default("read"),
    toolPolicyDefaultRestriction: text("tool_policy_default_restriction")
      .$type<McpToolRestriction>()
      .notNull()
      .default("always"),
    toolPolicyRestrictions: jsonb("tool_policy_restrictions")
      .$type<Record<string, McpToolRestriction>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    cachedTools: jsonb("cached_tools")
      .$type<IMcpCachedTool[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    oauthClientInformationEncrypted: text("oauth_client_information_encrypted"),
    status: text("status")
      .$type<McpServerStatus>()
      .notNull()
      .default("created"),
    lastError: text("last_error"),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    unique("mcp_servers_ws_name_unique").on(table.workspaceId, table.name),
    index("idx_mcp_servers_ws_active").on(table.workspaceId, table.isActive),
    check("mcp_servers_name_len_check", sql`char_length(${table.name}) <= 100`),
    check(
      "mcp_servers_description_len_check",
      sql`${table.description} IS NULL OR char_length(${table.description}) <= 500`,
    ),
    check(
      "mcp_servers_transport_type_check",
      sql`${table.transportType} IN ('http')`,
    ),
    check(
      "mcp_servers_auth_type_check",
      sql`${table.authType} IN ('none', 'api_key', 'oauth')`,
    ),
    check(
      "mcp_servers_auth_performer_check",
      sql`${table.authPerformer} IN ('workspace', 'user')`,
    ),
    check(
      "mcp_servers_write_scope_check",
      sql`${table.writeScope} IN ('read', 'write_safe', 'write_destructive')`,
    ),
    check(
      "mcp_servers_tool_policy_default_check",
      sql`${table.toolPolicyDefaultRestriction} IN ('always', 'ask', 'block')`,
    ),
    check(
      "mcp_servers_tool_policy_restrictions_check",
      sql`jsonb_typeof(${table.toolPolicyRestrictions}) = 'object'`,
    ),
    check(
      "mcp_servers_cached_tools_check",
      sql`jsonb_typeof(${table.cachedTools}) = 'array'`,
    ),
    check(
      "mcp_servers_status_check",
      sql`${table.status} IN ('created', 'awaiting_auth', 'connected', 'error')`,
    ),
  ],
);

export const mcpConnectionConfigs = pgTable(
  "mcp_connection_configs",
  {
    /** Bijective ObjectId <-> RFC 9562 UUIDv8. */
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    /** NULL = workspace-shared credential (Mongo `userId: ""`); non-NULL = per-user. */
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    headersEncrypted: jsonb("headers_encrypted")
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    oauthTokensEncrypted: text("oauth_tokens_encrypted"),
    oauthExpiresAt: timestamp("oauth_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    unique("mcp_connection_configs_server_user_unique")
      .on(table.serverId, table.userId)
      .nullsNotDistinct(),
    index("idx_mcp_conn_configs_ws").on(table.workspaceId),
    index("idx_mcp_conn_configs_user")
      .on(table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    check(
      "mcp_connection_configs_headers_check",
      sql`jsonb_typeof(${table.headersEncrypted}) = 'object'`,
    ),
  ],
);

export const mcpOauthFlows = pgTable(
  "mcp_oauth_flows",
  {
    /** Bijective ObjectId <-> RFC 9562 UUIDv8. */
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    state: text("state").notNull().unique("mcp_oauth_flows_state_unique"),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    /** NULL = workspace-shared credential (Mongo `configUserId: ""`). */
    configUserId: uuid("config_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    startedByUserId: uuid("started_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeVerifierEncrypted: text("code_verifier_encrypted"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [index("idx_mcp_oauth_flows_created_at").on(table.createdAt)],
);

export const mcpToolGrants = pgTable(
  "mcp_tool_grants",
  {
    /** Bijective ObjectId <-> RFC 9562 UUIDv8. */
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    decision: text("decision").$type<McpGrantDecision>().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    unique("mcp_tool_grants_server_user_tool_unique").on(
      table.serverId,
      table.userId,
      table.toolName,
    ),
    index("idx_mcp_tool_grants_ws_user").on(table.workspaceId, table.userId),
    check(
      "mcp_tool_grants_decision_check",
      sql`${table.decision} IN ('always_allow', 'always_deny')`,
    ),
  ],
);

export type McpServerRow = typeof mcpServers.$inferSelect;
export type NewMcpServerRow = typeof mcpServers.$inferInsert;
export type McpConnectionConfigRow = typeof mcpConnectionConfigs.$inferSelect;
export type NewMcpConnectionConfigRow =
  typeof mcpConnectionConfigs.$inferInsert;
export type McpOAuthFlowRow = typeof mcpOauthFlows.$inferSelect;
export type NewMcpOAuthFlowRow = typeof mcpOauthFlows.$inferInsert;
export type McpToolGrantRow = typeof mcpToolGrants.$inferSelect;
export type NewMcpToolGrantRow = typeof mcpToolGrants.$inferInsert;
