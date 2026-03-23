/**
 * Universal Tools for Agent
 *
 * This version uses client-side console tools for better responsiveness
 * and accuracy. Console tools (read, modify, create) are executed on the
 * client via the onToolCall callback.
 */

import { z } from "zod";
import { Types } from "mongoose";
import { DatabaseConnection } from "../../database/workspace-schema";
import type { ConsoleDataV2 } from "../types";
import { clientConsoleTools } from "./console-tools-client";
import { clientChartTools } from "./chart-tools-client";
import { createMongoToolsV2 } from "./mongodb-tools";
import { createSqlToolsV2 } from "./sql-tools";
import { canUserSeeDatabase } from "../../services/database-access.service";

const emptySchema = z.object({});

// All supported connection types
const SUPPORTED_CONNECTION_TYPES = new Set([
  // MongoDB
  "mongodb",
  // PostgreSQL and Redshift (PostgreSQL wire-compatible)
  "postgresql",
  "redshift",
  "cloudsql-postgres",
  // BigQuery
  "bigquery",
  // Cloudflare D1
  "cloudflare-d1",
]);

async function listAllConnectionsImpl(workspaceId: string, userId?: string) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new Error("Invalid workspace ID");
  }

  const databases = await DatabaseConnection.find({
    workspaceId: new Types.ObjectId(workspaceId),
    type: { $in: Array.from(SUPPORTED_CONNECTION_TYPES) },
  }).sort({ name: 1 });

  return databases
    .filter(db => canUserSeeDatabase(db, userId))
    .map(db => {
      const connection: Record<string, unknown> =
        (db as unknown as { connection: Record<string, unknown> }).connection ||
        {};

      if (db.type === "mongodb") {
        const databaseName = (connection.database as string) || undefined;
        const displayInfo = databaseName || "Unknown Database";
        return {
          id: db._id.toString(),
          name: db.name,
          type: db.type,
          databaseName,
          displayName: `${db.name} (mongodb: ${displayInfo})`,
          active: true,
        };
      }

      if (db.type === "bigquery") {
        const project = (connection.project_id as string) || undefined;
        const displayInfo = project || "Unknown Project";
        return {
          id: db._id.toString(),
          name: db.name,
          type: db.type,
          sqlDialect: "bigquery",
          project,
          displayName: `${db.name} (bigquery: ${displayInfo})`,
          active: true,
        };
      }

      if (
        db.type === "postgresql" ||
        db.type === "redshift" ||
        db.type === "cloudsql-postgres"
      ) {
        const host = (connection.host || connection.instanceConnectionName) as
          | string
          | undefined;
        const databaseName = (connection.database || connection.db) as
          | string
          | undefined;
        const displayInfo = `${host || "unknown-host"}/${databaseName || "unknown-db"}`;
        return {
          id: db._id.toString(),
          name: db.name,
          type: db.type,
          sqlDialect: "postgresql",
          host,
          databaseName,
          displayName: `${db.name} (postgresql: ${displayInfo})`,
          active: true,
        };
      }

      if (db.type === "sqlite" || db.type === "cloudflare-d1") {
        const databaseId = (connection.database_id as string) || "main";
        return {
          id: db._id.toString(),
          name: db.name,
          type: db.type,
          sqlDialect: "sqlite",
          databaseId,
          displayName: `${db.name} (sqlite: ${databaseId})`,
          active: true,
        };
      }

      // Fallback for any new types
      return {
        id: db._id.toString(),
        name: db.name,
        type: db.type,
        displayName: `${db.name} (${db.type})`,
        active: true,
      };
    });
}

/**
 * Create a unified toolset for the universal agent with client-side console tools.
 *
 * Client-side tools (handled via onToolCall on frontend):
 * - read_console
 * - modify_console
 * - create_console
 *
 * Server-side tools (executed on server):
 * - list_connections (cross-database discovery)
 * - MongoDB tools (mongo_*)
 * - SQL tools (sql_*) - supports PostgreSQL, BigQuery, SQLite, Cloudflare D1
 */
export const createUniversalTools = (
  workspaceId: string,
  consoles: ConsoleDataV2[],
  preferredConsoleId?: string,
  userId?: string,
) => {
  // Get MongoDB tools and extract just the database-specific ones
  const mongoTools = createMongoToolsV2(
    workspaceId,
    consoles,
    preferredConsoleId,
    userId,
  );
  const {
    // Strip console tools (we use client-side versions)
    modify_console: _mongoModify,
    read_console: _mongoRead,
    create_console: _mongoCreate,
    // MongoDB tools (to be namespaced)
    list_connections: mongoListConnections,
    list_databases: mongoListDatabases,
    list_collections: mongoListCollections,
    inspect_collection: mongoInspectCollection,
    execute_query: mongoExecuteQuery,
  } = mongoTools;

  // Get SQL tools and extract just the database-specific ones
  const sqlTools = createSqlToolsV2(
    workspaceId,
    consoles,
    preferredConsoleId,
    userId,
  );
  const {
    // Strip console tools
    modify_console: _sqlModify,
    read_console: _sqlRead,
    create_console: _sqlCreate,
    // SQL tools (already namespaced as sql_*)
    ...sqlOnlyTools
  } = sqlTools;

  return {
    // Client-side console tools (no execute function - handled by frontend)
    ...clientConsoleTools,

    // Client-side chart tools (no execute function - handled by frontend)
    ...clientChartTools,

    // Cross-database connection discovery (server-side)
    list_connections: {
      description:
        "List all database connections in this workspace (MongoDB, PostgreSQL, Redshift, BigQuery, SQLite, Cloudflare D1). Use this to discover available databases before running queries.",
      inputSchema: emptySchema,
      execute: async () => listAllConnectionsImpl(workspaceId, userId),
    },

    // MongoDB tools (namespaced with mongo_ prefix) - server-side
    mongo_list_connections: mongoListConnections,
    mongo_list_databases: mongoListDatabases,
    mongo_list_collections: mongoListCollections,
    mongo_inspect_collection: mongoInspectCollection,
    mongo_execute_query: mongoExecuteQuery,

    // SQL tools (already namespaced with sql_ prefix) - server-side
    ...sqlOnlyTools,
  };
};
