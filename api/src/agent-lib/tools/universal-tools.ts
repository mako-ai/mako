/**
 * Universal Tools for Agent
 *
 * This version uses client-side console tools for better responsiveness
 * and accuracy. Console tools (read, modify, create) are executed on the
 * client via the onToolCall callback.
 */

import { tool } from "ai";
import { z } from "zod";
import { Types } from "mongoose";
import {
  Connector as SourceConnection,
  DatabaseConnection,
} from "../../database/workspace-schema";
import type { AgentToolExecutionContext } from "../../agents/types";
import type { ConsoleDataV2 } from "../types";
import {
  clientConsoleTools,
  clientChartTools,
  clientScreenshotTools,
} from "@mako/agent-tools";
import { createMongoToolsV2 } from "./mongodb-tools";
import { createSqlToolsV2 } from "./sql-tools";
import { createUnifiedDiscoveryTools } from "./discovery-tools";
import { createServerConsoleTools } from "./server-console-tools";
import {
  ALL_SUPPORTED_TYPES,
  getSqlDialectOrNull,
} from "./shared/sql-dialects";

/**
 * Summarize one connection document for list_connections. Exported for tests.
 * Dialects come from the shared registry (shared/sql-dialects), so any SQL
 * engine the sql_* tools can query is also discoverable here — keeping this
 * list and the sql_* tool surface from drifting apart (MySQL was missing
 * from a hand-rolled copy of this list before).
 */
export function summarizeConnectionForListing(db: {
  _id: { toString(): string };
  name: string;
  type: string;
  connection?: Record<string, unknown>;
}): Record<string, unknown> {
  const connection: Record<string, unknown> = db.connection || {};

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

  const sqlDialect = getSqlDialectOrNull(db.type);

  if (sqlDialect === "bigquery") {
    const project = (connection.project_id as string) || undefined;
    const displayInfo = project || "Unknown Project";
    return {
      id: db._id.toString(),
      name: db.name,
      type: db.type,
      sqlDialect,
      project,
      displayName: `${db.name} (bigquery: ${displayInfo})`,
      active: true,
    };
  }

  if (sqlDialect === "postgresql" || sqlDialect === "mysql") {
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
      sqlDialect,
      host,
      databaseName,
      displayName: `${db.name} (${sqlDialect}: ${displayInfo})`,
      active: true,
    };
  }

  if (sqlDialect === "sqlite") {
    const databaseId = (connection.database_id as string) || "main";
    return {
      id: db._id.toString(),
      name: db.name,
      type: db.type,
      sqlDialect,
      databaseId,
      displayName: `${db.name} (sqlite: ${databaseId})`,
      active: true,
    };
  }

  // Remaining SQL dialects (ClickHouse, MSSQL) and any new types.
  return {
    id: db._id.toString(),
    name: db.name,
    type: db.type,
    ...(sqlDialect ? { sqlDialect } : {}),
    displayName: `${db.name} (${sqlDialect ?? db.type})`,
    active: true,
  };
}

export type ConnectionKind = "database" | "source";

/**
 * Every connection in the workspace, of both kinds.
 *
 * A CONNECTION is a credential configured with a CONNECTOR (the code). A
 * `database` connection (BigQuery, Postgres, MongoDB, …) is what the sql_* /
 * mongo_* tools query and what a flow writes to; a `source` connection (a
 * Stripe key, a Vercel key, …) is what a flow reads from and what
 * probe_connection reads live. Both carry `kind` and `connector` so an agent
 * never has to guess which tool a given id belongs to.
 *
 * Source rows are read through a projection that never loads `config`: the
 * model decrypts it on read via a getter, so loading it is leaking it.
 */
export async function listAllConnectionsImpl(
  workspaceId: string,
  kind: ConnectionKind | "all" = "all",
) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new Error("Invalid workspace ID");
  }
  const wsId = new Types.ObjectId(workspaceId);

  const databases =
    kind === "source"
      ? []
      : (
          await DatabaseConnection.find({
            workspaceId: wsId,
            type: { $in: Array.from(ALL_SUPPORTED_TYPES) },
          }).sort({ name: 1 })
        ).map(db => ({
          ...summarizeConnectionForListing(
            db as unknown as Parameters<
              typeof summarizeConnectionForListing
            >[0],
          ),
          kind: "database" as const,
          connector: (db as { type: string }).type,
          queryable: true,
        }));

  const sources =
    kind === "database"
      ? []
      : (
          (await SourceConnection.find({ workspaceId: wsId })
            .select("_id name type description isActive")
            .sort({ name: 1 })
            .lean()) as Array<{
            _id: { toString(): string };
            name?: string;
            type?: string;
            description?: string;
            isActive?: boolean;
          }>
        ).map(row => ({
          id: row._id.toString(),
          name: row.name ?? "",
          type: row.type ?? "",
          kind: "source" as const,
          connector: row.type ?? "",
          description: row.description ?? "",
          displayName: `${row.name ?? ""} (source: ${row.type ?? "?"} — sync or probe_connection, not SQL)`,
          active: row.isActive !== false,
          queryable: false,
        }));

  return [...databases, ...sources];
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
 * - SQL tools (sql_*) - supports PostgreSQL, MySQL, BigQuery, SQLite, Cloudflare D1
 */
export const createUniversalTools = (
  workspaceId: string,
  consoles: ConsoleDataV2[],
  preferredConsoleId?: string,
  userId?: string,
  toolExecutionContext?: AgentToolExecutionContext,
  options?: { chatId?: string },
) => {
  // Get MongoDB tools and extract just the database-specific ones
  const mongoTools = createMongoToolsV2(
    workspaceId,
    consoles,
    preferredConsoleId,
    userId,
    toolExecutionContext,
  );
  const {
    // MongoDB tools (to be namespaced)
    list_connections: mongoListConnections,
    list_databases: mongoListDatabases,
    list_collections: mongoListCollections,
    inspect_collection: mongoInspectCollection,
    execute_query: mongoExecuteQuery,
  } = mongoTools;

  // SQL tools (already namespaced as sql_*)
  const sqlOnlyTools = createSqlToolsV2(
    workspaceId,
    consoles,
    preferredConsoleId,
    userId,
    toolExecutionContext,
  );

  return {
    // Console tools — execute SERVER-SIDE against the authoritative draft
    // (issue #475). Open windows follow along via the realtime channel, and
    // detached chats keep working because the stream no longer splits.
    ...createServerConsoleTools({
      workspaceId,
      userId,
      executionContext: toolExecutionContext,
      chatId: options?.chatId,
    }),

    // Remaining client-side console tool: listing OPEN TABS is inherently a
    // browser question (the server source of truth is search_consoles).
    ...clientConsoleTools,

    // Client-side chart tools (no execute function - handled by frontend)
    ...clientChartTools,

    // Client-side visual inspection tool (no execute function - handled by frontend)
    ...clientScreenshotTools,

    // Cross-database connection discovery (server-side)
    list_connections: tool({
      description: [
        "List the CONNECTIONS configured in this workspace — every credential, of both kinds. `kind: database` (MongoDB, PostgreSQL, MySQL, Redshift, BigQuery, ClickHouse, SQLite, Cloudflare D1, MSSQL) is what list_tables / inspect_table / sql_execute_query work on and what a flow writes to. `kind: source` (a Stripe key, a Close account, a workspace connector's key, …) is what a flow reads from and what probe_connection reads live; it cannot be queried with SQL.",
        "Each row carries `kind` and `connector` (the code it was configured with, e.g. `bigquery`, `stripe`, `ws:vercel-ai-gateway`). Filter with `kind`; default is both. list_connectors is the catalog of what CAN be configured.",
      ].join("\n"),
      inputSchema: z.object({
        kind: z
          .enum(["database", "source", "all"])
          .optional()
          .describe("Which connections to list (default: all)."),
      }),
      execute: async ({ kind }: { kind?: ConnectionKind | "all" }) => {
        try {
          return await listAllConnectionsImpl(workspaceId, kind ?? "all");
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to list connections",
          };
        }
      },
    }),

    // Unified discovery family (server-side): dispatches on connection type
    // (MongoDB vs SQL). This is the primary discovery surface; the namespaced
    // mongo_*/sql_* discovery tools below stay registered as deferred aliases.
    ...createUnifiedDiscoveryTools(workspaceId, toolExecutionContext),

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
