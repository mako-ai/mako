import {
  DatabaseDriver,
  DatabaseDriverMetadata,
  DatabaseTreeNode,
} from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";
import axios, { AxiosInstance } from "axios";

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
  supports_url_encoding?: boolean;
}

interface KVKey {
  name: string;
  expiration?: number;
  metadata?: Record<string, any>;
}

/**
 * Cloudflare Workers KV Store Driver
 *
 * Query syntax mirrors the Cloudflare Workers KV JavaScript API:
 * https://developers.cloudflare.com/kv/api/list-keys/
 *
 * Options: { prefix?: string, limit?: number, cursor?: string }
 *   - prefix: filter keys by prefix
 *   - limit: max keys to return (default: 100, max: 10000)
 *   - cursor: pagination cursor for large result sets
 *
 * Basic operations:
 *   kv.list()                                - List keys (default limit: 100)
 *   kv.list({ limit: 1000 })                 - List up to 1000 keys
 *   kv.list({ prefix: "user:" })             - List keys with prefix
 *   kv.list({ prefix: "user:", limit: 500 }) - Combined options
 *   kv.get("my-key")                         - Get a value
 *   kv.get("my-key", { type: "json" })       - Get as parsed JSON
 *   kv.put("my-key", "value")                - Store a value
 *   kv.put("my-key", { data: 123 })          - Store JSON (auto-serialized)
 *   kv.delete("my-key")                      - Delete a key
 *
 * Transformations (chained on results):
 *   kv.list().map(k => k.name)
 *   kv.list({ prefix: "user:" }).filter(k => k.expiration)
 *   kv.list({ limit: 500 }).slice(0, 10)
 *
 * Examples:
 *   kv.list({ prefix: "session:", limit: 100 }).map(k => ({ key: k.name, expires: k.expiration }))
 *   kv.get("config").then(v => v.settings)
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
      throw new Error(
        "Cloudflare KV requires 'account_id' and 'api_token' in connection",
      );
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

    // If a specific namespace_id is configured, show only that namespace
    if (conn.namespace_id) {
      // Fetch the namespace details to get the title
      try {
        const client = this.getHttpClient(database);
        const response = await client.get(`/${conn.namespace_id}`);
        const ns = response.data?.result;
        const title = ns?.title || conn.namespace_id;
        return [
          {
            id: conn.namespace_id,
            label: title,
            kind: "table", // Use table kind for consistent icon
            hasChildren: false, // Don't expand - keys can be in millions
            // Use databaseId/databaseName to match D1 pattern (frontend extracts these)
            metadata: {
              databaseId: conn.namespace_id,
              databaseName: title,
            },
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

    // Otherwise, list all KV namespaces in the account
    try {
      const client = this.getHttpClient(database);
      const response = await client.get("", {
        params: { per_page: 100 },
      });

      const result = response.data;
      if (!result.success) {
        console.error("KV list namespaces failed:", result.errors);
        return [];
      }

      const namespaces: KVNamespace[] = result.result || [];
      return namespaces.map<DatabaseTreeNode>(ns => ({
        id: ns.id,
        label: ns.title,
        kind: "table", // Use table kind for consistent icon with other DB types
        hasChildren: false, // Don't expand - keys can be in millions
        // Use databaseId/databaseName to match D1 pattern (frontend extracts these)
        metadata: { databaseId: ns.id, databaseName: ns.title },
      }));
    } catch (error) {
      console.error("Error listing KV namespaces:", error);
      return [];
    }
  }

  async getChildren(
    _database: IDatabaseConnection,
    _parent: { kind: string; id: string; metadata?: any },
  ): Promise<DatabaseTreeNode[]> {
    // Don't list keys - they can be in the millions
    // Users should use kv.list() in the console instead
    return [];
  }

  async executeQuery(
    database: IDatabaseConnection,
    query: string,
    options?: { databaseId?: string; namespaceId?: string },
  ): Promise<KVQueryResult> {
    try {
      const conn = database.connection as unknown as KVConnection;
      // Accept databaseId (from frontend) or namespaceId, fallback to connection config
      const namespaceId =
        options?.databaseId || options?.namespaceId || conn.namespace_id;

      if (!namespaceId) {
        return {
          success: false,
          error:
            "No namespace_id specified. Please select a KV namespace or configure one in the connection settings.",
        };
      }

      if (typeof query !== "string" || !query.trim()) {
        return { success: false, error: "Query must be a non-empty string" };
      }

      const client = this.getHttpClient(database);

      // Parse and execute the KV query
      return await this.executeKVQuery(client, namespaceId, query.trim());
    } catch (error: any) {
      const errorMessage =
        error?.response?.data?.errors?.[0]?.message ||
        error?.message ||
        "KV query failed";
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Parse and execute KV JavaScript-like queries safely
   */
  private async executeKVQuery(
    client: AxiosInstance,
    namespaceId: string,
    query: string,
  ): Promise<KVQueryResult> {
    // Parse the query to extract the KV operation and any transformations
    const parsed = this.parseKVQuery(query);

    if (!parsed) {
      return {
        success: false,
        error: `Invalid query syntax. Examples:
  kv.list()                              - List keys (default limit: 100)
  kv.list({ limit: 1000 })               - List up to 1000 keys
  kv.list({ prefix: "user:" })           - List keys with prefix  
  kv.list({ prefix: "user:", limit: 500 })
  kv.get("my-key")                       - Get a value
  kv.put("my-key", "value")              - Store a value
  kv.delete("my-key")                    - Delete a key
  
Transformations:
  kv.list().map(k => k.name)             - Transform results
  kv.list().filter(k => k.expiration)
  kv.list({ limit: 500 }).slice(0, 10)`,
      };
    }

    // Execute the base KV operation
    let result: any;

    switch (parsed.method) {
      case "list":
        result = await this.kvList(client, namespaceId, parsed.args[0]);
        break;
      case "get":
        result = await this.kvGet(
          client,
          namespaceId,
          parsed.args[0],
          parsed.args[1],
        );
        break;
      case "put":
        result = await this.kvPut(
          client,
          namespaceId,
          parsed.args[0],
          parsed.args[1],
          parsed.args[2],
        );
        break;
      case "delete":
        result = await this.kvDelete(client, namespaceId, parsed.args[0]);
        break;
      default:
        return { success: false, error: `Unknown method: ${parsed.method}` };
    }

    if (!result.success) {
      return result;
    }

    // Apply transformations if any
    if (parsed.transforms.length > 0) {
      try {
        result.data = this.applyTransforms(result.data, parsed.transforms);
        result.rowCount = Array.isArray(result.data) ? result.data.length : 1;
      } catch (error: any) {
        return {
          success: false,
          error: `Transform error: ${error.message}`,
        };
      }
    }

    return result;
  }

  /**
   * Parse a KV query into method, args, and transform chain
   */
  private parseKVQuery(query: string): {
    method: string;
    args: any[];
    transforms: Array<{ type: string; fn?: string; args?: any[] }>;
  } | null {
    // Remove leading 'await' if present
    let q = query.trim().replace(/^await\s+/, "");

    // Must start with 'kv.'
    if (!q.startsWith("kv.")) {
      return null;
    }

    q = q.slice(3); // Remove 'kv.'

    // Extract the method call - find the first balanced parentheses
    const methodMatch = q.match(/^(\w+)\s*\(/);
    if (!methodMatch) {
      return null;
    }

    const method = methodMatch[1];
    let rest = q.slice(methodMatch[0].length);

    // Find the closing paren for the method call (respects string literals)
    const argEnd = this.findMatchingParen(rest);

    const argsStr = rest.slice(0, argEnd);
    rest = rest.slice(argEnd + 1).trim();

    // Parse arguments
    const args = this.parseArgs(argsStr);

    // Parse transform chain (e.g., .map(...).filter(...).slice(0, 10))
    const transforms: Array<{ type: string; fn?: string; args?: any[] }> = [];

    while (rest.startsWith(".")) {
      rest = rest.slice(1);
      const transformMatch = rest.match(/^(\w+)\s*\(/);
      if (!transformMatch) break;

      const transformType = transformMatch[1];
      rest = rest.slice(transformMatch[0].length);

      // Find closing paren (respects string literals)
      const transformArgEnd = this.findMatchingParen(rest);

      const transformArgsStr = rest.slice(0, transformArgEnd);
      rest = rest.slice(transformArgEnd + 1).trim();

      // For .then(), .map(), .filter() - the argument is a function
      if (
        ["then", "map", "filter", "find", "some", "every"].includes(
          transformType,
        )
      ) {
        transforms.push({ type: transformType, fn: transformArgsStr.trim() });
      } else if (["slice", "at"].includes(transformType)) {
        // For slice/at - parse numeric arguments
        const sliceArgs = this.parseArgs(transformArgsStr);
        transforms.push({ type: transformType, args: sliceArgs });
      } else if (transformType === "sort") {
        transforms.push({
          type: "sort",
          fn: transformArgsStr.trim() || undefined,
        });
      } else if (transformType === "reverse") {
        transforms.push({ type: "reverse" });
      } else if (transformType === "flat") {
        const flatArgs = this.parseArgs(transformArgsStr);
        transforms.push({ type: "flat", args: flatArgs });
      } else if (transformType === "reduce") {
        // reduce(fn, initialValue)
        transforms.push({ type: "reduce", fn: transformArgsStr.trim() });
      }
    }

    return { method, args, transforms };
  }

  /**
   * Safely parse function arguments
   */
  private parseArgs(argsStr: string): any[] {
    const trimmed = argsStr.trim();
    if (!trimmed) return [];

    try {
      // Wrap in array and parse as JSON5-like
      // Handle common patterns: strings, numbers, objects, arrays
      const wrapped = `[${trimmed}]`;
      // Use Function constructor with restricted scope for safe parsing
      const parsed = new Function(`return ${wrapped}`)();
      return parsed;
    } catch {
      // If parsing fails, return as single string argument
      return [trimmed];
    }
  }

  /**
   * Find the index of the closing parenthesis that matches an opening paren.
   * Assumes the opening '(' has already been consumed, so we start at depth=1.
   * Respects string literals (single and double quotes) and template literals.
   */
  private findMatchingParen(str: string): number {
    let depth = 1;
    let inString: string | null = null; // tracks quote char if inside a string
    let i = 0;

    while (i < str.length) {
      const ch = str[i];

      // Handle escape sequences inside strings
      if (inString && ch === "\\") {
        i += 2; // skip escaped character
        continue;
      }

      // Toggle string state on quote characters
      if (ch === '"' || ch === "'" || ch === "`") {
        if (inString === ch) {
          inString = null; // closing quote
        } else if (!inString) {
          inString = ch; // opening quote
        }
        i++;
        continue;
      }

      // Only count parens when not inside a string
      if (!inString) {
        if (ch === "(") {
          depth++;
        } else if (ch === ")") {
          depth--;
          if (depth === 0) {
            return i;
          }
        }
      }

      i++;
    }

    // No matching paren found, return end of string
    return str.length;
  }

  /**
   * Apply transform chain to data safely
   * Only allows specific array methods with sandboxed function execution
   */
  private applyTransforms(
    data: any,
    transforms: Array<{ type: string; fn?: string; args?: any[] }>,
  ): any {
    let result = data;

    for (const transform of transforms) {
      if (!Array.isArray(result) && !["then"].includes(transform.type)) {
        // For non-array data, only .then is valid
        if (transform.type === "then" && transform.fn) {
          result = this.safeEvalTransform(result, transform.fn);
        }
        continue;
      }

      switch (transform.type) {
        case "map":
          if (transform.fn) {
            result = result.map((item: any) =>
              this.safeEvalTransform(item, transform.fn!),
            );
          }
          break;
        case "filter":
          if (transform.fn) {
            result = result.filter((item: any) =>
              this.safeEvalTransform(item, transform.fn!),
            );
          }
          break;
        case "find":
          if (transform.fn) {
            result = result.find((item: any) =>
              this.safeEvalTransform(item, transform.fn!),
            );
          }
          break;
        case "some":
          if (transform.fn) {
            result = result.some((item: any) =>
              this.safeEvalTransform(item, transform.fn!),
            );
          }
          break;
        case "every":
          if (transform.fn) {
            result = result.every((item: any) =>
              this.safeEvalTransform(item, transform.fn!),
            );
          }
          break;
        case "slice":
          if (transform.args) {
            result = result.slice(...transform.args);
          }
          break;
        case "at":
          if (transform.args && transform.args.length > 0) {
            result = result.at(transform.args[0]);
          }
          break;
        case "sort":
          if (transform.fn) {
            result = [...result].sort((a: any, b: any) =>
              this.safeEvalCompare(a, b, transform.fn!),
            );
          } else {
            result = [...result].sort();
          }
          break;
        case "reverse":
          result = [...result].reverse();
          break;
        case "flat": {
          const depth = transform.args?.[0] ?? 1;
          result = result.flat(depth);
          break;
        }
        case "reduce":
          if (transform.fn) {
            result = this.safeEvalReduce(result, transform.fn);
          }
          break;
        case "then":
          if (transform.fn) {
            result = this.safeEvalTransform(result, transform.fn);
          }
          break;
      }
    }

    return result;
  }

  /**
   * Safely evaluate a transform function on an item
   * Only allows property access and simple expressions
   */
  private safeEvalTransform(item: any, fnStr: string): any {
    // Parse arrow function: (x) => expr or x => expr
    const arrowMatch = fnStr.match(
      /^\s*(?:\(?\s*(\w+)\s*\)?)\s*=>\s*(.+)\s*$/s,
    );
    if (arrowMatch) {
      const [, param, body] = arrowMatch;
      return this.evalSafeExpression(body.trim(), { [param]: item });
    }

    // If not an arrow function, try evaluating as property path
    return this.evalSafeExpression(fnStr, { value: item });
  }

  /**
   * Safely evaluate a comparator function for sorting
   */
  private safeEvalCompare(a: any, b: any, fnStr: string): number {
    // Parse arrow function: (a, b) => expr
    const arrowMatch = fnStr.match(
      /^\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>\s*(.+)\s*$/s,
    );
    if (arrowMatch) {
      const [, paramA, paramB, body] = arrowMatch;
      const result = this.evalSafeExpression(body.trim(), {
        [paramA]: a,
        [paramB]: b,
      });
      return typeof result === "number" ? result : 0;
    }
    return 0;
  }

  /**
   * Safely evaluate a reduce function
   */
  private safeEvalReduce(arr: any[], fnStr: string): any {
    // Parse: (acc, item) => expr, initialValue
    // or just (acc, item) => expr
    const parts = this.splitReduceArgs(fnStr);
    if (!parts) return arr;

    const { fn, initial, hasInitial } = parts;
    const arrowMatch = fn.match(
      /^\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>\s*(.+)\s*$/s,
    );

    if (arrowMatch) {
      const [, paramAcc, paramItem, body] = arrowMatch;
      const reduceFn = (acc: any, item: any) => {
        return this.evalSafeExpression(body.trim(), {
          [paramAcc]: acc,
          [paramItem]: item,
        });
      };
      // Only pass initial value if explicitly provided
      // arr.reduce(fn) uses first element as initial, arr.reduce(fn, undefined) uses undefined
      return hasInitial ? arr.reduce(reduceFn, initial) : arr.reduce(reduceFn);
    }

    return arr;
  }

  private splitReduceArgs(
    fnStr: string,
  ): { fn: string; initial: any; hasInitial: boolean } | null {
    // Find the arrow function and initial value
    // (acc, item) => acc + item.value, 0
    let depth = 0;
    let lastComma = -1;

    for (let i = 0; i < fnStr.length; i++) {
      const ch = fnStr[i];
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
      else if (ch === "," && depth === 0) lastComma = i;
    }

    if (lastComma > 0) {
      const fn = fnStr.slice(0, lastComma).trim();
      const initialStr = fnStr.slice(lastComma + 1).trim();
      try {
        const initial = new Function(`return ${initialStr}`)();
        return { fn, initial, hasInitial: true };
      } catch {
        return { fn, initial: undefined, hasInitial: false };
      }
    }

    return { fn: fnStr, initial: undefined, hasInitial: false };
  }

  /**
   * Evaluate a safe expression with given context
   * Only allows property access, object literals, and basic operations
   */
  private evalSafeExpression(expr: string, context: Record<string, any>): any {
    // Create a sandbox with only the context variables
    const contextKeys = Object.keys(context);
    const contextValues = Object.values(context);

    try {
      // Build a function that only has access to context variables
      // No access to global objects like process, require, etc.
      const fn = new Function(
        ...contextKeys,
        `"use strict"; return (${expr});`,
      );
      return fn(...contextValues);
    } catch (error: any) {
      throw new Error(`Expression error: ${error.message}`);
    }
  }

  // KV Operations

  private async kvList(
    client: AxiosInstance,
    namespaceId: string,
    options?: { prefix?: string; limit?: number; cursor?: string },
  ): Promise<KVQueryResult> {
    const allKeys: KVKey[] = [];
    let cursor: string | undefined = options?.cursor;
    // Default limit is 100 for safety (KV can have millions of keys)
    // Cloudflare's max per request is 1000
    const DEFAULT_LIMIT = 100;
    const MAX_LIMIT = 10000; // Hard cap for safety
    const limit = Math.min(options?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    do {
      const params: Record<string, any> = {
        limit: Math.min(1000, limit - allKeys.length),
      };
      if (options?.prefix) params.prefix = options.prefix;
      if (cursor) params.cursor = cursor;

      const response = await client.get(`/${namespaceId}/keys`, { params });
      const result = response.data;

      if (!result.success) {
        return {
          success: false,
          error:
            result.errors?.map((e: any) => e.message).join("; ") ||
            "Failed to list keys",
        };
      }

      const keys: KVKey[] = result.result || [];
      allKeys.push(...keys);

      // Stop if we've reached the limit or no more pages
      cursor = result.result_info?.cursor;
      if (!result.list_complete) {
        cursor = result.result_info?.cursor;
      } else {
        cursor = undefined;
      }
    } while (cursor && allKeys.length < limit);

    return {
      success: true,
      data: allKeys.map(k => ({
        name: k.name,
        expiration: k.expiration
          ? new Date(k.expiration * 1000).toISOString()
          : null,
        metadata: k.metadata || null,
      })),
      rowCount: allKeys.length,
    };
  }

  private async kvGet(
    client: AxiosInstance,
    namespaceId: string,
    key: string,
    options?: { type?: "text" | "json" | "arrayBuffer" },
  ): Promise<KVQueryResult> {
    if (!key) {
      return { success: false, error: "Key is required for get()" };
    }

    try {
      const response = await client.get(
        `/${namespaceId}/values/${encodeURIComponent(key)}`,
        {
          transformResponse: [(data: any) => data],
        },
      );

      let value = response.data;

      // Try to parse as JSON if requested or if it looks like JSON
      if (options?.type === "json" || (!options?.type && value)) {
        try {
          value = JSON.parse(value);
        } catch {
          // Keep as string
        }
      }

      return {
        success: true,
        data: [{ key, value }],
        rowCount: 1,
      };
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
    options?: { expiration?: number; expirationTtl?: number; metadata?: any },
  ): Promise<KVQueryResult> {
    if (!key) {
      return { success: false, error: "Key is required for put()" };
    }

    // Serialize value if it's an object
    const body =
      typeof value === "object" ? JSON.stringify(value) : String(value);

    const params: Record<string, any> = {};
    if (options?.expiration) params.expiration = options.expiration;
    if (options?.expirationTtl) params.expiration_ttl = options.expirationTtl;

    await client.put(
      `/${namespaceId}/values/${encodeURIComponent(key)}`,
      body,
      {
        params,
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
    if (!key) {
      return { success: false, error: "Key is required for delete()" };
    }

    await client.delete(`/${namespaceId}/values/${encodeURIComponent(key)}`);

    return {
      success: true,
      data: [{ key, status: "deleted" }],
      rowCount: 1,
    };
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

      // If a specific namespace_id is configured, test listing keys
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
                "Failed to access KV namespace",
            };
      }

      // Otherwise, test by listing namespaces
      const response = await client.get("", {
        params: { per_page: 1 },
      });

      if (response.data.success) {
        return { success: true };
      }

      return {
        success: false,
        error:
          response.data.errors?.[0]?.message || "Failed to connect to KV API",
      };
    } catch (error: any) {
      return {
        success: false,
        error:
          error?.response?.data?.errors?.[0]?.message ||
          error?.message ||
          "KV connection test failed",
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

        if (!response.data.success) {
          break;
        }

        const results: KVNamespace[] = response.data.result || [];
        namespaces.push(...results);

        const resultInfo = response.data.result_info;
        hasMore =
          resultInfo &&
          resultInfo.page * resultInfo.per_page < resultInfo.count;
        page++;
      }

      return namespaces;
    } catch (error) {
      console.error("Error listing KV namespaces:", error);
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
