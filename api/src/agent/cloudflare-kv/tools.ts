// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – provided at runtime
import { tool } from "@openai/agents";
import { Types } from "mongoose";
import { DatabaseConnection } from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import { createConsoleTools, ConsoleData } from "../shared/console-tools";

const KV_TYPE = "cloudflare-kv";

const ensureValidObjectId = (value: string, label: string): Types.ObjectId => {
  if (typeof value !== "string" || !Types.ObjectId.isValid(value)) {
    throw new Error(`'${label}' must be a valid identifier`);
  }
  return new Types.ObjectId(value);
};

const fetchKVDatabase = async (connectionId: string, workspaceId: string) => {
  const connectionObjectId = ensureValidObjectId(connectionId, "connectionId");
  const workspaceObjectId = ensureValidObjectId(workspaceId, "workspaceId");

  const database = await DatabaseConnection.findOne({
    _id: connectionObjectId,
    workspaceId: workspaceObjectId,
  });

  if (!database) {
    throw new Error("Database connection not found or access denied");
  }

  if (database.type !== KV_TYPE) {
    throw new Error(
      "This tool only supports Cloudflare KV database connections.",
    );
  }

  return database;
};

const listKVConnections = async (workspaceId: string) => {
  const workspaceObjectId = ensureValidObjectId(workspaceId, "workspaceId");

  const databases = await DatabaseConnection.find({
    workspaceId: workspaceObjectId,
    type: KV_TYPE,
  }).sort({ name: 1 });

  return databases.map(db => {
    const connection: any = (db as any).connection || {};
    return {
      id: db._id.toString(),
      name: db.name,
      type: db.type,
      accountId: connection.account_id || "unknown",
      namespaceId: connection.namespace_id || null, // Configured namespace (null if multi-namespace mode)
      displayName: `${db.name} (Cloudflare KV)`,
      active: true,
    };
  });
};

const listKVNamespaces = async (connectionId: string, workspaceId: string) => {
  const database = await fetchKVDatabase(connectionId, workspaceId);

  // Use the driver to list namespaces
  const { CloudflareKVDatabaseDriver } = await import(
    "../../databases/drivers/cloudflare-kv/driver"
  );
  const driver = new CloudflareKVDatabaseDriver();
  const namespaces = await driver.listNamespaces(database as any);

  return namespaces.map(ns => ({
    namespaceId: ns.id,
    name: ns.title,
  }));
};

const listKVKeys = async (
  connectionId: string,
  workspaceId: string,
  namespaceId: string,
  options?: { prefix?: string; limit?: number },
) => {
  if (!namespaceId) {
    throw new Error("'namespaceId' is required");
  }

  const database = await fetchKVDatabase(connectionId, workspaceId);

  // Build the query with options
  const listOptions: any = { limit: options?.limit || 100 };
  if (options?.prefix) {
    listOptions.prefix = options.prefix;
  }

  const query = `kv.list(${JSON.stringify(listOptions)})`;

  const result = await databaseConnectionService.executeQuery(
    database as any,
    query,
    { databaseId: namespaceId },
  );

  if (!result.success) {
    throw new Error(result.error || "Failed to list keys");
  }

  return {
    keys: result.data || [],
    count: result.rowCount || 0,
  };
};

const getKVValue = async (
  connectionId: string,
  workspaceId: string,
  namespaceId: string,
  key: string,
) => {
  if (!namespaceId) {
    throw new Error("'namespaceId' is required");
  }
  if (!key) {
    throw new Error("'key' is required");
  }

  const database = await fetchKVDatabase(connectionId, workspaceId);

  const query = `kv.get(${JSON.stringify(key)})`;

  const result = await databaseConnectionService.executeQuery(
    database as any,
    query,
    { databaseId: namespaceId },
  );

  if (!result.success) {
    throw new Error(result.error || "Failed to get value");
  }

  return result.data?.[0] || { key, value: null };
};

const executeKVQuery = async (
  connectionId: string,
  query: string,
  workspaceId: string,
  namespaceId: string,
) => {
  if (!namespaceId) {
    throw new Error("'namespaceId' is required");
  }
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("'query' must be a non-empty string");
  }

  const database = await fetchKVDatabase(connectionId, workspaceId);

  // Ensure list queries have a limit for safety
  let safeQuery = query.trim();
  if (safeQuery.includes("kv.list()") && !safeQuery.includes("limit")) {
    safeQuery = safeQuery.replace("kv.list()", "kv.list({ limit: 100 })");
  }

  return databaseConnectionService.executeQuery(database as any, safeQuery, {
    databaseId: namespaceId,
  });
};

export const createCloudflareKVTools = (
  workspaceId: string,
  consoles?: ConsoleData[],
  preferredConsoleId?: string,
) => {
  const listConnectionsTool = tool({
    name: "kv_list_connections",
    description:
      "Return a list of Cloudflare KV database connections available in this workspace.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execute: async () => listKVConnections(workspaceId),
  });

  const listConnectionsAlias = tool({
    name: "list_connections",
    description: "Alias for listing Cloudflare KV connections in the workspace.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execute: async () => listKVConnections(workspaceId),
  });

  const listNamespacesTool = tool({
    name: "kv_list_namespaces",
    description: "List KV namespaces within a Cloudflare KV connection.",
    parameters: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "The connection ID (from kv_list_connections)",
        },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      listKVNamespaces(input.connectionId, workspaceId),
  });

  const listNamespacesAlias = tool({
    name: "list_namespaces",
    description: "Alias for listing KV namespaces within a connection.",
    parameters: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "The connection ID (from kv_list_connections)",
        },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      listKVNamespaces(input.connectionId, workspaceId),
  });

  const listKeysTool = tool({
    name: "kv_list_keys",
    description:
      "List keys in a KV namespace. Use prefix to filter keys. Always returns limited results for safety. Pass empty string for prefix to list all keys.",
    parameters: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "The connection ID (from kv_list_connections)",
        },
        namespaceId: {
          type: "string",
          description:
            "The KV namespace ID (from kv_list_namespaces or configured in connection)",
        },
        prefix: {
          type: "string",
          description: "Prefix to filter keys (e.g., 'user:', 'session:'). Use empty string for all keys.",
        },
        limit: {
          type: "number",
          description: "Maximum keys to return (default: 100, max: 1000)",
        },
      },
      required: ["connectionId", "namespaceId", "prefix", "limit"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      listKVKeys(input.connectionId, workspaceId, input.namespaceId, {
        prefix: input.prefix || undefined,
        limit: input.limit || 100,
      }),
  });

  const listKeysAlias = tool({
    name: "list_keys",
    description: "Alias: List keys in a KV namespace. Pass empty string for prefix to list all keys.",
    parameters: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "The connection ID (from kv_list_connections)",
        },
        namespaceId: {
          type: "string",
          description: "The KV namespace ID",
        },
        prefix: {
          type: "string",
          description: "Prefix to filter keys. Use empty string for all keys.",
        },
        limit: {
          type: "number",
          description: "Maximum keys to return (default: 100)",
        },
      },
      required: ["connectionId", "namespaceId", "prefix", "limit"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      listKVKeys(input.connectionId, workspaceId, input.namespaceId, {
        prefix: input.prefix || undefined,
        limit: input.limit || 100,
      }),
  });

  const getValueTool = tool({
    name: "kv_get_value",
    description: "Get the value stored for a specific key in the KV namespace.",
    parameters: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "The connection ID (from kv_list_connections)",
        },
        namespaceId: {
          type: "string",
          description: "The KV namespace ID",
        },
        key: {
          type: "string",
          description: "The key to retrieve",
        },
      },
      required: ["connectionId", "namespaceId", "key"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      getKVValue(input.connectionId, workspaceId, input.namespaceId, input.key),
  });

  const getValueAlias = tool({
    name: "get_value",
    description: "Alias: Get the value for a specific key.",
    parameters: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "The connection ID",
        },
        namespaceId: {
          type: "string",
          description: "The KV namespace ID",
        },
        key: {
          type: "string",
          description: "The key to retrieve",
        },
      },
      required: ["connectionId", "namespaceId", "key"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      getKVValue(input.connectionId, workspaceId, input.namespaceId, input.key),
  });

  const executeQueryTool = tool({
    name: "kv_execute_query",
    description: `Execute a KV query using the JavaScript-like syntax. Examples:
- kv.list({ limit: 100 })
- kv.list({ prefix: "user:", limit: 500 })
- kv.get("my-key")
- kv.put("key", "value")
- kv.delete("key")

Transformations can be chained:
- kv.list().map(k => k.name)
- kv.list({ prefix: "session:" }).filter(k => k.expiration)`,
    parameters: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "The connection ID (from kv_list_connections)",
        },
        query: {
          type: "string",
          description:
            "The KV query to execute (e.g., kv.list({ prefix: \"user:\" }))",
        },
        namespaceId: {
          type: "string",
          description: "The KV namespace ID to query",
        },
      },
      required: ["connectionId", "query", "namespaceId"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      executeKVQuery(
        input.connectionId,
        input.query,
        workspaceId,
        input.namespaceId,
      ),
  });

  const executeQueryAlias = tool({
    name: "execute_query",
    description: "Alias: Execute a KV query with JavaScript-like syntax.",
    parameters: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "The connection ID",
        },
        query: {
          type: "string",
          description: "The KV query to execute",
        },
        namespaceId: {
          type: "string",
          description: "The KV namespace ID",
        },
      },
      required: ["connectionId", "query", "namespaceId"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      executeKVQuery(
        input.connectionId,
        input.query,
        workspaceId,
        input.namespaceId,
      ),
  });

  const consoleTools = createConsoleTools(consoles, preferredConsoleId);

  return [
    listConnectionsTool,
    listConnectionsAlias,
    listNamespacesTool,
    listNamespacesAlias,
    listKeysTool,
    listKeysAlias,
    getValueTool,
    getValueAlias,
    executeQueryTool,
    executeQueryAlias,
    ...consoleTools,
  ];
};

