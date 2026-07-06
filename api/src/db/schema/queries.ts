import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { workspaces } from "./workspaces";
import { databaseConnections } from "./connections";
import { savedConsoles } from "./consoles";

/**
 * Query-execution domain (was Mongo `query_executions`). Append-only audit log
 * of executed queries (had a 90d TTL in Mongo — see migrate runner notes for
 * the Postgres retention strategy).
 */

export const queryExecutions = pgTable(
  "query_executions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The Mongo model's primary timestamp (`executedAt`), not row insert time. */
    executedAt: timestamp("executed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    userId: uuid("user_id"),
    apiKeyId: uuid("api_key_id"),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(
      () => databaseConnections.id,
      { onDelete: "set null" },
    ),
    /** For multi-database connections (D1, clusters). */
    databaseName: text("database_name"),
    consoleId: uuid("console_id").references(() => savedConsoles.id, {
      onDelete: "set null",
    }),
    source: text("source"),
    databaseType: text("database_type"),
    queryLanguage: text("query_language"),
    status: text("status"),
    rowCount: bigint("row_count", { mode: "number" }),
    durationMs: bigint("duration_ms", { mode: "number" }),
    /** BigQuery / ClickHouse report this (was `bytesScanned` in Mongo). */
    bytesScanned: bigint("bytes_scanned", { mode: "number" }),
    /** If failed: syntax, connection, timeout, permission (was `errorType`). */
    errorType: text("error_type"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    index("query_executions_workspace_idx").on(
      table.workspaceId,
      table.executedAt,
    ),
    index("query_executions_connection_idx").on(table.connectionId),
    index("query_executions_console_idx").on(table.consoleId),
    index("query_executions_executed_at_idx").on(table.executedAt),
  ],
);

export type QueryExecutionRow = typeof queryExecutions.$inferSelect;
export type NewQueryExecutionRow = typeof queryExecutions.$inferInsert;
