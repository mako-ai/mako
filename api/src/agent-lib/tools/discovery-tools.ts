/**
 * Unified data-discovery tools.
 *
 * One `list_databases` / `list_tables` / `inspect_table` family that
 * dispatches on the connection's type (MongoDB vs SQL), replacing the
 * per-engine `sql_*` / `mongo_*` discovery pairs in the in-product agent's
 * working set. Execution stays split (`sql_execute_query` /
 * `mongo_execute_query`) because MongoDB's write-scope gate has no SQL
 * equivalent. The old namespaced tools remain registered as deferred
 * aliases for existing chats and external MCP clients.
 */

import { tool } from "ai";
import { z } from "zod";
import { DatabaseConnection } from "../../database/workspace-schema";
import type { AgentToolExecutionContext } from "../../agents/types";
import {
  AGENT_QUERY_TIMEOUT_MS,
  isAgentToolAbortError,
} from "./shared/truncation";
import { ensureValidObjectId } from "./shared/sql-dialects";
import {
  listSqlDatabasesImpl,
  listSqlTablesImpl,
  inspectSqlTableImpl,
} from "./sql-tools";
import {
  listMongoDatabasesImpl,
  listMongoCollectionsImpl,
  inspectMongoCollectionImpl,
} from "./mongodb-tools";

const connectionIdSchema = z.object({
  connectionId: z.string().describe("The connection ID"),
});

const connectionAndDbSchema = z.object({
  connectionId: z.string().describe("The connection ID"),
  database: z.string().describe("The database/dataset name"),
});

const inspectTableSchema = z.object({
  connectionId: z.string().describe("The connection ID"),
  database: z.string().describe("The database/dataset name"),
  table: z
    .string()
    .describe(
      "The table, view, or collection name (may include a schema prefix for Postgres)",
    ),
});

/** Resolve the connection's type so discovery can dispatch mongo vs SQL. */
async function isMongoConnection(
  connectionId: string,
  workspaceId: string,
): Promise<boolean> {
  const connection = await DatabaseConnection.findOne(
    {
      _id: ensureValidObjectId(connectionId, "connectionId"),
      workspaceId: ensureValidObjectId(workspaceId, "workspaceId"),
    },
    { type: 1 },
  );
  if (!connection) {
    throw new Error("Database connection not found or access denied");
  }
  return connection.type === "mongodb";
}

export const createUnifiedDiscoveryTools = (
  workspaceId: string,
  toolExecutionContext?: AgentToolExecutionContext,
) => {
  return {
    list_databases: tool({
      description:
        "List databases in a connection of any type (MongoDB databases, " +
        "Postgres/MySQL databases, BigQuery datasets, SQLite/D1 files). SQL " +
        "results include sqlDialect. IMPORTANT for Cloudflare D1: use the " +
        "returned 'id' (UUID), not 'name', in subsequent calls.",
      inputSchema: connectionIdSchema,
      execute: async ({ connectionId }) => {
        try {
          return (await isMongoConnection(connectionId, workspaceId))
            ? await listMongoDatabasesImpl(
                connectionId,
                workspaceId,
                toolExecutionContext,
              )
            : await listSqlDatabasesImpl(
                connectionId,
                workspaceId,
                toolExecutionContext,
              );
        } catch (error) {
          return {
            success: false,
            error: isAgentToolAbortError(error)
              ? "Database listing cancelled because the chat stopped."
              : error instanceof Error
                ? error.message
                : "Failed to list databases",
          };
        }
      },
    }),

    list_tables: tool({
      description:
        "List tables and views (SQL) or collections (MongoDB) in a database. " +
        "Postgres names may be schema-prefixed ('analytics.events'). For " +
        "Cloudflare D1 pass the UUID from list_databases 'id' as database.",
      inputSchema: connectionAndDbSchema,
      execute: async ({ connectionId, database }) => {
        try {
          return (await isMongoConnection(connectionId, workspaceId))
            ? await listMongoCollectionsImpl(
                connectionId,
                database,
                workspaceId,
                toolExecutionContext,
              )
            : await listSqlTablesImpl(
                connectionId,
                database,
                workspaceId,
                toolExecutionContext,
              );
        } catch (error) {
          return {
            success: false,
            error: isAgentToolAbortError(error)
              ? "Table listing cancelled because the chat stopped."
              : error instanceof Error
                ? error.message
                : "Failed to list tables",
          };
        }
      },
    }),

    inspect_table: tool({
      description:
        "Get the schema (column/field types, nullability, sqlDialect for SQL) " +
        "plus up to 25 sample rows/documents for a table, view, or MongoDB " +
        "collection. For Cloudflare D1 pass the UUID from list_databases 'id' " +
        "as database.",
      inputSchema: inspectTableSchema,
      execute: async ({ connectionId, database, table }) => {
        try {
          return (await isMongoConnection(connectionId, workspaceId))
            ? await inspectMongoCollectionImpl(
                connectionId,
                table,
                database,
                workspaceId,
                toolExecutionContext,
              )
            : await inspectSqlTableImpl(
                connectionId,
                database,
                table,
                workspaceId,
                toolExecutionContext,
              );
        } catch (error) {
          const isTimeout =
            error instanceof Error && error.message === "AGENT_QUERY_TIMEOUT";
          return {
            success: false,
            error: isAgentToolAbortError(error)
              ? "Inspection cancelled because the chat stopped."
              : isTimeout
                ? `Inspection timed out after ${AGENT_QUERY_TIMEOUT_MS / 1000}s. The table or collection may be very large or the database is slow. Try a targeted query with sql_execute_query / mongo_execute_query instead.`
                : error instanceof Error
                  ? error.message
                  : "Failed to inspect table",
          };
        }
      },
    }),
  };
};
