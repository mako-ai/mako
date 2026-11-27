/**
 * Phase 2A-1 (`connections`) platform Postgres Drizzle schema (5 tables).
 *
 * Covers:
 *   - `database_connections`     (Mongo `databaseconnections`; explicit repo-layer leaf encryption)
 *   - `source_connections`       (Mongo `connectors`; schema-driven encryption, atomic key-request claim)
 *   - `connection_access_events` (Mongo `connection_access_events`; permanent audit log, NO TTL)
 *   - `connection_write_events`  (Mongo `connection_write_events`; 90-day TTL via migration-pg-ttl-reaper)
 *   - `connector_definitions`    (Mongo `connectordefinitions`; derived workspace git connector index)
 *
 * Conventions (rfcs/postgres-migration.md, Decision #1 & #3):
 *   - Every ObjectId PK/FK is a bijective RFC 9562 UUIDv8 (`objectIdToUuid` / `toWireId`) so
 *     Mongo-resident flows, CDC, webhooks, and connector_boxes stay wire-compatible.
 *   - Every user FK is nullable `uuid REFERENCES users(id) ON DELETE SET NULL` (RFC 9562 UUIDv7).
 *   - `source_connections.live_readers`: NULL = everyone reads live (when `live_reads = true`);
 *     `[]` = writers only. Never coalesce NULL to `[]`.
 *   - `database_connections.writers` and `source_connections.writers`: NULL preserves Mongo
 *     `undefined` vs explicit `[]`.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
import { workspaces } from "./workspaces";

export const DATABASE_CONNECTION_TYPES = [
  "mongodb",
  "postgresql",
  "redshift",
  "cloudsql-postgres",
  "mysql",
  "sqlite",
  "mssql",
  "bigquery",
  "clickhouse",
  "cloudflare-d1",
  "cloudflare-kv",
] as const;
export type DatabaseConnectionType = (typeof DATABASE_CONNECTION_TYPES)[number];

export const CONNECTION_ACCESS_KINDS = ["database", "source"] as const;
export type ConnectionAccessKind = (typeof CONNECTION_ACCESS_KINDS)[number];

export const CONNECTION_ACCESS_VIAS = ["app", "mcp", "api"] as const;
export type ConnectionAccessVia = (typeof CONNECTION_ACCESS_VIAS)[number];

export const CONNECTOR_DEFINITION_STATUSES = [
  "indexed",
  "verified",
  "blocked",
  "retrying",
] as const;
export type ConnectorDefinitionStatus =
  (typeof CONNECTOR_DEFINITION_STATUSES)[number];

export interface ConnectionWriterJson {
  principal: string;
  where?: string;
  addedBy?: string;
  /** ISO-8601 string in JSONB; mapper converts to/from `Date`. */
  addedAt?: string;
}

export interface SourceConnectionSettingsJson {
  sync_batch_size: number;
  rate_limit_delay_ms: number;
  max_retries?: number;
  timeout_ms?: number;
  timezone?: string;
}

export interface ConnectionAccessListChangeJson {
  added: string[];
  removed: string[];
}

export interface ConnectionAccessChangesJson {
  writers?: ConnectionAccessListChangeJson;
  liveReaders?: ConnectionAccessListChangeJson & {
    everyone?: boolean;
    limited?: boolean;
  };
  managers?: ConnectionAccessListChangeJson;
  liveReads?: boolean;
  agentWrites?: boolean;
}

export interface ConnectorDefinitionBuildJson {
  status: "built" | "failed";
  hash: string;
  error?: string;
  bytes?: number;
  /** ISO-8601 string in JSONB; mapper converts to/from `Date`. */
  builtAt?: string;
}

export interface ConnectorDefinitionRegistryJson {
  ref: string;
  slug: string;
  range: string;
  version: string;
  hash: string;
  sha256: string;
  latest: string;
  upgradeAvailable?: string;
  /** ISO-8601 string in JSONB; mapper converts to/from `Date`. */
  resolvedAt: string;
}

export const databaseConnections = pgTable(
  "database_connections",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").$type<DatabaseConnectionType>().notNull(),
    connectionEncrypted: jsonb("connection_encrypted")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    isDemo: boolean("is_demo").notNull().default(false),
    allowAgentWrites: boolean("allow_agent_writes").notNull().default(false),
    writers: jsonb("writers").$type<ConnectionWriterJson[] | null>(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    index("idx_database_connections_ws_created").on(
      table.workspaceId,
      table.createdAt.desc(),
    ),
    index("idx_database_connections_ws_name").on(table.workspaceId, table.name),
    index("idx_database_connections_ws_demo")
      .on(table.workspaceId)
      .where(sql`${table.isDemo} = true`),
    check(
      "database_connections_type_check",
      sql`${table.type} IN ('mongodb', 'postgresql', 'redshift', 'cloudsql-postgres', 'mysql', 'sqlite', 'mssql', 'bigquery', 'clickhouse', 'cloudflare-d1', 'cloudflare-kv')`,
    ),
  ],
);

export const sourceConnections = pgTable(
  "source_connections",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    description: text("description"),
    configEncrypted: jsonb("config_encrypted")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    settings: jsonb("settings")
      .$type<SourceConnectionSettingsJson>()
      .notNull()
      .default(sql`'{"sync_batch_size":100,"rate_limit_delay_ms":200}'::jsonb`),
    targetDatabaseIds: uuid("target_database_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    writers: jsonb("writers").$type<ConnectionWriterJson[] | null>(),
    liveReads: boolean("live_reads").notNull().default(false),
    /** NULL = everyone reads live (when live_reads=true); [] = writers only. */
    liveReaders: jsonb("live_readers").$type<ConnectionWriterJson[] | null>(),
    managers: uuid("managers").array(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    keyRequestTokenHash: text("key_request_token_hash"),
    keyRequestExpiresAt: timestamp("key_request_expires_at", {
      withTimezone: true,
    }),
    keyRequestFields: text("key_request_fields").array(),
    keyRequestRequestedBy: uuid("key_request_requested_by").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    keyRequestCreatedAt: timestamp("key_request_created_at", {
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
    index("idx_source_connections_ws_created").on(
      table.workspaceId,
      table.createdAt.desc(),
    ),
    index("idx_source_connections_ws_type").on(table.workspaceId, table.type),
    index("idx_source_connections_ws_name").on(table.workspaceId, table.name),
    index("idx_source_connections_active_type")
      .on(table.type)
      .where(sql`${table.isActive} = true`),
    uniqueIndex("uq_source_connections_key_request_token")
      .on(table.workspaceId, table.keyRequestTokenHash)
      .where(sql`${table.keyRequestTokenHash} IS NOT NULL`),
    check(
      "chk_source_connections_key_request_atomic",
      sql`(${table.keyRequestTokenHash} IS NULL AND ${table.keyRequestExpiresAt} IS NULL AND ${table.keyRequestFields} IS NULL AND ${table.keyRequestCreatedAt} IS NULL) OR (${table.keyRequestTokenHash} IS NOT NULL AND ${table.keyRequestExpiresAt} IS NOT NULL AND ${table.keyRequestFields} IS NOT NULL AND ${table.keyRequestCreatedAt} IS NOT NULL)`,
    ),
  ],
);

export const connectionAccessEvents = pgTable(
  "connection_access_events",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Soft ref (polymorphic db/source; audit history survives deletion). */
    connectionId: uuid("connection_id").notNull(),
    kind: text("kind").$type<ConnectionAccessKind>().notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    actorRaw: text("actor_raw"),
    via: text("via").$type<ConnectionAccessVia>().notNull(),
    changes: jsonb("changes").$type<ConnectionAccessChangesJson>().notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index("idx_connection_access_events_ws_conn_at").on(
      table.workspaceId,
      table.connectionId,
      table.at.desc(),
    ),
    check(
      "connection_access_events_kind_check",
      sql`${table.kind} IN ('database', 'source')`,
    ),
    check(
      "connection_access_events_via_check",
      sql`${table.via} IN ('app', 'mcp', 'api')`,
    ),
  ],
);

export const connectionWriteEvents = pgTable(
  "connection_write_events",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Soft ref (polymorphic db/source). */
    connectionId: uuid("connection_id").notNull(),
    principal: text("principal").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    target: text("target"),
    allowed: boolean("allowed").notNull(),
    status: integer("status"),
    error: text("error"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index("idx_connection_write_events_ws_conn_at").on(
      table.workspaceId,
      table.connectionId,
      table.at.desc(),
    ),
    index("idx_connection_write_events_conn_at").on(
      table.connectionId,
      table.at.desc(),
    ),
    index("idx_connection_write_events_at").on(table.at),
  ],
);

export const connectorDefinitions = pgTable(
  "connector_definitions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    runtime: text("runtime").notNull().default("node"),
    entry: text("entry").notNull().default("connector.ts"),
    sha: text("sha").notNull(),
    sourceSha: text("source_sha").notNull(),
    spec: jsonb("spec").$type<Record<string, unknown> | null>(),
    status: text("status")
      .$type<ConnectorDefinitionStatus>()
      .notNull()
      .default("indexed"),
    blockedReason: text("blocked_reason"),
    indexRetryAttempts: integer("index_retry_attempts"),
    nextIndexRetryAt: timestamp("next_index_retry_at", { withTimezone: true }),
    entities: text("entities")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    hasIcon: boolean("has_icon").notNull().default(false),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastCheckError: text("last_check_error"),
    build: jsonb("build").$type<ConnectorDefinitionBuildJson | null>(),
    registry: jsonb("registry").$type<ConnectorDefinitionRegistryJson | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    uniqueIndex("uq_connector_definitions_ws_slug").on(
      table.workspaceId,
      table.slug,
    ),
    index("idx_connector_definitions_retrying_due")
      .on(table.nextIndexRetryAt)
      .where(sql`${table.status} = 'retrying'`),
    check(
      "connector_definitions_status_check",
      sql`${table.status} IN ('indexed', 'verified', 'blocked', 'retrying')`,
    ),
  ],
);

export type DatabaseConnectionRow = typeof databaseConnections.$inferSelect;
export type NewDatabaseConnectionRow = typeof databaseConnections.$inferInsert;
export type SourceConnectionRow = typeof sourceConnections.$inferSelect;
export type NewSourceConnectionRow = typeof sourceConnections.$inferInsert;
export type ConnectionAccessEventRow =
  typeof connectionAccessEvents.$inferSelect;
export type NewConnectionAccessEventRow =
  typeof connectionAccessEvents.$inferInsert;
export type ConnectionWriteEventRow = typeof connectionWriteEvents.$inferSelect;
export type NewConnectionWriteEventRow =
  typeof connectionWriteEvents.$inferInsert;
export type ConnectorDefinitionRow = typeof connectorDefinitions.$inferSelect;
export type NewConnectorDefinitionRow =
  typeof connectorDefinitions.$inferInsert;
