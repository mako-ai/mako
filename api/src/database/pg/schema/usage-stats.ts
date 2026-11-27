/**
 * Phase 2B (`usage_stats` domain) platform Postgres Drizzle schema.
 *
 * Covers the 7 usage, telemetry, feed-snapshot, and billing-ledger tables:
 *   1. `app_usage_daily`          (Mongo `app_usage_daily`; immutable `visitor_key` + typed `user_id`/`anon_id`, NO TTL!)
 *   2. `app_usage_events`         (Mongo `app_usage_events`; raw append-only event log, 400d TTL reaper)
 *   3. `app_feed_snapshots`       (Mongo `app_feed_snapshots`; ephemeral 24h cursor, skip backfill, 24h hourly TTL reaper)
 *   4. `skill_usage_daily`        (Mongo `skill_usage_daily`; daily `$inc` rollup, 400d TTL reaper on `last_at`)
 *   5. `llm_usage`                (Mongo `llmusages`; permanent metered billing ledger, NO TTL! `chat_id` FK post-Phase 3)
 *   6. `query_executions`         (Mongo `query_executions`; 90d TTL reaper, `connection_id` stays soft UUID NOT NULL)
 *   7. `connection_verifications` (Mongo `connection_verifications`; 90d TTL reaper, deferred `connection_id` FK in `0006a`)
 *
 * Conventions (Decisions #2, #3, #5, #6; #12 Sub-Domain 3; #34 §2.1, §2.2, §2.4):
 *   - `app_usage_daily` uses immutable `visitor_key` (`'u:'||user_id` | `anon_id` | `'anon'`) in its
 *     unique key `(workspace_id, app_id, visitor_key, day)` so `DELETE FROM users` (`ON DELETE SET NULL`
 *     on `user_id`) NEVER triggers `23505 unique_violation` against anonymous viewers on the same day.
 *   - `llm_usage.user_id` is nullable `uuid REFERENCES users(id) ON DELETE SET NULL` so system/worker
 *     calls map cleanly and deleting a user NEVER cascades or loses billing history.
 *   - `query_executions.api_key_id` references `workspace_api_keys(id) ON DELETE SET NULL`;
 *     `query_executions.connection_id` stays a soft `uuid NOT NULL` ref forever so deleting a connection
 *     preserves 90d query audit telemetry.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { workspaceApiKeys, workspaces } from "./workspaces";

export const APP_USAGE_EVENT_KINDS = ["open", "heartbeat"] as const;
export type AppUsageEventKind = (typeof APP_USAGE_EVENT_KINDS)[number];

export const APP_USAGE_EVENT_SOURCES = ["app", "share", "embed"] as const;
export type AppUsageEventSource = (typeof APP_USAGE_EVENT_SOURCES)[number];

export const APP_USAGE_REFERRER_KINDS = [
  "internal",
  "external",
  "direct",
] as const;
export type AppUsageReferrerKindPg = (typeof APP_USAGE_REFERRER_KINDS)[number];

export const APP_USAGE_UA_CLASSES = [
  "desktop",
  "mobile",
  "bot",
  "unknown",
] as const;
export type AppUsageUaClassPg = (typeof APP_USAGE_UA_CLASSES)[number];

export const APP_USAGE_BACKFILL_SOURCES = ["cloud-run", "posthog"] as const;
export type AppUsageBackfillSource =
  (typeof APP_USAGE_BACKFILL_SOURCES)[number];

export const SKILL_USAGE_SCOPES = ["workspace", "system"] as const;
export type SkillUsageScopePg = (typeof SKILL_USAGE_SCOPES)[number];

export const SKILL_USAGE_SOURCES = ["agent", "mcp"] as const;
export type SkillUsageSourcePg = (typeof SKILL_USAGE_SOURCES)[number];

export const LLM_INVOCATION_TYPES = [
  "chat",
  "title_generation",
  "description_generation",
  "embedding",
  "version_comment",
  "workflow",
  "commit_message",
] as const;
export type LlmInvocationTypePg = (typeof LLM_INVOCATION_TYPES)[number];

export const QUERY_EXECUTION_SOURCES = [
  "console_ui",
  "console_ui_admin_override",
  "api",
  "mcp",
  "agent",
  "flow",
  "scheduled_query",
] as const;
export type QueryExecutionSourcePg = (typeof QUERY_EXECUTION_SOURCES)[number];

export const QUERY_EXECUTION_LANGUAGES = [
  "sql",
  "mongodb",
  "javascript",
] as const;
export type QueryExecutionLanguagePg =
  (typeof QUERY_EXECUTION_LANGUAGES)[number];

export const QUERY_EXECUTION_STATUSES = [
  "success",
  "error",
  "cancelled",
  "timeout",
] as const;
export type QueryExecutionStatusPg = (typeof QUERY_EXECUTION_STATUSES)[number];

export const CONNECTION_VERIFICATION_TRIGGERS = [
  "standalone_test",
  "create_verify",
  "update_verify",
  "saved_test",
] as const;
export type ConnectionVerificationTriggerPg =
  (typeof CONNECTION_VERIFICATION_TRIGGERS)[number];

export interface AppUsagePlacementJson {
  surface: "home";
  shelf:
    | "popular"
    | "new"
    | "recommended"
    | "recent"
    | "mine"
    | "attention"
    | "search";
  position: number;
}

export interface LlmUsageStepJson {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

export const appUsageDaily = pgTable(
  "app_usage_daily",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Bijective UUIDv8 of 24-hex appId (soft ref). */
    appId: uuid("app_id").notNull(),
    /** Signed-in viewer UUIDv7 FK (`ON DELETE SET NULL` — never touches `visitor_key`). */
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** First-party anonymous id (`'anon:<hash>'` | `'ph:<id>'`) or NULL. */
    anonId: text("anon_id"),
    /**
     * Immutable dedupe key set on insert:
     *   - signed-in viewer: `'u:' || user_id`
     *   - identified anon:  `anon_id` (`'anon:<hash>'` or `'ph:<id>'`)
     *   - collapsed null:   `'anon'`
     */
    visitorKey: text("visitor_key").notNull(),
    /** UTC YYYY-MM-DD day bucket. */
    day: date("day", { mode: "string" }).notNull(),
    opens: integer("opens").notNull().default(0),
    activeSeconds: integer("active_seconds").notNull().default(0),
    sourcesApp: integer("sources_app").notNull().default(0),
    sourcesShare: integer("sources_share").notNull().default(0),
    sourcesEmbed: integer("sources_embed").notNull().default(0),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull(),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull(),
  },
  table => [
    check(
      "app_usage_daily_viewer_exclusive",
      sql`NOT (${table.userId} IS NOT NULL AND ${table.anonId} IS NOT NULL)`,
    ),
    uniqueIndex("uq_app_usage_daily_key").on(
      table.workspaceId,
      table.appId,
      table.visitorKey,
      table.day,
    ),
    index("idx_app_usage_daily_ws_day").on(table.workspaceId, table.day),
    index("idx_app_usage_daily_ws_user_last")
      .on(table.workspaceId, table.userId, sql`${table.lastAt} DESC`)
      .where(sql`${table.userId} IS NOT NULL`),
    index("idx_app_usage_daily_last_at").on(sql`${table.lastAt} DESC`),
  ],
);

export const appUsageEvents = pgTable(
  "app_usage_events",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Bijective UUIDv8 of 24-hex appId (soft ref). */
    appId: uuid("app_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    kind: text("kind").$type<AppUsageEventKind>().notNull(),
    source: text("source").$type<AppUsageEventSource>().notNull(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    anonId: text("anon_id"),
    sessionId: text("session_id"),
    referrerKind: text("referrer_kind").$type<AppUsageReferrerKindPg>(),
    uaClass: text("ua_class").$type<AppUsageUaClassPg>().notNull(),
    throttled: boolean("throttled"),
    placement: jsonb("placement").$type<AppUsagePlacementJson>(),
    backfill: text("backfill").$type<AppUsageBackfillSource>(),
  },
  table => [
    check(
      "app_usage_events_kind_check",
      sql`${table.kind} IN ('open', 'heartbeat')`,
    ),
    check(
      "app_usage_events_source_check",
      sql`${table.source} IN ('app', 'share', 'embed')`,
    ),
    check(
      "app_usage_events_referrer_kind_check",
      sql`${table.referrerKind} IS NULL OR ${table.referrerKind} IN ('internal', 'external', 'direct')`,
    ),
    check(
      "app_usage_events_ua_class_check",
      sql`${table.uaClass} IN ('desktop', 'mobile', 'bot', 'unknown')`,
    ),
    check(
      "app_usage_events_backfill_check",
      sql`${table.backfill} IS NULL OR ${table.backfill} IN ('cloud-run', 'posthog')`,
    ),
    check(
      "app_usage_events_viewer_exclusive",
      sql`NOT (${table.userId} IS NOT NULL AND ${table.anonId} IS NOT NULL)`,
    ),
    index("idx_app_usage_events_ws_app_at").on(
      table.workspaceId,
      table.appId,
      table.at,
    ),
    index("idx_app_usage_events_ws_user_at")
      .on(table.workspaceId, table.userId, table.at)
      .where(sql`${table.userId} IS NOT NULL`),
    index("idx_app_usage_events_at").on(table.at),
  ],
);

export const appFeedSnapshots = pgTable(
  "app_feed_snapshots",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Nullable UUIDv7 FK (`ON DELETE CASCADE`); NULL for callers without a user. */
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    /** Wire 24-hex appId strings. */
    popular: text("popular")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    fresh: text("fresh")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    recommended: text("recommended")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [index("idx_app_feed_snapshots_created").on(table.createdAt)],
);

export const skillUsageDaily = pgTable(
  "skill_usage_daily",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scope: text("scope").$type<SkillUsageScopePg>().notNull(),
    skill: text("skill").notNull(),
    source: text("source").$type<SkillUsageSourcePg>().notNull(),
    /** UTC YYYY-MM-DD day bucket. */
    day: date("day", { mode: "string" }).notNull(),
    loads: integer("loads").notNull().default(0),
    resourceReads: integer("resource_reads").notNull().default(0),
    relevantHits: integer("relevant_hits").notNull().default(0),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull(),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull(),
  },
  table => [
    check(
      "skill_usage_daily_scope_check",
      sql`${table.scope} IN ('workspace', 'system')`,
    ),
    check(
      "skill_usage_daily_source_check",
      sql`${table.source} IN ('agent', 'mcp')`,
    ),
    uniqueIndex("uq_skill_usage_daily_key").on(
      table.workspaceId,
      table.scope,
      table.skill,
      table.source,
      table.day,
    ),
    index("idx_skill_usage_daily_ws_day").on(table.workspaceId, table.day),
    index("idx_skill_usage_daily_last_at").on(table.lastAt),
  ],
);

export const llmUsage = pgTable(
  "llm_usage",
  {
    id: uuid("id").primaryKey(),
    /** Soft UUID ref (NO FK): permanent billing ledger survives workspace deletion, matching Mongo. */
    workspaceId: uuid("workspace_id").notNull(),
    /** Nullable UUIDv7 FK (`ON DELETE SET NULL`): billing ledger survives user delete & system calls. */
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Soft ref in Phase 2; Phase 3 attaches `REFERENCES chats(id) ON DELETE SET NULL` via post-backfill. */
    chatId: uuid("chat_id"),
    invocationType: text("invocation_type")
      .$type<LlmInvocationTypePg>()
      .notNull(),
    modelId: text("model_id").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 14, scale: 8 })
      .notNull()
      .default("0"),
    steps: jsonb("steps").$type<LlmUsageStepJson[]>(),
    agentId: text("agent_id"),
    tags: text("tags").array(),
    durationMs: integer("duration_ms"),
    // Flattened workflowRun (serves workflows/costs.ts partial indexes directly)
    workflowId: text("workflow_id"),
    workflowRunId: text("workflow_run_id"),
    workflowStep: text("workflow_step"),
    workflowBackfilled: boolean("workflow_backfilled"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "llm_usage_invocation_type_check",
      sql`${table.invocationType} IN ('chat', 'title_generation', 'description_generation', 'embedding', 'version_comment', 'workflow', 'commit_message')`,
    ),
    check(
      "llm_usage_steps_array_check",
      sql`${table.steps} IS NULL OR jsonb_typeof(${table.steps}) = 'array'`,
    ),
    index("idx_llm_usage_ws_created").on(
      table.workspaceId,
      sql`${table.createdAt} DESC`,
    ),
    index("idx_llm_usage_ws_user_at")
      .on(table.workspaceId, table.userId, sql`${table.createdAt} DESC`)
      .where(sql`${table.userId} IS NOT NULL`),
    index("idx_llm_usage_user_at")
      .on(table.userId, sql`${table.createdAt} DESC`)
      .where(sql`${table.userId} IS NOT NULL`),
    index("idx_llm_usage_chat_id")
      .on(table.chatId)
      .where(sql`${table.chatId} IS NOT NULL`),
    index("idx_llm_usage_ws_wf_run")
      .on(table.workspaceId, table.workflowRunId)
      .where(sql`${table.workflowRunId} IS NOT NULL`),
    index("idx_llm_usage_ws_wf_created")
      .on(table.workspaceId, table.workflowId, sql`${table.createdAt} DESC`)
      .where(sql`${table.workflowId} IS NOT NULL`),
  ],
);

export const queryExecutions = pgTable(
  "query_executions",
  {
    id: uuid("id").primaryKey(),
    executedAt: timestamp("executed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    apiKeyId: uuid("api_key_id").references(() => workspaceApiKeys.id, {
      onDelete: "set null",
    }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Soft UUID ref (NO FK per #34 §2.4 so 90d audit telemetry survives connection deletion). */
    connectionId: uuid("connection_id").notNull(),
    databaseName: text("database_name"),
    /** Soft UUID ref -> saved_consoles.id (decouples sub-domains). */
    consoleId: uuid("console_id"),
    source: text("source").$type<QueryExecutionSourcePg>().notNull(),
    databaseType: text("database_type").notNull(),
    queryLanguage: text("query_language")
      .$type<QueryExecutionLanguagePg>()
      .notNull(),
    status: text("status").$type<QueryExecutionStatusPg>().notNull(),
    executionTimeMs: integer("execution_time_ms").notNull(),
    rowCount: integer("row_count"),
    errorType: text("error_type"),
    bytesScanned: bigint("bytes_scanned", { mode: "number" }),
  },
  table => [
    check(
      "query_executions_source_check",
      sql`${table.source} IN ('console_ui', 'console_ui_admin_override', 'api', 'mcp', 'agent', 'flow', 'scheduled_query')`,
    ),
    check(
      "query_executions_query_language_check",
      sql`${table.queryLanguage} IN ('sql', 'mongodb', 'javascript')`,
    ),
    check(
      "query_executions_status_check",
      sql`${table.status} IN ('success', 'error', 'cancelled', 'timeout')`,
    ),
    index("idx_query_exec_ws_at").on(
      table.workspaceId,
      sql`${table.executedAt} DESC`,
    ),
    index("idx_query_exec_user_at")
      .on(table.userId, sql`${table.executedAt} DESC`)
      .where(sql`${table.userId} IS NOT NULL`),
    index("idx_query_exec_apikey_at")
      .on(table.apiKeyId, sql`${table.executedAt} DESC`)
      .where(sql`${table.apiKeyId} IS NOT NULL`),
    index("idx_query_exec_ws_status").on(table.workspaceId, table.status),
    index("idx_query_exec_ws_console_at")
      .on(table.workspaceId, table.consoleId, sql`${table.executedAt} DESC`)
      .where(sql`${table.consoleId} IS NOT NULL`),
    index("idx_query_exec_executed_at").on(table.executedAt),
  ],
);

export const connectionVerifications = pgTable(
  "connection_verifications",
  {
    id: uuid("id").primaryKey(),
    verifiedAt: timestamp("verified_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    /** Soft ref in 0006; upgraded to `REFERENCES database_connections(id) ON DELETE SET NULL` in `post-backfill/0006a`. */
    connectionId: uuid("connection_id"),
    databaseType: text("database_type").notNull(),
    trigger: text("trigger").$type<ConnectionVerificationTriggerPg>().notNull(),
    success: boolean("success").notNull(),
    durationMs: integer("duration_ms").notNull(),
    errorClass: text("error_class"),
    errorMessage: text("error_message"),
  },
  table => [
    check(
      "connection_verifications_trigger_check",
      sql`${table.trigger} IN ('standalone_test', 'create_verify', 'update_verify', 'saved_test')`,
    ),
    index("idx_conn_verif_ws_at")
      .on(table.workspaceId, sql`${table.verifiedAt} DESC`)
      .where(sql`${table.workspaceId} IS NOT NULL`),
    index("idx_conn_verif_user_at")
      .on(table.userId, sql`${table.verifiedAt} DESC`)
      .where(sql`${table.userId} IS NOT NULL`),
    index("idx_conn_verif_fail_rollup").on(
      table.success,
      table.errorClass,
      sql`${table.verifiedAt} DESC`,
    ),
    index("idx_conn_verif_verified_at").on(table.verifiedAt),
  ],
);

export type AppUsageDailyRow = typeof appUsageDaily.$inferSelect;
export type NewAppUsageDailyRow = typeof appUsageDaily.$inferInsert;
export type AppUsageEventRow = typeof appUsageEvents.$inferSelect;
export type NewAppUsageEventRow = typeof appUsageEvents.$inferInsert;
export type AppFeedSnapshotRow = typeof appFeedSnapshots.$inferSelect;
export type NewAppFeedSnapshotRow = typeof appFeedSnapshots.$inferInsert;
export type SkillUsageDailyRow = typeof skillUsageDaily.$inferSelect;
export type NewSkillUsageDailyRow = typeof skillUsageDaily.$inferInsert;
export type LlmUsageRow = typeof llmUsage.$inferSelect;
export type NewLlmUsageRow = typeof llmUsage.$inferInsert;
export type QueryExecutionRow = typeof queryExecutions.$inferSelect;
export type NewQueryExecutionRow = typeof queryExecutions.$inferInsert;
export type ConnectionVerificationRow =
  typeof connectionVerifications.$inferSelect;
export type NewConnectionVerificationRow =
  typeof connectionVerifications.$inferInsert;
