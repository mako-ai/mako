import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { workspaces } from "./workspaces";

/**
 * Connections domain (was Mongo `databaseconnections` and `connectors`).
 *
 * `connection` / `config` hold credentials and are stored encrypted (AES-256-CBC
 * via `db/crypto.ts`) inside the JSONB blob — encryption/decryption happens in
 * the repository layer, mirroring the legacy Mongoose getters/setters.
 */

export type DatabaseConnectionType =
  | "mongodb"
  | "postgresql"
  | "redshift"
  | "cloudsql-postgres"
  | "mysql"
  | "sqlite"
  | "mssql"
  | "bigquery"
  | "clickhouse"
  | "cloudflare-d1"
  | "cloudflare-kv";

export const databaseConnections = pgTable(
  "database_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").$type<DatabaseConnectionType>().notNull(),
    // Encrypted credential blob (string leaves are AES-256-CBC ciphertext).
    connection: jsonb("connection").$type<Record<string, unknown>>().notNull(),
    isDemo: boolean("is_demo").notNull().default(false),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [index("database_connections_workspace_idx").on(table.workspaceId)],
);

export interface ConnectorSettings {
  sync_batch_size?: number;
  rate_limit_delay_ms?: number;
  [key: string]: unknown;
}

export const connectors = pgTable(
  "connectors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    description: text("description"),
    // Encrypted credential blob.
    config: jsonb("config").$type<Record<string, unknown>>(),
    settings: jsonb("settings").$type<ConnectorSettings>(),
    // References database_connections.id (uuid[]).
    targetDatabases: uuid("target_databases").array(),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [index("connectors_workspace_idx").on(table.workspaceId)],
);

export type DatabaseConnectionRow = typeof databaseConnections.$inferSelect;
export type NewDatabaseConnectionRow = typeof databaseConnections.$inferInsert;
export type ConnectorRow = typeof connectors.$inferSelect;
export type NewConnectorRow = typeof connectors.$inferInsert;
