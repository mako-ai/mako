// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – provided at runtime
import { tool } from "@openai/agents";
import { Document } from "mongodb";
import { Types } from "mongoose";
import { DatabaseConnection } from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import { createConsoleTools, ConsoleData } from "../shared/console-tools";

const listMongoConnections = async (workspaceId: string) => {
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
      databaseName: (db as any).connection.database, // Default DB
      type: db.type,
      active: true,
      displayName:
        (db as any).connection.database || db.name || "Unknown Database",
    }));
};

const listMongoDatabases = async (
  connectionId: string,
  workspaceId: string,
) => {
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
    database as any,
  );
  // List databases using admin command
  const adminDb = connection.db("admin");
  const result = await adminDb.admin().listDatabases();

  return result.databases.map((db: any) => ({
    name: db.name,
    sizeOnDisk: db.sizeOnDisk,
    empty: db.empty,
  }));
};

const listCollections = async (
  connectionId: string,
  workspaceId: string,
  databaseName: string,
) => {
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
    database as any,
  );
  const db = connection.db(databaseName);
  const collections = await db
    .listCollections({ type: "collection" })
    .toArray();
  return collections.map((col: any) => ({
    name: col.name,
    type: col.type,
    options: col.options,
  }));
};

const inferBsonType = (value: any): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value?._bsontype === "ObjectId") return "objectId";
  if (value instanceof Date) return "date";
  if (value?._bsontype === "Decimal128") return "decimal";
  if (typeof value === "object") return "object";
  return typeof value;
};

// Truncation constants for preventing context overflow
const MAX_STRING_LENGTH = 200;
const MAX_ARRAY_ITEMS = 5;
const MAX_OBJECT_KEYS = 10;
const MAX_NESTED_DEPTH = 3;
const MAX_SAMPLE_DOCS_RETURNED = 5;
const MAX_TOTAL_OUTPUT_SIZE = 50000; // ~50KB cap for the entire output

/**
 * Truncate a single value to prevent context overflow while preserving structure
 */
const truncateValue = (value: any, depth: number = 0): any => {
  if (depth > MAX_NESTED_DEPTH) {
    return "[nested too deep]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  // Handle BSON types
  if (value?._bsontype === "ObjectId") {
    return value.toString();
  }
  if (value?._bsontype === "Decimal128") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }

  // Handle strings
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) {
      return (
        value.substring(0, MAX_STRING_LENGTH) +
        `... [truncated, ${value.length} chars total]`
      );
    }
    return value;
  }

  // Handle arrays
  if (Array.isArray(value)) {
    const truncatedArray = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map(item => truncateValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      truncatedArray.push(`[... ${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return truncatedArray;
  }

  // Handle objects
  if (typeof value === "object") {
    const keys = Object.keys(value);
    const truncatedObj: Record<string, any> = {};
    const keysToInclude = keys.slice(0, MAX_OBJECT_KEYS);

    for (const key of keysToInclude) {
      truncatedObj[key] = truncateValue(value[key], depth + 1);
    }

    if (keys.length > MAX_OBJECT_KEYS) {
      truncatedObj["_truncated"] =
        `${keys.length - MAX_OBJECT_KEYS} more keys omitted`;
    }

    return truncatedObj;
  }

  // Primitives pass through
  return value;
};

/**
 * Truncate an entire document for safe inclusion in agent context
 */
const truncateDocument = (doc: any): any => {
  return truncateValue(doc, 0);
};

/**
 * Truncate query results to prevent context overflow
 */
const truncateQueryResults = (results: any): any => {
  if (!results) return results;

  // If results is an array, truncate each item and limit count
  if (Array.isArray(results)) {
    const maxResults = 100;
    const truncated = results
      .slice(0, maxResults)
      .map(doc => truncateDocument(doc));
    if (results.length > maxResults) {
      return {
        data: truncated,
        _truncated: true,
        _message: `Showing ${maxResults} of ${results.length} results. Use LIMIT in your query for specific counts.`,
      };
    }
    return truncated;
  }

  // If results is an object with data array (common pattern)
  if (results.data && Array.isArray(results.data)) {
    const truncatedData = truncateQueryResults(results.data);

    // If truncateQueryResults returned an object with metadata (due to >100 items),
    // flatten it to avoid nested { data: { data: [...], _truncated: ... } }
    if (
      truncatedData &&
      typeof truncatedData === "object" &&
      !Array.isArray(truncatedData) &&
      truncatedData.data
    ) {
      return {
        ...results,
        ...truncatedData, // Spreads data, _truncated, and _message at top level
      };
    }

    return {
      ...results,
      data: truncatedData,
    };
  }

  // Single document
  if (typeof results === "object") {
    return truncateDocument(results);
  }

  return results;
};

const inspectCollection = async (
  connectionId: string,
  collectionName: string,
  workspaceId: string,
  databaseName: string,
) => {
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
    database as any,
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

  // Truncate sample documents to prevent context overflow
  const truncatedSamples = sampleDocuments
    .slice(0, MAX_SAMPLE_DOCS_RETURNED)
    .map((doc: Document) => truncateDocument(doc));

  // Final safety check: ensure total output isn't too large
  let output = {
    schema,
    sampleDocuments: truncatedSamples,
    totalSampled: sampleDocuments.length,
    _note: `Showing ${truncatedSamples.length} truncated samples. Values longer than ${MAX_STRING_LENGTH} chars, arrays with more than ${MAX_ARRAY_ITEMS} items, and objects with more than ${MAX_OBJECT_KEYS} keys are summarized.`,
  };

  const outputSize = JSON.stringify(output).length;
  if (outputSize > MAX_TOTAL_OUTPUT_SIZE) {
    // If still too large, reduce samples further
    output = {
      schema,
      sampleDocuments: truncatedSamples.slice(0, 2),
      totalSampled: sampleDocuments.length,
      _note: `Output was too large (${outputSize} bytes). Reduced to 2 samples. Use execute_query for specific data retrieval.`,
    };
  }

  return output;
};

const executeQuery = async (
  query: string,
  connectionId: string,
  workspaceId: string,
  databaseName: string,
) => {
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
    database as any,
    query,
    { databaseName },
  );

  // Truncate results to prevent context overflow
  if (result && result.success && result.data) {
    const truncatedData = truncateQueryResults(result.data);

    // Check total size and provide warning if large
    const outputSize = JSON.stringify(truncatedData).length;
    if (outputSize > MAX_TOTAL_OUTPUT_SIZE) {
      return {
        ...result,
        data: Array.isArray(truncatedData)
          ? truncatedData.slice(0, 50)
          : truncatedData,
        _warning: `Results truncated from ${outputSize} bytes. Add .limit() to your query for smaller result sets.`,
      };
    }

    return {
      ...result,
      data: truncatedData,
    };
  }

  return result;
};

export const createMongoTools = (
  workspaceId: string,
  consoles?: ConsoleData[],
  preferredConsoleId?: string,
) => {
  const listConnectionsTool = tool({
    name: "list_connections",
    description:
      "Return a list of all active MongoDB connections available for the current workspace.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execute: async (_: any) => listMongoConnections(workspaceId),
  });

  const listDatabasesTool = tool({
    name: "list_databases",
    description:
      "List logical databases available on the MongoDB server for a specific connection.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string", description: "The connection ID" },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      listMongoDatabases(input.connectionId, workspaceId),
  });

  const listCollectionsTool = tool({
    name: "list_collections",
    description:
      "Return a list of collections for the provided connection and database.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string", description: "The connection ID" },
        databaseName: {
          type: "string",
          description:
            "The target database name (use list_databases to discover available databases)",
        },
      },
      required: ["connectionId", "databaseName"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      listCollections(input.connectionId, workspaceId, input.databaseName),
  });

  const executeQueryTool = tool({
    name: "execute_query",
    description:
      "Execute an arbitrary MongoDB query and return the results. The query should be written in JavaScript using MongoDB Node.js driver syntax.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The MongoDB query to execute" },
        connectionId: {
          type: "string",
          description: "The target connection ID",
        },
        databaseName: {
          type: "string",
          description:
            "The target database name (use list_databases to discover available databases)",
        },
      },
      required: ["query", "connectionId", "databaseName"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      executeQuery(
        input.query,
        input.connectionId,
        workspaceId,
        input.databaseName,
      ),
  });

  const inspectCollectionTool = tool({
    name: "inspect_collection",
    description:
      "Sample documents from a collection to infer field names and BSON data types. Returns the sample set and a schema summary.",
    parameters: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "The connection ID",
        },
        collectionName: {
          type: "string",
          description: "The collection name to inspect",
        },
        databaseName: {
          type: "string",
          description:
            "The target database name (use list_databases to discover available databases)",
        },
      },
      required: ["connectionId", "collectionName", "databaseName"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      inspectCollection(
        input.connectionId,
        input.collectionName,
        workspaceId,
        input.databaseName,
      ),
  });

  const consoleTools = createConsoleTools(consoles, preferredConsoleId);

  return [
    listConnectionsTool,
    listDatabasesTool,
    listCollectionsTool,
    inspectCollectionTool,
    executeQueryTool,
    ...consoleTools,
  ];
};
