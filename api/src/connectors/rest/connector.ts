import {
  BaseConnector,
  ConnectionTestResult,
  FetchOptions,
  ResumableFetchOptions,
  FetchState,
  type IncrementalCapabilities,
} from "../base/BaseConnector";
import axios, { AxiosInstance, AxiosRequestConfig } from "axios";

type JsonRecord = Record<string, any>;

export class RestConnector extends BaseConnector {
  private httpClient: AxiosInstance | null = null;

  static getConfigSchema() {
    return {
      fields: [
        {
          name: "api_base_url",
          label: "API Base URL",
          type: "string",
          required: false,
          placeholder: "https://api.example.com",
          helperText: "Base URL for the REST API",
        },
        {
          name: "headers",
          label: "Headers (JSON)",
          type: "textarea",
          required: false,
          rows: 6,
          encrypted: true,
          placeholder: `{
  "Authorization": "Bearer <token>",
  "X-API-Key": "<key>"
}`,
          helperText: "Custom request headers as JSON (encrypted when saved)",
        },
        {
          name: "entities",
          label: "Entities",
          type: "object_array",
          required: false,
          itemFields: [
            {
              name: "name",
              label: "Entity Name",
              type: "string",
              required: true,
            },
            {
              name: "path",
              label: "Endpoint Path",
              type: "string",
              required: true,
              placeholder: "/items",
            },
            {
              name: "method",
              label: "HTTP Method",
              type: "select",
              required: false,
              default: "GET",
              options: [
                { label: "GET", value: "GET" },
                { label: "POST", value: "POST" },
                { label: "PUT", value: "PUT" },
                { label: "PATCH", value: "PATCH" },
                { label: "DELETE", value: "DELETE" },
              ],
            },
            {
              name: "params",
              label: "Static Params (JSON)",
              type: "textarea",
              required: false,
              rows: 4,
            },
            {
              name: "body",
              label: "Request Body (JSON)",
              type: "textarea",
              required: false,
              rows: 10,
              placeholder: `{
  "name": "Example",
  "active": true
}`,
              helperText:
                "JSON payload sent for POST/PUT/PATCH/DELETE (similar to Postman Body)",
              showIf: { field: "method", equals: ["POST"] },
            },
            {
              name: "data_path",
              label: "Data Path",
              type: "string",
              required: false,
              placeholder: "data.items",
            },
            {
              name: "total_count_path",
              label: "Total Count Path",
              type: "string",
              required: false,
              placeholder: "data.total",
            },
            {
              name: "page_param",
              label: "Page Param",
              type: "string",
              required: false,
              placeholder: "page",
            },
            {
              name: "limit_param",
              label: "Limit Param",
              type: "string",
              required: false,
              placeholder: "limit",
            },
            {
              name: "offset_param",
              label: "Offset Param",
              type: "string",
              required: false,
              placeholder: "offset",
            },
            {
              name: "cursor_param",
              label: "Cursor Param",
              type: "string",
              required: false,
              placeholder: "cursor",
            },
            {
              name: "next_cursor_path",
              label: "Next Cursor Path",
              type: "string",
              required: false,
              placeholder: "data.next_cursor",
            },
            {
              name: "has_more_path",
              label: "Has More Path",
              type: "string",
              required: false,
              placeholder: "data.has_more",
            },
            {
              name: "batch_size",
              label: "Batch Size",
              type: "number",
              required: false,
              default: 100,
            },
          ],
        },
      ],
    };
  }

  getMetadata() {
    return {
      name: "REST",
      version: "1.0.0",
      description: "Generic REST connector",
      supportedEntities: this.getAvailableEntities(),
    };
  }

  validateConfig() {
    const base = super.validateConfig();
    const errors = [...base.errors];

    if (!this.dataSource.config.api_base_url) {
      errors.push("API base URL is required");
    }

    if (
      !Array.isArray(this.dataSource.config.entities) ||
      this.dataSource.config.entities.length === 0
    ) {
      errors.push("At least one entity must be configured");
    }

    if (
      this.dataSource.config.headers &&
      typeof this.dataSource.config.headers === "string"
    ) {
      try {
        JSON.parse(this.dataSource.config.headers);
      } catch {
        errors.push("Headers must be valid JSON");
      }
    }

    if (Array.isArray(this.dataSource.config.entities)) {
      this.dataSource.config.entities.forEach((e: any, i: number) => {
        if (e.params && typeof e.params === "string") {
          try {
            JSON.parse(e.params);
          } catch {
            errors.push(`Entity ${i + 1} params must be valid JSON`);
          }
        }
        if (e.body && typeof e.body === "string") {
          try {
            JSON.parse(e.body);
          } catch {
            errors.push(`Entity ${i + 1} body must be valid JSON`);
          }
        }
      });
    }

    return { valid: errors.length === 0, errors };
  }

  private getHttpClient(): AxiosInstance {
    if (!this.httpClient) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      const cfgHeaders = this.dataSource.config.headers;
      if (cfgHeaders) {
        try {
          const parsed =
            typeof cfgHeaders === "string"
              ? JSON.parse(cfgHeaders)
              : cfgHeaders;
          Object.assign(headers, parsed);
        } catch {
          throw new Error("Invalid JSON in headers configuration");
        }
      }

      this.httpClient = axios.create({
        baseURL: this.dataSource.config.api_base_url,
        headers,
      });
    }
    return this.httpClient;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const validation = this.validateConfig();
      if (!validation.valid) {
        return {
          success: false,
          message: "Invalid configuration",
          details: validation.errors,
        };
      }

      const client = this.getHttpClient();
      await client.get("/");
      return { success: true, message: "Successfully connected to REST API" };
    } catch (error) {
      return {
        success: false,
        message: "Failed to connect to REST API",
        details: axios.isAxiosError(error) ? error.message : String(error),
      };
    }
  }

  getAvailableEntities(): string[] {
    const list = this.dataSource.config.entities || [];
    return list.map((e: any) => e.name);
  }

  supportsResumableFetching(): boolean {
    return true;
  }

  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    const { entity, onBatch, onProgress, since, state } = options;
    const maxIterations = options.maxIterations || 10;

    const def = this.getEntityConfig(entity);
    if (!def) throw new Error(`Entity configuration '${entity}' not found`);

    const client = this.getHttpClient();
    const batchSize = Number(
      options.batchSize || def.batch_size || this.getBatchSize(),
    );
    const rateDelay = options.rateLimitDelay || this.getRateLimitDelay();

    let page = state?.page || 1;
    let offset = state?.offset || 0;
    let cursor: string | undefined = state?.cursor;
    let processed = state?.totalProcessed || 0;
    let iterations = 0;
    let hasMore = state?.hasMore !== false;

    let totalCount: number | undefined = state?.metadata?.totalCount;
    if (!state && def.total_count_path && onProgress) {
      try {
        const resp = await this.performRequest(client, def, {
          page,
          limit: batchSize,
          offset,
          cursor,
          since,
          preview: true,
        });
        totalCount = this.getValueByPath(resp, def.total_count_path);
        if (typeof totalCount === "number") onProgress(0, totalCount);
      } catch {
        // ignore preview errors when probing total count
      }
    }

    while (hasMore && iterations < maxIterations) {
      const resp = await this.performRequest(client, def, {
        page,
        limit: batchSize,
        offset,
        cursor,
        since,
      });

      const dataArray = def.data_path
        ? this.getValueByPath(resp, def.data_path)
        : resp;
      const items: any[] = Array.isArray(dataArray)
        ? dataArray
        : Array.isArray(resp?.data)
          ? resp.data
          : [];

      let filtered = items;
      if (since) {
        filtered = items.filter((r: any) => {
          const ts =
            r.updated_at || r.updatedAt || r.modified_at || r.modifiedAt;
          return ts ? new Date(ts) > since : true;
        });
      }

      if (filtered.length > 0) {
        await onBatch(filtered);
        processed += filtered.length;
        if (onProgress) onProgress(processed, totalCount);
      }

      if (def.has_more_path) {
        hasMore = !!this.getValueByPath(resp, def.has_more_path);
      } else if (def.cursor_param && def.next_cursor_path) {
        const next = this.getValueByPath(resp, def.next_cursor_path);
        hasMore = Boolean(next);
        cursor = next || cursor;
      } else {
        hasMore = items.length === batchSize;
      }

      if (!hasMore) break;

      if (def.cursor_param && def.next_cursor_path) {
        cursor = this.getValueByPath(resp, def.next_cursor_path) || cursor;
      } else if (def.page_param) {
        page += 1;
      } else if (def.offset_param) {
        offset += batchSize;
      } else {
        offset += batchSize;
      }

      iterations += 1;
      await this.sleep(rateDelay);
    }

    return {
      page,
      offset,
      cursor,
      totalProcessed: processed,
      hasMore,
      iterationsInChunk: iterations,
      metadata: { totalCount },
    };
  }

  async fetchEntity(options: FetchOptions): Promise<void> {
    const state = await this.fetchEntityChunk({
      ...options,
      maxIterations: Number.MAX_SAFE_INTEGER,
    });
    if (state.hasMore) {
      // no-op
    }
  }

  private getEntityConfig(name: string) {
    const entities = this.dataSource.config.entities || [];
    const found = entities.find((e: any) => e.name === name);
    if (!found) return undefined;
    return {
      name: found.name,
      path: found.path,
      method: (found.method || "GET").toUpperCase(),
      data_path: (found as any)["data_path"] || found.dataPath || "",
      total_count_path:
        (found as any)["total_count_path"] || found.totalCountPath || "",
      page_param: found.page_param || found.pageParam || "",
      limit_param: found.limit_param || found.limitParam || "",
      offset_param: found.offset_param || found.offsetParam || "",
      cursor_param: found.cursor_param || found.cursorParam || "",
      next_cursor_path:
        (found as any)["next_cursor_path"] || found.nextCursorPath || "",
      has_more_path: (found as any)["has_more_path"] || found.hasMorePath || "",
      batch_size:
        Number((found as any)["batch_size"] || found.batchSize) || undefined,
      params: this.normalizeJson(found.params),
      body: this.normalizeJson(found.body),
    };
  }

  private normalizeJson(value: any): JsonRecord | undefined {
    if (!value) return undefined;
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return undefined;
      }
    }
    if (typeof value === "object") return value as JsonRecord;
    return undefined;
  }

  private async performRequest(
    client: AxiosInstance,
    def: any,
    opts: {
      page?: number;
      limit?: number;
      offset?: number;
      cursor?: string | undefined;
      since?: Date;
      preview?: boolean;
    },
  ): Promise<any> {
    const params: Record<string, any> = { ...(def.params || {}) };

    if (def.limit_param) params[def.limit_param] = opts.limit;
    if (def.page_param) params[def.page_param] = opts.page;
    if (def.offset_param) params[def.offset_param] = opts.offset;
    if (def.cursor_param && opts.cursor) params[def.cursor_param] = opts.cursor;

    if (opts.since) {
      if (
        params["updated_after"] === undefined &&
        params["updatedAfter"] === undefined
      ) {
        params["updated_after"] = opts.since.toISOString();
      }
    }

    const config: AxiosRequestConfig = { params };

    if (def.method === "GET") {
      const res = await client.get(def.path, config);
      return res.data;
    }

    const res = await client.request({
      url: def.path,
      method: def.method,
      params,
      data: def.body || {},
    });
    return res.data;
  }

  private getValueByPath(obj: any, path: string): any {
    if (!path) return obj;
    return path.split(".").reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : null;
    }, obj);
  }

  getIncrementalCapabilities(): IncrementalCapabilities {
    return {
      // Entities are user-defined API endpoints, so this can't be scoped
      // per entity. `performRequest` injects `updated_after`/`updatedAfter`
      // (best-effort — the target API may ignore it) and the fetch loop then
      // client-filters by `updated_at`/`updated_at`/`modified_at`/
      // `modifiedAt`, but *keeps* any record missing that field entirely, so
      // endpoints without a timestamp field silently behave like "none".
      supported: true,
      mode: "client-filter",
      warning:
        "Incremental depends on the target API returning an updated_at/modified_at field and honoring updated_after; records without a timestamp field are always included.",
    };
  }
}
