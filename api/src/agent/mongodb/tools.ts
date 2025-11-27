// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – provided at runtime
import { tool } from "@openai/agents";
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

const listMongoDatabases = async (connectionId: string, workspaceId: string) => {
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
  databaseName?: string,
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
    throw new Error("Collection listing only supported for MongoDB databases");
  }
  const connection = await databaseConnectionService.getConnection(
    database as any,
  );
  // Use provided databaseName or default from connection
  const targetDbName = databaseName || (database as any).connection.database;
  const db = connection.db(targetDbName);
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

const inspectCollection = async (
  connectionId: string,
  collectionName: string,
  workspaceId: string,
  databaseName?: string,
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
    throw new Error(
      "Collection inspection only supported for MongoDB databases",
    );
  }
  const connection = await databaseConnectionService.getConnection(
    database as any,
  );
  const targetDbName = databaseName || (database as any).connection.database;
  const db = connection.db(targetDbName);
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
  return {
    schema,
    sampleDocuments: sampleDocuments.slice(0, 25),
    totalSampled: sampleDocuments.length,
  };
};

const executeQuery = async (
  query: string,
  connectionId: string,
  workspaceId: string,
  databaseName?: string,
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
  
  // Pass databaseName options if supported, or prepend db switching script
  const options = databaseName ? { databaseName } : undefined;
  
  const result = await databaseConnectionService.executeQuery(
    database as any,
    query,
    options,
  );
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
      "Return a list of collections for the provided connection and optional database.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string", description: "The connection ID" },
        databaseName: {
          type: "string",
          description: "Optional database name to list collections from",
        },
      },
      required: ["connectionId", "databaseName"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      listCollections(
        input.connectionId,
        workspaceId,
        input.databaseName || undefined,
      ),
  });

  const executeQueryTool = tool({
    name: "execute_query",
    description:
      "Execute an arbitrary MongoDB query and return the results. The query should be written in JavaScript using MongoDB Node.js driver syntax.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The MongoDB query to execute" },
        connectionId: { type: "string", description: "The target connection ID" },
        databaseName: {
          type: "string",
          description: "Optional target database name",
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
        input.databaseName || undefined,
      ),
  });

  const inspectCollectionTool = tool({
    name: "inspect_collection",
    description:
      "Sample documents from a collection to infer field names and BSON data types. Returns the sample set and a schema summary.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        collectionName: { type: "string" },
        databaseName: { type: "string" },
      },
      required: ["connectionId", "collectionName", "databaseName"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      inspectCollection(
        input.connectionId,
        input.collectionName,
        workspaceId,
        input.databaseName || undefined,
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
