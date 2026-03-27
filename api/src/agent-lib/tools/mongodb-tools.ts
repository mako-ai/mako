/**
 * MongoDB Tools for Agent V2
 * Using plain tool definitions to avoid complex type inference
 */

import { z } from "zod";
import { Types } from "mongoose";
import { DatabaseConnection } from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import { queryExecutionService } from "../../services/query-execution.service";
import type { ConsoleDataV2 } from "../types";
import { clientConsoleTools } from "./console-tools-client";
import {
  inferBsonType,
  truncateSamples,
  truncateQueryResults,
  MAX_SAMPLE_ROWS,
  MAX_TOTAL_OUTPUT_SIZE,
} from "./shared/truncation";

// Define schemas separately to avoid inline inference overhead
const emptySchema = z.object({});
const connectionIdSchema = z.object({
  connectionId: z.string().describe("The connection ID"),
});
const connectionAndDbSchema = z.object({
  connectionId: z.string().describe("The connection ID"),
  databaseName: z.string().describe("The target database name"),
});
const inspectCollectionSchema = z.object({
  connectionId: z.string().describe("The connection ID"),
  collectionName: z.string().describe("The collection name to inspect"),
  databaseName: z.string().describe("The target database name"),
});
const executeQuerySchema = z.object({
  query: z.string().describe("The MongoDB query to execute"),
  connectionId: z.string().describe("The target connection ID"),
  databaseName: z.string().describe("The target database name"),
});

const AGENT_QUERY_TIMEOUT_MS = 15_000;

// Helper implementations
async function listMongoConnectionsImpl(workspaceId: string) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new Error("Invalid workspace ID");
  }
  const databases = await DatabaseConnection.find({
    workspaceId: new Types.ObjectId(workspaceId),
  }).sort({ name: 1 });

  return databases
    .filter(db => db.type === "mongodb")
    .map(db => ({
      id: db._id.toString(),
      name: db.name,
      databaseName: (db as unknown as { connection: { database?: string } })
        .connection?.database,
      type: db.type,
      active: true,
      displayName:
        (db as unknown as { connection: { database?: string } }).connection
          ?.database ||
        db.name ||
        "Unknown Database",
    }));
}

async function listMongoDatabasesImpl(
  connectionId: string,
  workspaceId: string,
) {
  if (
    !Types.ObjectId.isValid(connectionId) ||
    !Types.ObjectId.isValid(workspaceId)
  ) {
    throw new Error("Invalid connection ID or workspace ID");
  }
  const database = await DatabaseConnection.findOne({
    _id: new Types.ObjectId(connectionId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!database) throw new Error("Connection not found or access denied");
  if (database.type !== "mongodb") {
    throw new Error("Database listing only supported for MongoDB connections");
  }

  const connection = await databaseConnectionService.getConnection(
    database as Parameters<typeof databaseConnectionService.getConnection>[0],
  );
  const adminDb = connection.db("admin");
  const result = await adminDb.admin().listDatabases();

  return result.databases.map(
    (db: { name: string; sizeOnDisk?: number; empty?: boolean }) => ({
      name: db.name,
      sizeOnDisk: db.sizeOnDisk,
      empty: db.empty,
    }),
  );
}

async function listCollectionsImpl(
  connectionId: string,
  databaseName: string,
  workspaceId: string,
) {
  if (
    !Types.ObjectId.isValid(connectionId) ||
    !Types.ObjectId.isValid(workspaceId)
  ) {
    throw new Error("Invalid connection ID or workspace ID");
  }
  if (!databaseName) {
    throw new Error("'databaseName' is required");
  }
  const database = await DatabaseConnection.findOne({
    _id: new Types.ObjectId(connectionId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!database) throw new Error("Connection not found or access denied");
  if (database.type !== "mongodb") {
    throw new Error("Collection listing only supported for MongoDB databases");
  }
  const connection = await databaseConnectionService.getConnection(
    database as Parameters<typeof databaseConnectionService.getConnection>[0],
  );
  const db = connection.db(databaseName);
  const collections = await db
    .listCollections({ type: "collection" })
    .toArray();
  return collections.map(
    (col: { name: string; type?: string; options?: unknown }) => ({
      name: col.name,
      type: col.type,
      options: col.options,
    }),
  );
}

async function inspectCollectionImpl(
  connectionId: string,
  collectionName: string,
  databaseName: string,
  workspaceId: string,
) {
  if (
    !Types.ObjectId.isValid(connectionId) ||
    !Types.ObjectId.isValid(workspaceId)
  ) {
    throw new Error("Invalid connection ID or workspace ID");
  }
  if (!databaseName) {
    throw new Error("'databaseName' is required");
  }
  const database = await DatabaseConnection.findOne({
    _id: new Types.ObjectId(connectionId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!database) throw new Error("Connection not found or access denied");
  if (database.type !== "mongodb") {
    throw new Error(
      "Collection inspection only supported for MongoDB databases",
    );
  }
  const connection = await databaseConnectionService.getConnection(
    database as Parameters<typeof databaseConnectionService.getConnection>[0],
  );
  const db = connection.db(databaseName);
  const collection = db.collection(collectionName);

  // Sample more documents for better field inference
  const SAMPLE_SIZE = 100;
  const sampleDocuments = await collection
    .aggregate([{ $sample: { size: SAMPLE_SIZE } }])
    .toArray();

  // Infer field types from samples
  const fieldTypeMap: Record<string, Set<string>> = {};
  for (const doc of sampleDocuments) {
    for (const [field, value] of Object.entries(doc)) {
      if (!fieldTypeMap[field]) fieldTypeMap[field] = new Set<string>();
      fieldTypeMap[field].add(inferBsonType(value));
    }
  }

  // Normalize output: use 'fields' instead of 'schema', 'name' instead of 'field'
  const fields = Object.entries(fieldTypeMap).map(([name, types]) => ({
    name,
    types: Array.from(types),
  }));

  // Truncate samples using shared utilities
  const { samples, _note } = truncateSamples(sampleDocuments, MAX_SAMPLE_ROWS);

  return {
    entityKind: "collection" as const,
    entityName: collectionName,
    database: databaseName,
    fields,
    samples,
    _note,
  };
}

async function executeQueryImpl(
  query: string,
  connectionId: string,
  databaseName: string,
  workspaceId: string,
  userId?: string,
) {
  const startTime = Date.now();

  if (
    !Types.ObjectId.isValid(connectionId) ||
    !Types.ObjectId.isValid(workspaceId)
  ) {
    throw new Error("Invalid connection ID or workspace ID");
  }
  if (!databaseName) {
    throw new Error("'databaseName' is required");
  }
  const database = await DatabaseConnection.findOne({
    _id: new Types.ObjectId(connectionId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!database) throw new Error("Connection not found or access denied");

  let timeoutTimer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(
      () => reject(new Error("AGENT_QUERY_TIMEOUT")),
      AGENT_QUERY_TIMEOUT_MS,
    );
  });

  let result: Awaited<
    ReturnType<typeof databaseConnectionService.executeQuery>
  >;
  try {
    result = await Promise.race([
      databaseConnectionService.executeQuery(
        database as Parameters<
          typeof databaseConnectionService.executeQuery
        >[0],
        query,
        { databaseName },
      ),
      timeoutPromise,
    ]);
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "AGENT_QUERY_TIMEOUT") {
      // Track timeout (fire-and-forget)
      if (userId) {
        queryExecutionService.track({
          userId,
          workspaceId: new Types.ObjectId(workspaceId),
          connectionId: database._id,
          databaseName,
          source: "agent",
          databaseType: database.type,
          queryLanguage: "mongodb",
          status: "timeout",
          executionTimeMs: Date.now() - startTime,
          errorType: "timeout",
        });
      }
      return {
        success: false,
        status: "timeout",
        message: `Query timed out after ${AGENT_QUERY_TIMEOUT_MS / 1000}s. The query may be valid but slow. Consider: (1) Add .limit() for exploration, (2) Narrow date range, (3) Write the full query to console and use run_console to execute in the UI where there's no timeout.`,
      };
    }
    throw err;
  } finally {
    clearTimeout(timeoutTimer!);
  }

  // Track query execution (fire-and-forget)
  if (userId) {
    const rowCount = result.success
      ? (result.rowCount ??
        (Array.isArray(result.data) ? result.data.length : undefined))
      : undefined;

    let errorType: string | undefined;
    if (!result.success) {
      const errorMsg = result.error?.toLowerCase() || "";
      if (errorMsg.includes("syntax")) {
        errorType = "syntax";
      } else if (
        errorMsg.includes("timeout") ||
        errorMsg.includes("timed out")
      ) {
        errorType = "timeout";
      } else if (
        errorMsg.includes("connection") ||
        errorMsg.includes("connect")
      ) {
        errorType = "connection";
      } else if (
        errorMsg.includes("permission") ||
        errorMsg.includes("access denied")
      ) {
        errorType = "permission";
      } else {
        errorType = "unknown";
      }
    }

    // Determine execution status based on error type
    let executionStatus: "success" | "error" | "timeout" | "cancelled" =
      result.success ? "success" : "error";
    if (!result.success && errorType === "timeout") {
      executionStatus = "timeout";
    } else if (!result.success && errorType === "cancelled") {
      executionStatus = "cancelled";
    }

    queryExecutionService.track({
      userId,
      workspaceId: new Types.ObjectId(workspaceId),
      connectionId: database._id,
      databaseName,
      source: "agent",
      databaseType: database.type,
      queryLanguage: "mongodb",
      status: executionStatus,
      executionTimeMs: Date.now() - startTime,
      rowCount,
      errorType,
    });
  }

  if (result && result.success && result.data) {
    const truncatedData = truncateQueryResults(result.data);
    const outputSize = JSON.stringify(truncatedData).length;
    if (outputSize > MAX_TOTAL_OUTPUT_SIZE) {
      return {
        ...result,
        data: Array.isArray(truncatedData)
          ? truncatedData.slice(0, 50)
          : truncatedData,
        _warning: `Results truncated. Add .limit() to your query for smaller result sets.`,
      };
    }
    return { ...result, data: truncatedData };
  }

  return result;
}

export const createMongoToolsV2 = (
  workspaceId: string,
  _consoles: ConsoleDataV2[],
  _preferredConsoleId?: string,
  userId?: string,
) => {
  return {
    ...clientConsoleTools,

    list_connections: {
      description:
        "List all MongoDB connections available in this workspace. Returns connection ID, name, and database name.",
      inputSchema: emptySchema,
      execute: async () => {
        try {
          return await listMongoConnectionsImpl(workspaceId);
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to list MongoDB connections",
          };
        }
      },
    },

    list_databases: {
      description:
        "List databases available on the MongoDB server for a specific connection.",
      inputSchema: connectionIdSchema,
      execute: async (params: { connectionId: string }) => {
        try {
          return await listMongoDatabasesImpl(params.connectionId, workspaceId);
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to list databases",
          };
        }
      },
    },

    list_collections: {
      description: "List collections in a MongoDB database.",
      inputSchema: connectionAndDbSchema,
      execute: async (params: {
        connectionId: string;
        databaseName: string;
      }) => {
        try {
          return await listCollectionsImpl(
            params.connectionId,
            params.databaseName,
            workspaceId,
          );
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to list collections",
          };
        }
      },
    },

    inspect_collection: {
      description:
        "Get collection schema (field names and BSON types) plus up to 25 sample documents. Use this to understand data structure before writing queries.",
      inputSchema: inspectCollectionSchema,
      execute: async (params: {
        connectionId: string;
        collectionName: string;
        databaseName: string;
      }) => {
        try {
          return await inspectCollectionImpl(
            params.connectionId,
            params.collectionName,
            params.databaseName,
            workspaceId,
          );
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to inspect collection",
          };
        }
      },
    },

    execute_query: {
      description:
        "Execute a MongoDB query and return results. Write queries in JavaScript using MongoDB Node.js driver syntax (e.g., db.collection('users').find({}).limit(10).toArray()).",
      inputSchema: executeQuerySchema,
      execute: async (params: {
        query: string;
        connectionId: string;
        databaseName: string;
      }) => {
        try {
          return await executeQueryImpl(
            params.query,
            params.connectionId,
            params.databaseName,
            workspaceId,
            userId,
          );
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to execute query",
          };
        }
      },
    },
  };
};
