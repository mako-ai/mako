import {
  BaseConnector,
  ConnectionTestResult,
  FetchOptions,
  ResumableFetchOptions,
  FetchState,
} from "../base/BaseConnector";
import axios, { AxiosInstance } from "axios";

type JsonRecord = Record<string, any>;

export class PosthogConnector extends BaseConnector {
  private httpClient: AxiosInstance | null = null;

  static getConfigSchema() {
    return {
      fields: [
        {
          name: "api_base_url",
          label: "API Base URL",
          type: "string",
          required: false,
          default: "https://app.posthog.com",
          helperText:
            "Base URL for PostHog API (e.g. https://us.posthog.com or https://eu.posthog.com)",
        },
        {
          name: "project_id",
          label: "Project ID",
          type: "string",
          required: true,
          helperText: "PostHog Project ID (numeric)",
        },
        {
          name: "api_key",
          label: "API Key",
          type: "password",
          required: true,
          helperText:
            "Personal API key (recommended) or Project API key depending on Auth Type",
        },
        {
          name: "auth_type",
          label: "Auth Type",
          type: "select",
          required: false,
          default: "personal_api_key",
          options: [
            { label: "Personal API Key (Bearer)", value: "personal_api_key" },
            {
              label: "Project API Key (POSTHOG-API-TOKEN)",
              value: "project_api_key",
            },
          ],
        },
      ],
      // Queries are configured at the Transfer level, not Connector level
      // This schema tells the UI what query fields to show
      transferQueries: {
        label: "HogQL Queries",
        required: true,
        fields: [
          {
            name: "name",
            label: "Entity Name",
            type: "string",
            required: true,
            placeholder: "events_7d",
            helperText: "Name used as entity and collection name",
          },
          {
            name: "query",
            label: "HogQL Query",
            type: "textarea",
            required: true,
            rows: 8,
            placeholder:
              "SELECT event, count() AS cnt FROM events WHERE timestamp > now() - interval 7 day GROUP BY event ORDER BY cnt DESC",
            helperText:
              "Optional placeholders: $limit and $offset. If omitted, pagination will be appended automatically.",
          },
          {
            name: "batch_size",
            label: "Batch Size",
            type: "number",
            required: false,
            default: 100,
            placeholder: "100",
            helperText: "Number of records per request",
          },
        ],
      },
    };
  }

  getMetadata() {
    return {
      name: "PostHog",
      version: "1.0.0",
      description:
        "Connector for PostHog HogQL Query API (each query is an entity)",
      supportedEntities: this.getAvailableEntities(),
    };
  }

  validateConfig() {
    const base = super.validateConfig();
    const errors = [...base.errors];

    if (!this.dataSource.config.project_id) {
      errors.push("PostHog project_id is required");
    }
    if (!this.dataSource.config.api_key) {
      errors.push("PostHog api_key is required");
    }
    // Note: queries are now configured at the Transfer level, not Connector level
    // Validation happens at sync time when queries are injected

    return { valid: errors.length === 0, errors };
  }

  private getHttpClient(): AxiosInstance {
    if (!this.httpClient) {
      const baseURL =
        this.dataSource.config.api_base_url || "https://app.posthog.com";
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      const authType = this.dataSource.config.auth_type || "personal_api_key";
      const apiKey = this.dataSource.config.api_key as string;
      if (authType === "project_api_key") {
        headers["POSTHOG-API-TOKEN"] = apiKey;
      } else {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      this.httpClient = axios.create({ baseURL, headers });
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

      // Run a trivial query to validate auth and project access
      await this.executeQuery("SELECT 1 LIMIT 1");

      return {
        success: true,
        message: "Successfully connected to PostHog Query API",
      };
    } catch (error) {
      return {
        success: false,
        message: "Failed to connect to PostHog API",
        details: axios.isAxiosError(error) ? error.message : String(error),
      };
    }
  }

  getAvailableEntities(): string[] {
    const list = this.dataSource.config.queries || [];
    // Only include queries that have required fields filled in
    return list
      .filter((q: any) => {
        const nameOk = typeof q?.name === "string" && q.name.trim().length > 0;
        const queryOk =
          typeof q?.query === "string" && q.query.trim().length > 0;
        return nameOk && queryOk;
      })
      .map((q: any) => q.name);
  }

  supportsResumableFetching(): boolean {
    return true;
  }

  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    const { entity, onBatch, onProgress, state } = options;
    const maxIterations = options.maxIterations || 10;

    const q = this.getQueryConfig(entity);
    if (!q || !q.query || q.query.trim().length === 0) {
      // Treat as empty/incomplete configuration; skip gracefully
      if (onProgress) onProgress(0, undefined);
      return {
        offset: state?.offset || 0,
        totalProcessed: state?.totalProcessed || 0,
        hasMore: false,
        iterationsInChunk: 0,
      };
    }

    const batchSize = Number(
      q.batch_size || options.batchSize || this.getBatchSize(),
    );
    const rateDelay = options.rateLimitDelay || this.getRateLimitDelay();

    let offset = state?.offset || 0;
    let processed = state?.totalProcessed || 0;
    let iterations = 0;
    let hasMore = state?.hasMore !== false;

    // PostHog Query API does not expose total counts easily; progress uses current only
    if (!state && onProgress) onProgress(0, undefined);

    while (hasMore && iterations < maxIterations) {
      const paginated = this.buildPaginatedQuery(q.query, batchSize, offset);
      const response = await this.executeWithRetry(() =>
        this.executeQuery(paginated),
      );

      const rows = this.extractRows(response);
      const objects = this.mapRowsToObjects(rows, response);

      if (objects.length > 0) {
        await onBatch(objects);
        processed += objects.length;
        if (onProgress) onProgress(processed, undefined);
      }

      hasMore = objects.length === batchSize;
      if (!hasMore) break;

      offset += batchSize;
      iterations += 1;
      await this.sleep(rateDelay);
    }

    return {
      offset,
      totalProcessed: processed,
      hasMore,
      iterationsInChunk: iterations,
    };
  }

  async fetchEntity(options: FetchOptions): Promise<void> {
    await this.fetchEntityChunk({
      ...options,
      maxIterations: Number.MAX_SAFE_INTEGER,
    });
  }

  // --- Helpers ---
  private getQueryConfig(
    name: string,
  ): { name: string; query: string; batch_size?: number } | undefined {
    const queries = this.dataSource.config.queries || [];
    const found = queries.find((q: any) => q.name === name);
    if (!found) return undefined;
    return {
      name: found.name,
      query: found.query,
      batch_size:
        Number((found as any)["batch_size"] || (found as any)["batchSize"]) ||
        undefined,
    };
  }

  private buildPaginatedQuery(
    baseQuery: string,
    limit: number,
    offset: number,
  ): string {
    let q = baseQuery;

    // Replace common placeholders first
    q = q.replace(/\$limit\b/gi, String(limit));
    q = q.replace(/\$offset\b/gi, String(offset));
    q = q.replace(/\{\{\s*limit\s*\}\}/gi, String(limit));
    q = q.replace(/\{\{\s*offset\s*\}\}/gi, String(offset));

    const hasExplicitLimit = /\blimit\b\s+\d+/i.test(q);
    const hasExplicitOffset = /\boffset\b\s+\d+/i.test(q);

    // If user didn't specify limit/offset explicitly or with placeholders, append them
    if (!hasExplicitLimit && !/\$limit|\{\{\s*limit\s*\}\}/i.test(baseQuery)) {
      q = `${q} LIMIT ${limit}`;
    }
    if (
      !hasExplicitOffset &&
      !/\$offset|\{\{\s*offset\s*\}\}/i.test(baseQuery)
    ) {
      q = `${q} OFFSET ${offset}`;
    }

    return q;
  }

  private async executeQuery(hogqlQuery: string): Promise<any> {
    const client = this.getHttpClient();
    const projectId = this.dataSource.config.project_id;

    const body: JsonRecord = {
      query: {
        kind: "HogQLQuery",
        query: hogqlQuery,
      },
    };

    const res = await client.post(`/api/projects/${projectId}/query/`, body, {
      timeout: this.dataSource.settings?.timeout_ms || 30000,
    });
    return res.data;
  }

  private extractRows(response: any): any[] {
    if (!response) return [];
    // PostHog returns tabular data as arrays in `results`
    const rows = Array.isArray(response?.results) ? response.results : [];
    return rows;
  }

  private mapRowsToObjects(rows: any[], response: any): any[] {
    const columns: string[] = Array.isArray(response?.columns)
      ? response.columns
      : [];

    if (columns.length === 0) {
      // Fallback: wrap raw rows
      return rows.map(r => ({ value: r }));
    }

    return rows.map(row => {
      const obj: Record<string, any> = {};
      for (let i = 0; i < columns.length; i++) {
        const key = columns[i] || `col_${i}`;
        obj[key] = Array.isArray(row) ? row[i] : row?.[i];
      }
      return obj;
    });
  }

  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    const maxRetries = this.dataSource.settings?.max_retries || 3;
    let attempts = 0;
    while (attempts <= maxRetries) {
      try {
        return await operation();
      } catch (error) {
        attempts++;
        if (attempts > maxRetries) throw error;

        let delayMs = 500 * Math.pow(2, attempts);
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          const retryAfter = error.response.headers["retry-after"];
          delayMs = retryAfter
            ? parseInt(String(retryAfter), 10) * 1000
            : delayMs;
        }
        await this.sleep(delayMs);
      }
    }
    throw new Error("Max retries exceeded");
  }
}
