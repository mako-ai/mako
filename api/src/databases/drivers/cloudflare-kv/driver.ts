import {
  DatabaseDriver,
  DatabaseDriverMetadata,
  DatabaseTreeNode,
} from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";
import axios, { AxiosInstance } from "axios";
import { loggers } from "../../../logging";

const logger = loggers.db("cloudflare-kv");

interface KVConnection {
  account_id: string;
  api_token: string;
  namespace_id?: string;
}

interface KVQueryResult {
  success: boolean;
  data?: any[];
  error?: string;
  rowCount?: number;
}

interface KVNamespace {
  id: string;
  title: string;
}

interface KVKey {
  name: string;
  expiration?: number;
  metadata?: Record<string, any>;
}

/**
 * Cloudflare Workers KV Store Driver
 *
 * Supported operations (no code execution - direct API calls only):
 *   kv.list()                                - List keys (default limit: 100)
 *   kv.list({ limit: 500 })                  - List with custom limit
 *   kv.list({ prefix: "user:" })             - List keys with prefix
 *   kv.list({ prefix: "user:", limit: 500 }) - Combined options
 *   kv.get("my-key")                         - Get a value
 *   kv.put("my-key", "value")                - Store a value
 *   kv.delete("my-key")                      - Delete a key
 */
export class CloudflareKVDatabaseDriver implements DatabaseDriver {
  private httpClients: Map<string, AxiosInstance> = new Map();

  getMetadata(): DatabaseDriverMetadata {
    return {
      type: "cloudflare-kv",
      displayName: "Cloudflare KV",
      consoleLanguage: "javascript",
    };
  }

  private getHttpClient(database: IDatabaseConnection): AxiosInstance {
    const key = database._id.toString();
    const existingClient = this.httpClients.get(key);
    if (existingClient) {
      return existingClient;
    }

    const conn = database.connection as unknown as KVConnection;
    if (!conn.account_id || !conn.api_token) {
      throw new Error("Cloudflare KV requires 'account_id' and 'api_token'");
    }

    const client = axios.create({
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${conn.account_id}/storage/kv/namespaces`,
      headers: {
        Authorization: `Bearer ${conn.api_token}`,
        "Content-Type": "application/json",
      },
    });

    this.httpClients.set(key, client);
    return client;
  }

  async getTreeRoot(
    database: IDatabaseConnection,
  ): Promise<DatabaseTreeNode[]> {
    const conn = database.connection as unknown as KVConnection;

    if (conn.namespace_id) {
      try {
        const client = this.getHttpClient(database);
        const response = await client.get(`/${conn.namespace_id}`);
        const title = response.data?.result?.title || conn.namespace_id;
        return [
          {
            id: conn.namespace_id,
            label: title,
            kind: "table",
            hasChildren: false,
            metadata: { databaseId: conn.namespace_id, databaseName: title },
          },
        ];
      } catch {
        return [
          {
            id: conn.namespace_id,
            label: conn.namespace_id,
            kind: "table",
            hasChildren: false,
            metadata: {
              databaseId: conn.namespace_id,
              databaseName: conn.namespace_id,
            },
          },
        ];
      }
    }

    try {
      const client = this.getHttpClient(database);
      const response = await client.get("", { params: { per_page: 100 } });
      if (!response.data.success) return [];

      return (response.data.result || []).map((ns: KVNamespace) => ({
        id: ns.id,
        label: ns.title,
        kind: "table",
        hasChildren: false,
        metadata: { databaseId: ns.id, databaseName: ns.title },
      }));
    } catch (error) {
      logger.error("Error listing KV namespaces", { error });
      return [];
    }
  }

  async getChildren(): Promise<DatabaseTreeNode[]> {
    return [];
  }

  async executeQuery(
    database: IDatabaseConnection,
    query: string,
    options?: { databaseId?: string; namespaceId?: string },
  ): Promise<KVQueryResult> {
    try {
      const conn = database.connection as unknown as KVConnection;
      const namespaceId =
        options?.databaseId || options?.namespaceId || conn.namespace_id;

      if (!namespaceId) {
        return { success: false, error: "No namespace_id specified" };
      }

      if (typeof query !== "string" || !query.trim()) {
        return { success: false, error: "Query must be a non-empty string" };
      }

      const client = this.getHttpClient(database);
      const parsed = this.parseQuery(query.trim());

      if (!parsed) {
        return {
          success: false,
          error: `Invalid query. Supported: kv.list(), kv.get("key"), kv.put("key", "value"), kv.delete("key")`,
        };
      }

      switch (parsed.method) {
        case "list":
          return this.kvList(client, namespaceId, parsed.options);
        case "get":
          return this.kvGet(client, namespaceId, parsed.key ?? "");
        case "put":
          return this.kvPut(
            client,
            namespaceId,
            parsed.key ?? "",
            parsed.value,
          );
        case "delete":
          return this.kvDelete(client, namespaceId, parsed.key ?? "");
        default:
          return { success: false, error: `Unknown method: ${parsed.method}` };
      }
    } catch (error: any) {
      return {
        success: false,
        error:
          error?.response?.data?.errors?.[0]?.message ||
          error?.message ||
          "KV query failed",
      };
    }
  }

  /**
   * Parse query into method and arguments - NO code execution
   */
  private parseQuery(query: string): {
    method: string;
    key?: string;
    value?: any;
    options?: { prefix?: string; limit?: number };
  } | null {
    const q = query.replace(/^await\s+/, "").trim();
    if (!q.startsWith("kv.")) return null;

    // kv.list() or kv.list({ ... })
    const listMatch = q.match(/^kv\.list\s*\(\s*(\{[\s\S]*\})?\s*\)$/);
    if (listMatch) {
      const options = listMatch[1] ? this.parseJsonObject(listMatch[1]) : {};
      return { method: "list", options };
    }

    // kv.get("key")
    const getMatch = q.match(/^kv\.get\s*\(\s*["'`](.+?)["'`]\s*\)$/);
    if (getMatch) {
      return { method: "get", key: getMatch[1] };
    }

    // kv.put("key", value)
    const putMatch = q.match(
      /^kv\.put\s*\(\s*["'`](.+?)["'`]\s*,\s*([\s\S]+)\s*\)$/,
    );
    if (putMatch) {
      return {
        method: "put",
        key: putMatch[1],
        value: this.parseValue(putMatch[2].trim()),
      };
    }

    // kv.delete("key")
    const deleteMatch = q.match(/^kv\.delete\s*\(\s*["'`](.+?)["'`]\s*\)$/);
    if (deleteMatch) {
      return { method: "delete", key: deleteMatch[1] };
    }

    return null;
  }

  /**
   * Parse a JSON object string safely
   */
  private parseJsonObject(str: string): { prefix?: string; limit?: number } {
    try {
      return JSON.parse(str);
    } catch {
      return {};
    }
  }

  /**
   * Parse a value (string, number, boolean, object, array) safely
   */
  private parseValue(str: string): any {
    // String literals - extract the content
    if (
      (str.startsWith('"') && str.endsWith('"')) ||
      (str.startsWith("'") && str.endsWith("'")) ||
      (str.startsWith("`") && str.endsWith("`"))
    ) {
      return str.slice(1, -1);
    }
    try {
      return JSON.parse(str);
    } catch {
      return str;
    }
  }

  private async kvList(
    client: AxiosInstance,
    namespaceId: string,
    options?: { prefix?: string; limit?: number },
  ): Promise<KVQueryResult> {
    const limit = Math.min(options?.limit ?? 100, 10000);
    const allKeys: KVKey[] = [];
    let cursor: string | undefined;

    // First, list all keys
    do {
      const params: Record<string, any> = {
        limit: Math.min(1000, limit - allKeys.length),
      };
      if (options?.prefix) params.prefix = options.prefix;
      if (cursor) params.cursor = cursor;

      const response = await client.get(`/${namespaceId}/keys`, { params });
      if (!response.data.success) {
        return {
          success: false,
          error:
            response.data.errors?.map((e: any) => e.message).join("; ") ||
            "Failed to list keys",
        };
      }

      allKeys.push(...(response.data.result || []));
      cursor = response.data.list_complete
        ? undefined
        : response.data.result_info?.cursor;
    } while (cursor && allKeys.length < limit);

    // Then fetch values using bulk get API (up to 100 keys per request)
    const results = await this.bulkGetValues(client, namespaceId, allKeys);

    return {
      success: true,
      data: results,
      rowCount: results.length,
    };
  }

  /**
   * Fetch values for multiple keys using Cloudflare's bulk get API
   * https://developers.cloudflare.com/api/node/resources/kv/subresources/namespaces/methods/bulk_get/
   * Retrieves up to 100 keys per request
   */
  private async bulkGetValues(
    client: AxiosInstance,
    namespaceId: string,
    keys: KVKey[],
  ): Promise<any[]> {
    const results: any[] = [];
    const BULK_GET_LIMIT = 100; // Cloudflare's max per bulk get request

    // Process in batches of 100
    for (let i = 0; i < keys.length; i += BULK_GET_LIMIT) {
      const batch = keys.slice(i, i + BULK_GET_LIMIT);
      const keyNames = batch.map(k => k.name);

      try {
        // Cloudflare bulk get API - fetch values for multiple keys
        // POST /accounts/{account_id}/storage/kv/namespaces/{namespace_id}/bulk/get
        // Body: { keys: string[] }
        const response = await client.post(`/${namespaceId}/bulk/get`, {
          keys: keyNames,
        });

        if (response.data.success && response.data.result) {
          // Response: { result: { values: { key1: value1, key2: value2 } } }
          const values =
            response.data.result.values || response.data.result || {};

          for (const key of batch) {
            let value = values[key.name] ?? null;

            // Try to parse JSON if it's a string
            if (typeof value === "string") {
              try {
                value = JSON.parse(value);
              } catch {
                // Keep as string
              }
            }

            results.push({
              key: key.name,
              value,
              expiration: key.expiration
                ? new Date(key.expiration * 1000).toISOString()
                : null,
              metadata: key.metadata || null,
            });
          }
        } else {
          // Fallback: add keys without values if bulk get fails
          for (const key of batch) {
            results.push({
              key: key.name,
              value: null,
              error: "Bulk get failed",
              expiration: key.expiration
                ? new Date(key.expiration * 1000).toISOString()
                : null,
              metadata: key.metadata || null,
            });
          }
        }
      } catch (error: any) {
        // Fallback: add keys without values on error
        for (const key of batch) {
          results.push({
            key: key.name,
            value: null,
            error: error?.message || "Failed to fetch value",
            expiration: key.expiration
              ? new Date(key.expiration * 1000).toISOString()
              : null,
            metadata: key.metadata || null,
          });
        }
      }
    }

    return results;
  }

  private async kvGet(
    client: AxiosInstance,
    namespaceId: string,
    key: string,
  ): Promise<KVQueryResult> {
    if (!key) return { success: false, error: "Key is required" };

    try {
      const response = await client.get(
        `/${namespaceId}/values/${encodeURIComponent(key)}`,
        { transformResponse: [(data: any) => data] },
      );

      let value = response.data;
      try {
        value = JSON.parse(value);
      } catch {
        /* keep as string */
      }

      return { success: true, data: [{ key, value }], rowCount: 1 };
    } catch (error: any) {
      if (error?.response?.status === 404) {
        return { success: false, error: `Key not found: ${key}` };
      }
      throw error;
    }
  }

  private async kvPut(
    client: AxiosInstance,
    namespaceId: string,
    key: string,
    value: any,
  ): Promise<KVQueryResult> {
    if (!key) return { success: false, error: "Key is required" };

    const body =
      typeof value === "object" ? JSON.stringify(value) : String(value);
    await client.put(
      `/${namespaceId}/values/${encodeURIComponent(key)}`,
      body,
      {
        headers: {
          "Content-Type":
            typeof value === "object" ? "application/json" : "text/plain",
        },
      },
    );

    return {
      success: true,
      data: [{ key, status: "stored", value }],
      rowCount: 1,
    };
  }

  private async kvDelete(
    client: AxiosInstance,
    namespaceId: string,
    key: string,
  ): Promise<KVQueryResult> {
    if (!key) return { success: false, error: "Key is required" };

    await client.delete(`/${namespaceId}/values/${encodeURIComponent(key)}`);
    return { success: true, data: [{ key, status: "deleted" }], rowCount: 1 };
  }

  async testConnection(
    database: IDatabaseConnection,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const conn = database.connection as unknown as KVConnection;
      if (!conn.account_id || !conn.api_token) {
        return {
          success: false,
          error: "account_id and api_token are required",
        };
      }

      const client = this.getHttpClient(database);

      if (conn.namespace_id) {
        const response = await client.get(`/${conn.namespace_id}/keys`, {
          params: { limit: 1 },
        });
        return response.data.success
          ? { success: true }
          : {
              success: false,
              error:
                response.data.errors?.[0]?.message ||
                "Failed to access namespace",
            };
      }

      const response = await client.get("", { params: { per_page: 1 } });
      return response.data.success
        ? { success: true }
        : {
            success: false,
            error: response.data.errors?.[0]?.message || "Failed to connect",
          };
    } catch (error: any) {
      return {
        success: false,
        error:
          error?.response?.data?.errors?.[0]?.message ||
          error?.message ||
          "Connection test failed",
      };
    }
  }

  async listNamespaces(database: IDatabaseConnection): Promise<KVNamespace[]> {
    try {
      const client = this.getHttpClient(database);
      const namespaces: KVNamespace[] = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await client.get("", {
          params: { per_page: 100, page },
        });
        if (!response.data.success) break;

        namespaces.push(...(response.data.result || []));
        const info = response.data.result_info;
        hasMore = info && info.page * info.per_page < info.count;
        page++;
      }

      return namespaces;
    } catch (error) {
      logger.error("Error listing KV namespaces", { error });
      return [];
    }
  }

  closeConnection(databaseId: string): void {
    this.httpClients.delete(databaseId);
  }

  closeAllConnections(): void {
    this.httpClients.clear();
  }
}
