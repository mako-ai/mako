/**
 * MongoDB Tools for Agent V2
 * Using plain tool definitions to avoid complex type inference
 */

import { z } from "zod";
import { Types } from "mongoose";
import { DatabaseConnection } from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import type { ConsoleDataV2 } from "../types";
import { createConsoleToolsV2 } from "./console-tools";

// Truncation constants for preventing context overflow
const MAX_STRING_LENGTH = 200;
const MAX_ARRAY_ITEMS = 5;
const MAX_OBJECT_KEYS = 10;
const MAX_NESTED_DEPTH = 3;
const MAX_SAMPLE_DOCS_RETURNED = 5;
const MAX_TOTAL_OUTPUT_SIZE = 50000;

const inferBsonType = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (
    typeof value === "object" &&
    value !== null &&
    "_bsontype" in value &&
    (value as { _bsontype: string })._bsontype === "ObjectId"
  ) {
    return "objectId";
  }
  if (value instanceof Date) return "date";
  if (
    typeof value === "object" &&
    value !== null &&
    "_bsontype" in value &&
    (value as { _bsontype: string })._bsontype === "Decimal128"
  ) {
    return "decimal";
  }
  if (typeof value === "object") return "object";
  return typeof value;
};

const truncateValue = (value: unknown, depth = 0): unknown => {
  if (depth > MAX_NESTED_DEPTH) return "[nested too deep]";
  if (value === null || value === undefined) return value;

  // Handle BSON types
  if (
    typeof value === "object" &&
    value !== null &&
    "_bsontype" in value &&
    (value as { _bsontype: string })._bsontype === "ObjectId"
  ) {
    return String(value);
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "_bsontype" in value &&
    (value as { _bsontype: string })._bsontype === "Decimal128"
  ) {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();

  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) {
      return (
        value.substring(0, MAX_STRING_LENGTH) +
        `... [truncated, ${value.length} chars total]`
      );
    }
    return value;
  }

  if (Array.isArray(value)) {
    const truncatedArray: unknown[] = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map(item => truncateValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      truncatedArray.push(`[... ${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return truncatedArray;
  }

  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value);
    const truncatedObj: Record<string, unknown> = {};
    const keysToInclude = keys.slice(0, MAX_OBJECT_KEYS);

    for (const key of keysToInclude) {
      truncatedObj[key] = truncateValue(
        (value as Record<string, unknown>)[key],
        depth + 1,
      );
    }

    if (keys.length > MAX_OBJECT_KEYS) {
      truncatedObj["_truncated"] =
        `${keys.length - MAX_OBJECT_KEYS} more keys omitted`;
    }

    return truncatedObj;
  }

  return value;
};

const truncateDocument = (doc: unknown): unknown => truncateValue(doc, 0);

const truncateQueryResults = (results: unknown): unknown => {
  if (!results) return results;

  if (Array.isArray(results)) {
    const maxResults = 100;
    const truncated = results
      .slice(0, maxResults)
      .map((doc: unknown) => truncateDocument(doc));
    if (results.length > maxResults) {
      return {
        data: truncated,
        _truncated: true,
        _message: `Showing ${maxResults} of ${results.length} results.`,
      };
    }
    return truncated;
  }

  if (typeof results === "object" && results !== null) {
    const resultsObj = results as Record<string, unknown>;
    if (resultsObj.data && Array.isArray(resultsObj.data)) {
      const truncatedData = truncateQueryResults(resultsObj.data);
      if (
        truncatedData &&
        typeof truncatedData === "object" &&
        !Array.isArray(truncatedData) &&
        (truncatedData as Record<string, unknown>).data
      ) {
        return { ...resultsObj, ...(truncatedData as Record<string, unknown>) };
      }
      return { ...resultsObj, data: truncatedData };
    }
    return truncateDocument(results);
  }

  return results;
};

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
      description: "",
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
  const SAMPLE_SIZE = 100;
  const sampleDocuments = await collection
    .aggregate([{ $sample: { size: SAMPLE_SIZE } }])
    .toArray();

  const fieldTypeMap: Record<string, Set<string>> = {};
  for (const doc of sampleDocuments) {
    for (const [field, value] of Object.entries(doc)) {
      if (!fieldTypeMap[field]) fieldTypeMap[field] = new Set<string>();
      fieldTypeMap[field].add(inferBsonType(value));
    }
  }
  const schema = Object.entries(fieldTypeMap).map(([field, types]) => ({
    field,
    types: Array.from(types),
  }));

  const truncatedSamples = sampleDocuments
    .slice(0, MAX_SAMPLE_DOCS_RETURNED)
    .map((doc: unknown) => truncateDocument(doc));

  let output = {
    schema,
    sampleDocuments: truncatedSamples,
    totalSampled: sampleDocuments.length,
    _note: `Showing ${truncatedSamples.length} truncated samples.`,
  };

  const outputSize = JSON.stringify(output).length;
  if (outputSize > MAX_TOTAL_OUTPUT_SIZE) {
    output = {
      schema,
      sampleDocuments: (truncatedSamples as unknown[]).slice(0, 2),
      totalSampled: sampleDocuments.length,
      _note: `Output was too large. Reduced to 2 samples.`,
    };
  }

  return output;
}

async function executeQueryImpl(
  query: string,
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

  const result = await databaseConnectionService.executeQuery(
    database as Parameters<typeof databaseConnectionService.executeQuery>[0],
    query,
    { databaseName },
  );

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
  consoles: ConsoleDataV2[],
  preferredConsoleId?: string,
) => {
  const consoleTools = createConsoleToolsV2(consoles, preferredConsoleId);

  return {
    ...consoleTools,

    list_connections: {
      description:
        "Return a list of all active MongoDB connections available for the current workspace.",
      inputSchema: emptySchema,
      execute: async () => listMongoConnectionsImpl(workspaceId),
    },

    list_databases: {
      description:
        "List logical databases available on the MongoDB server for a specific connection.",
      inputSchema: connectionIdSchema,
      execute: async (params: { connectionId: string }) =>
        listMongoDatabasesImpl(params.connectionId, workspaceId),
    },

    list_collections: {
      description:
        "Return a list of collections for the provided connection and database.",
      inputSchema: connectionAndDbSchema,
      execute: async (params: { connectionId: string; databaseName: string }) =>
        listCollectionsImpl(
          params.connectionId,
          params.databaseName,
          workspaceId,
        ),
    },

    inspect_collection: {
      description:
        "Sample documents from a collection to infer field names and BSON data types. Returns the sample set and a schema summary.",
      inputSchema: inspectCollectionSchema,
      execute: async (params: {
        connectionId: string;
        collectionName: string;
        databaseName: string;
      }) =>
        inspectCollectionImpl(
          params.connectionId,
          params.collectionName,
          params.databaseName,
          workspaceId,
        ),
    },

    execute_query: {
      description:
        "Execute an arbitrary MongoDB query and return the results. The query should be written in JavaScript using MongoDB Node.js driver syntax.",
      inputSchema: executeQuerySchema,
      execute: async (params: {
        query: string;
        connectionId: string;
        databaseName: string;
      }) =>
        executeQueryImpl(
          params.query,
          params.connectionId,
          params.databaseName,
          workspaceId,
        ),
    },
  };
};
