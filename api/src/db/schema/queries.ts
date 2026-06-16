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
    userId: uuid("user_id"),
    apiKeyId: uuid("api_key_id"),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(
      () => databaseConnections.id,
      { onDelete: "set null" },
    ),
    consoleId: uuid("console_id").references(() => savedConsoles.id, {
      onDelete: "set null",
    }),
    source: text("source"),
    databaseType: text("database_type"),
    queryLanguage: text("query_language"),
    status: text("status"),
    rowCount: bigint("row_count", { mode: "number" }),
    durationMs: bigint("duration_ms", { mode: "number" }),
    bytesProcessed: bigint("bytes_processed", { mode: "number" }),
    error: text("error"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    index("query_executions_workspace_idx").on(table.workspaceId),
    index("query_executions_connection_idx").on(table.connectionId),
    index("query_executions_console_idx").on(table.consoleId),
    index("query_executions_created_at_idx").on(table.createdAt),
  ],
);

export type QueryExecutionRow = typeof queryExecutions.$inferSelect;
export type NewQueryExecutionRow = typeof queryExecutions.$inferInsert;
