/**
 * Universal Tools for Agent V2
 * A single tool surface that supports MongoDB + Postgres + BigQuery without handoffs.
 */

import { z } from "zod";
import { Types } from "mongoose";
import { DatabaseConnection } from "../../database/workspace-schema";
import type { ConsoleDataV2 } from "../types";
import { createConsoleToolsV2 } from "./console-tools";
import { createMongoToolsV2 } from "./mongodb-tools";
import { createPostgresToolsV2 } from "./postgres-tools";
import { createBigQueryToolsV2 } from "./bigquery-tools";

const emptySchema = z.object({});

const POSTGRES_TYPES = new Set(["postgresql", "cloudsql-postgres"]);
const SUPPORTED_CONNECTION_TYPES = new Set([
  "mongodb",
  "bigquery",
  ...Array.from(POSTGRES_TYPES),
]);

async function listAllConnectionsImpl(workspaceId: string) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new Error("Invalid workspace ID");
  }

  const databases = await DatabaseConnection.find({
    workspaceId: new Types.ObjectId(workspaceId),
    type: { $in: Array.from(SUPPORTED_CONNECTION_TYPES) },
  }).sort({ name: 1 });

  return databases.map(db => {
    const connection: any = (db as any).connection || {};

    if (db.type === "mongodb") {
      const databaseName = connection.database || undefined;
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
      const project = connection.project_id || undefined;
      const displayInfo = project || "Unknown Project";
      return {
        id: db._id.toString(),
        name: db.name,
        type: db.type,
        project,
        displayName: `${db.name} (bigquery: ${displayInfo})`,
        active: true,
      };
    }

    if (POSTGRES_TYPES.has(db.type)) {
      const host =
        connection.host || connection.instanceConnectionName || undefined;
      const databaseName = connection.database || connection.db || undefined;
      const displayInfo = `${host || "unknown-host"}/${databaseName || "unknown-database"}`;
      return {
        id: db._id.toString(),
        name: db.name,
        type: db.type,
        host,
        databaseName,
        displayName: `${db.name} (${db.type}: ${displayInfo})`,
        active: true,
      };
    }

    // Should be unreachable due to SUPPORTED_CONNECTION_TYPES filter
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
 * Create a unified toolset for a single universal agent.
 *
 * Notes:
 * - Console tools are included once.
 * - Mongo tools are exposed under `mongo_*` aliases to avoid generic-name collisions.
 * - Postgres tools are already `pg_*`; BigQuery tools are already `bq_*`.
 */
export const createUniversalToolsV2 = (
  workspaceId: string,
  consoles: ConsoleDataV2[],
  preferredConsoleId?: string,
) => {
  const consoleTools = createConsoleToolsV2(consoles, preferredConsoleId);

  const mongoTools = createMongoToolsV2(
    workspaceId,
    consoles,
    preferredConsoleId,
  );
  const {
    // strip console tools (we provide them once)
    modify_console: _mongoModify,
    read_console: _mongoRead,
    create_console: _mongoCreate,
    // mongo tools (to be namespaced)
    list_connections: mongoListConnections,
    list_databases: mongoListDatabases,
    list_collections: mongoListCollections,
    inspect_collection: mongoInspectCollection,
    execute_query: mongoExecuteQuery,
  } = mongoTools;

  const pgTools = createPostgresToolsV2(
    workspaceId,
    consoles,
    preferredConsoleId,
  );
  const {
    // strip console tools
    modify_console: _pgModify,
    read_console: _pgRead,
    create_console: _pgCreate,
    ...pgOnlyTools
  } = pgTools;

  const bqTools = createBigQueryToolsV2(
    workspaceId,
    consoles,
    preferredConsoleId,
  );
  const {
    // strip console tools
    modify_console: _bqModify,
    read_console: _bqRead,
    create_console: _bqCreate,
    ...bqOnlyTools
  } = bqTools;

  return {
    ...consoleTools,

    list_connections: {
      description:
        "List all available database connections in this workspace (MongoDB, Postgres, BigQuery). Use this when the console is not attached to a database and you need to choose where the data lives.",
      inputSchema: emptySchema,
      execute: async () => listAllConnectionsImpl(workspaceId),
    },

    // MongoDB tools (namespaced)
    mongo_list_connections: mongoListConnections,
    mongo_list_databases: mongoListDatabases,
    mongo_list_collections: mongoListCollections,
    mongo_inspect_collection: mongoInspectCollection,
    mongo_execute_query: mongoExecuteQuery,

    // Postgres tools (namespaced already)
    ...pgOnlyTools,

    // BigQuery tools (namespaced already)
    ...bqOnlyTools,
  };
};
