// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – provided at runtime
import { tool } from "@openai/agents";
import { Types } from "mongoose";
import { DatabaseConnection } from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import { createConsoleTools, ConsoleData } from "../shared/console-tools";

const listDatabases = async (workspaceId: string) => {
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
      database: (db as any).connection.database,
      type: db.type,
      active: true,
      displayName:
        (db as any).connection.database || db.name || "Unknown Database",
    }));
};

const listCollections = async (databaseId: string, workspaceId: string) => {
  if (
    !Types.ObjectId.isValid(databaseId) ||
    !Types.ObjectId.isValid(workspaceId)
  ) {
    throw new Error("Invalid database ID or workspace ID");
  }
  const database = await DatabaseConnection.findOne({
    _id: new Types.ObjectId(databaseId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!database) throw new Error("Database not found or access denied");
  if (database.type !== "mongodb") {
    throw new Error("Collection listing only supported for MongoDB databases");
  }
  const connection = await databaseConnectionService.getConnection(
    database as any,
  );
  const db = connection.db((database as any).connection.database);
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
  databaseId: string,
  collectionName: string,
  workspaceId: string,
) => {
  if (
    !Types.ObjectId.isValid(databaseId) ||
    !Types.ObjectId.isValid(workspaceId)
  ) {
    throw new Error("Invalid database ID or workspace ID");
  }
  const database = await DatabaseConnection.findOne({
    _id: new Types.ObjectId(databaseId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!database) throw new Error("Database not found or access denied");
  if (database.type !== "mongodb") {
    throw new Error(
      "Collection inspection only supported for MongoDB databases",
    );
  }
  const connection = await databaseConnectionService.getConnection(
    database as any,
  );
  const db = connection.db((database as any).connection.database);
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
  databaseId: string,
  workspaceId: string,
) => {
  if (
    !Types.ObjectId.isValid(databaseId) ||
    !Types.ObjectId.isValid(workspaceId)
  ) {
    throw new Error("Invalid database ID or workspace ID");
  }
  const database = await DatabaseConnection.findOne({
    _id: new Types.ObjectId(databaseId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!database) throw new Error("Database not found or access denied");
  const result = await databaseConnectionService.executeQuery(
    database as any,
    query,
  );
  return result;
};

export const createMongoTools = (
  workspaceId: string,
  consoles?: ConsoleData[],
  preferredConsoleId?: string,
) => {
  const listDatabasesTool = tool({
    name: "list_databases",
    description:
      "Return a list of all active MongoDB databases that the system knows about for the current workspace.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execute: async (_: any) => listDatabases(workspaceId),
  });

  const listCollectionsTool = tool({
    name: "list_collections",
    description:
      "Return a list of collections for the provided database identifier.",
    parameters: {
      type: "object",
      properties: {
        databaseId: { type: "string", description: "The database id" },
      },
      required: ["databaseId"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      listCollections(input.databaseId, workspaceId),
  });

  const executeQueryTool = tool({
    name: "execute_query",
    description:
      "Execute an arbitrary MongoDB query and return the results. The query should be written in JavaScript using MongoDB Node.js driver syntax.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The MongoDB query to execute" },
        databaseId: { type: "string", description: "The target database id" },
      },
      required: ["query", "databaseId"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      executeQuery(input.query, input.databaseId, workspaceId),
  });

  const inspectCollectionTool = tool({
    name: "inspect_collection",
    description:
      "Sample documents from a collection to infer field names and BSON data types. Returns the sample set and a schema summary.",
    parameters: {
      type: "object",
      properties: {
        databaseId: { type: "string" },
        collectionName: { type: "string" },
      },
      required: ["databaseId", "collectionName"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      inspectCollection(input.databaseId, input.collectionName, workspaceId),
  });

  const consoleTools = createConsoleTools(consoles, preferredConsoleId);

  return [
    listDatabasesTool,
    listCollectionsTool,
    inspectCollectionTool,
    executeQueryTool,
    ...consoleTools,
  ];
};
