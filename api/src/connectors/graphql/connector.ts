import {
  BaseConnector,
  ConnectionTestResult,
  FetchOptions,
  ResumableFetchOptions,
  FetchState,
} from "../base/BaseConnector";
import axios, { AxiosInstance } from "axios";
import { loggers } from "../../logging";

const logger = loggers.connector("graphql");

export class GraphQLConnector extends BaseConnector {
  private graphqlClient: AxiosInstance | null = null;

  static getConfigSchema() {
    return {
      fields: [
        {
          name: "endpoint",
          label: "GraphQL Endpoint URL",
          type: "string",
          required: true,
          placeholder: "https://api.example.com/graphql",
          helperText: "The GraphQL endpoint URL (not encrypted)",
        },
        {
          name: "headers",
          label: "Custom Headers (JSON)",
          type: "textarea",
          required: false,
          rows: 6,
          encrypted: true,
          placeholder: `{
  "Authorization": "Bearer your-token-here",
  "X-API-Key": "your-api-key",
  "x-hasura-admin-secret": "your-hasura-secret",
  "X-Custom-Header": "custom-value"
}`,
          helperText:
            "Authentication and custom headers as JSON (encrypted when saved)",
        },
      ],
      // Queries are configured at the Transfer level, not Connector level
      // This schema tells the UI what query fields to show
      transferQueries: {
        label: "GraphQL Queries",
        required: true,
        fields: [
          {
            name: "name",
            label: "Entity Name",
            type: "string",
            required: true,
            placeholder: "items",
            helperText: "Name for this entity (used for collection naming)",
          },
          {
            name: "query",
            label: "GraphQL Query",
            type: "textarea",
            required: true,
            rows: 8,
            placeholder:
              "query GetData($limit: Int!, $offset: Int!) {\n  items(limit: $limit, offset: $offset) {\n    id\n    name\n    created_at\n  }\n}",
            helperText:
              "Your GraphQL query with pagination support ($limit/$offset or $first/$after)",
          },
          {
            name: "data_path",
            label: "Data Path",
            type: "string",
            required: true,
            placeholder: "data.items",
            helperText: "JSONPath to the data array in the response",
          },
          {
            name: "total_count_path",
            label: "Total Count Path",
            type: "string",
            required: false,
            placeholder: "data.items_aggregate.aggregate.count",
            helperText: "JSONPath to total count (for progress tracking)",
          },
          {
            name: "has_next_page_path",
            label: "Has Next Page Path",
            type: "string",
            required: false,
            placeholder: "data.items.pageInfo.hasNextPage",
            helperText: "JSONPath for cursor-based pagination (optional)",
          },
          {
            name: "cursor_path",
            label: "Cursor Path",
            type: "string",
            required: false,
            placeholder: "data.items.pageInfo.endCursor",
            helperText: "JSONPath for next cursor value (optional)",
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
      name: "GraphQL",
      version: "1.0.0",
      description: "Generic GraphQL API connector",
      supportedEntities: this.getAvailableEntities(),
    };
  }

  validateConfig() {
    const base = super.validateConfig();
    const errors = [...base.errors];

    if (!this.dataSource.config.endpoint) {
      errors.push("GraphQL endpoint is required");
    }

    // Validate headers JSON if provided (at top level)
    if (
      this.dataSource.config.headers &&
      typeof this.dataSource.config.headers === "string"
    ) {
      try {
        JSON.parse(this.dataSource.config.headers);
      } catch {
        errors.push("Headers must be valid JSON format");
      }
    }

    // Note: queries are validated at sync time when provided by the transfer
    // Validate queries if present (for backward compatibility and sync-time validation)
    if (
      this.dataSource.config.queries &&
      this.dataSource.config.queries.length > 0
    ) {
      this.dataSource.config.queries.forEach((query: any, index: number) => {
        if (!query.name) {
          errors.push(`Query ${index + 1} is missing a name`);
        }
        if (!query.query) {
          errors.push(`Query ${index + 1} is missing the GraphQL query`);
        }
        if (!query.data_path && !query.dataPath) {
          errors.push(`Query ${index + 1} is missing the data path`);
        }
      });
    }

    return { valid: errors.length === 0, errors };
  }

  private getGraphQLClient(): AxiosInstance {
    if (!this.graphqlClient) {
      if (!this.dataSource.config.endpoint) {
        throw new Error("GraphQL endpoint not configured");
      }

      // Build headers from JSON field
      const headers: { [key: string]: string } = {
        "Content-Type": "application/json",
      };

      // Parse headers from JSON string if provided
      if (this.dataSource.config.headers) {
        try {
          let parsedHeaders: any;

          if (typeof this.dataSource.config.headers === "string") {
            // Parse JSON string
            parsedHeaders = JSON.parse(this.dataSource.config.headers);
          } else if (typeof this.dataSource.config.headers === "object") {
            // Already an object (legacy format)
            parsedHeaders = this.dataSource.config.headers;
          }

          if (parsedHeaders && typeof parsedHeaders === "object") {
            Object.assign(headers, parsedHeaders);
          }
        } catch (error) {
          logger.warn("Failed to parse headers JSON", { error });
          throw new Error("Invalid JSON format in headers field");
        }
      }

      this.graphqlClient = axios.create({
        baseURL: this.dataSource.config.endpoint,
        headers,
      });
    }
    return this.graphqlClient;
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

      const client = this.getGraphQLClient();

      // Test connection with introspection query
      const response = await client.post("", {
        query: `
          query {
            __schema {
              queryType {
                name
              }
            }
          }
        `,
      });

      if (response.data.errors) {
        return {
          success: false,
          message: "GraphQL endpoint returned errors",
          details: response.data.errors,
        };
      }

      return {
        success: true,
        message: "Successfully connected to GraphQL endpoint",
      };
    } catch (error) {
      return {
        success: false,
        message: "Failed to connect to GraphQL endpoint",
        details: axios.isAxiosError(error) ? error.message : String(error),
      };
    }
  }

  getAvailableEntities(): string[] {
    if (!this.dataSource.config.queries) return [];
    return this.dataSource.config.queries.map((q: any) => q.name);
  }

  /**
   * Check if connector supports resumable fetching
   */
  supportsResumableFetching(): boolean {
    return true;
  }

  /**
   * Fetch a chunk of data with resumable state
   */
  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    const {
      entity,
      onBatch,
      onProgress,
      since,
      batchSize,
      rateLimitDelay,
      maxRetries,
      state,
    } = options;
    const maxIterations = options.maxIterations || 10;

    const queryConfig = this.getQueryConfig(entity);
    if (!queryConfig) {
      throw new Error(`Query configuration '${entity}' not found`);
    }

    const settings = {
      batchSize: Number(
        batchSize || queryConfig.batch_size || this.getBatchSize(),
      ),
      rateLimitDelay: rateLimitDelay || this.getRateLimitDelay(),
      maxRetries: maxRetries || this.dataSource.settings?.max_retries || 3,
      timeout: this.dataSource.settings?.timeout_ms || 30000,
    };

    // Initialize or restore state
    let hasMore = state?.hasMore !== false;
    let cursor: string | null = state?.cursor || null;
    let offset = state?.offset || 0;
    let currentCount = state?.totalProcessed || 0;
    let iterations = 0;

    // Fetch total count if this is the first chunk
    let totalCount: number | undefined = state?.metadata?.totalCount;
    if (!state && queryConfig.total_count_path && onProgress) {
      totalCount = await this.fetchTotalCount(queryConfig, settings);
      if (totalCount) {
        onProgress(0, totalCount);
      }
    }

    // Determine pagination type
    const usesCursorPagination =
      queryConfig.query.includes("$after") ||
      queryConfig.query.includes("$cursor");
    const usesOffsetPagination =
      queryConfig.query.includes("$offset") ||
      queryConfig.query.includes("offset:");

    // Add overall chunk timing
    const chunkStart = Date.now();

    while (hasMore && iterations < maxIterations) {
      // Log iteration start
      const iterStart = Date.now();
      logger.info("Iteration started", {
        iteration: iterations,
        cursor: cursor || "none",
      });

      // Build query variables
      let queryVariables: any = {
        ...(queryConfig.variables || {}),
      };

      if (usesCursorPagination) {
        // Infer $after type from the query definition to set a sensible default
        const afterVarType = this.getGraphQLVariableType(
          queryConfig.query,
          "after",
        );
        const defaultAfter = this.getDefaultForAfter(afterVarType);
        queryVariables = {
          ...queryVariables,
          first: Number(settings.batchSize),
          after:
            cursor !== null && cursor !== undefined ? cursor : defaultAfter,
        };
      } else if (usesOffsetPagination) {
        queryVariables = {
          ...queryVariables,
          limit: Number(settings.batchSize),
          offset: Number(offset),
        };
      } else {
        // Default to offset pagination
        queryVariables = {
          ...queryVariables,
          limit: Number(settings.batchSize),
          offset: Number(offset),
        };
      }

      // Execute query (timing already logged in executeGraphQLQuery)
      const queryStart = Date.now();
      const response = await this.executeWithRetry(
        () =>
          this.executeGraphQLQuery(queryConfig.query, queryVariables, settings),
        settings,
      );
      const queryDuration = Date.now() - queryStart;
      logger.info("Full query execution completed", {
        durationMs: queryDuration,
      });

      // Extract data
      const extractStart = Date.now();
      const data = this.getValueByPath(response, queryConfig.data_path);
      if (!Array.isArray(data)) {
        logger.warn("Data at path is not an array", {
          dataPath: queryConfig.data_path,
        });
        hasMore = false;
        break;
      }
      const extractDuration = Date.now() - extractStart;
      logger.info("Data extraction completed", { durationMs: extractDuration });

      // Filter by date if incremental
      let filteredData = data;
      if (since) {
        filteredData = data.filter((record: any) => {
          const updatedAt =
            record.updated_at || record.updatedAt || record.modified_at;
          return updatedAt && new Date(updatedAt) > since;
        });
      }

      // Pass batch to callback (measure insert time)
      if (filteredData.length > 0) {
        const batchStart = Date.now();
        await onBatch(filteredData);
        const batchDuration = Date.now() - batchStart;
        logger.info("Batch processing completed", {
          durationMs: batchDuration,
          recordCount: filteredData.length,
        });
      }

      // Update counts and progress
      const progressStart = Date.now();
      currentCount += filteredData.length;
      if (onProgress) {
        onProgress(currentCount, totalCount);
      }
      const progressDuration = Date.now() - progressStart;
      logger.info("Progress update completed", { durationMs: progressDuration });

      // Check for more pages
      const paginationStart = Date.now();
      if (queryConfig.has_next_page_path) {
        hasMore = this.getValueByPath(response, queryConfig.has_next_page_path);
      } else {
        hasMore = data.length === settings.batchSize;
      }

      // Update pagination
      if (hasMore) {
        if (usesCursorPagination && queryConfig.cursor_path) {
          cursor = this.getValueByPath(response, queryConfig.cursor_path);
        } else {
          offset += settings.batchSize;
        }

        iterations++;

        // Rate limiting
        logger.info("Rate limit delay", {
          delayMs: settings.rateLimitDelay,
        });
        await this.sleep(settings.rateLimitDelay);
      }
      const paginationDuration = Date.now() - paginationStart;
      logger.info("Pagination check completed", {
        durationMs: paginationDuration,
      });

      // Log iteration end
      const iterDuration = Date.now() - iterStart;
      logger.info("Iteration completed", {
        iteration: iterations - 1,
        durationMs: iterDuration,
      });
    }

    // Log overall chunk time
    const chunkDuration = Date.now() - chunkStart;
    logger.info("Chunk completed", {
      durationMs: chunkDuration,
      totalProcessed: currentCount,
      iterations,
    });

    return {
      offset,
      cursor: cursor || undefined,
      totalProcessed: currentCount,
      hasMore,
      iterationsInChunk: iterations,
      metadata: { totalCount },
    };
  }

  async fetchEntity(options: FetchOptions): Promise<void> {
    const {
      entity,
      onBatch,
      onProgress,
      since,
      batchSize,
      rateLimitDelay,
      maxRetries,
    } = options;

    const queryConfig = this.getQueryConfig(entity);
    if (!queryConfig) {
      throw new Error(`Query configuration '${entity}' not found`);
    }

    const settings = {
      batchSize: Number(
        batchSize || queryConfig.batch_size || this.getBatchSize(),
      ),
      rateLimitDelay: rateLimitDelay || this.getRateLimitDelay(),
      maxRetries: maxRetries || this.dataSource.settings?.max_retries || 3,
      timeout: this.dataSource.settings?.timeout_ms || 30000,
    };

    // Fetch total count if available
    let totalCount: number | undefined;
    if (queryConfig.total_count_path && onProgress) {
      totalCount = await this.fetchTotalCount(queryConfig, settings);
      if (totalCount) {
        onProgress(0, totalCount);
      }
    }

    let hasMore = true;
    let cursor: string | null = null;
    let offset = 0;
    let currentCount = 0;

    // Determine pagination type
    const usesCursorPagination =
      queryConfig.query.includes("$after") ||
      queryConfig.query.includes("$cursor");
    const usesOffsetPagination =
      queryConfig.query.includes("$offset") ||
      queryConfig.query.includes("offset:");

    while (hasMore) {
      // Build query variables
      let queryVariables: any = {
        ...(queryConfig.variables || {}),
      };

      if (usesCursorPagination) {
        // Infer $after type from the query definition to set a sensible default
        const afterVarType = this.getGraphQLVariableType(
          queryConfig.query,
          "after",
        );
        const defaultAfter = this.getDefaultForAfter(afterVarType);
        queryVariables = {
          ...queryVariables,
          first: Number(settings.batchSize),
          after:
            cursor !== null && cursor !== undefined ? cursor : defaultAfter,
        };
      } else if (usesOffsetPagination) {
        queryVariables = {
          ...queryVariables,
          limit: Number(settings.batchSize),
          offset: Number(offset),
        };
      } else {
        // Default to offset pagination
        queryVariables = {
          ...queryVariables,
          limit: Number(settings.batchSize),
          offset: Number(offset),
        };
      }

      // Execute query with retry logic
      const response = await this.executeWithRetry(
        () =>
          this.executeGraphQLQuery(queryConfig.query, queryVariables, settings),
        settings,
      );

      // Extract data
      const data = this.getValueByPath(response, queryConfig.data_path);
      if (!Array.isArray(data)) {
        logger.warn("Data at path is not an array", {
          dataPath: queryConfig.data_path,
        });
        break;
      }

      // Filter by date if incremental
      let filteredData = data;
      if (since) {
        filteredData = data.filter((record: any) => {
          const updatedAt =
            record.updated_at || record.updatedAt || record.modified_at;
          return updatedAt && new Date(updatedAt) > since;
        });
      }

      // Pass batch to callback
      if (filteredData.length > 0) {
        await onBatch(filteredData);
      }

      currentCount += filteredData.length;
      if (onProgress) {
        onProgress(currentCount, totalCount);
      }

      // Check for more pages
      if (queryConfig.has_next_page_path) {
        hasMore = this.getValueByPath(response, queryConfig.has_next_page_path);
      } else {
        hasMore = data.length === settings.batchSize;
      }

      // Update pagination
      if (hasMore) {
        if (usesCursorPagination && queryConfig.cursor_path) {
          cursor = this.getValueByPath(response, queryConfig.cursor_path);
        } else {
          offset += settings.batchSize;
        }

        // Rate limiting
        logger.info("Rate limit delay", {
          delayMs: settings.rateLimitDelay,
        });
        await this.sleep(settings.rateLimitDelay);
      }
    }
  }

  private async executeGraphQLQuery(
    query: string,
    variables?: any,
    settings?: any,
  ): Promise<any> {
    logger.info("Starting GraphQL query execution");
    const startTime = Date.now();

    const client = this.getGraphQLClient();
    const response = await client.post(
      "",
      { query, variables },
      {
        timeout: settings?.timeout || 30000,
      },
    );

    const endTime = Date.now();
    const duration = endTime - startTime;
    logger.info("GraphQL server responded", { durationMs: duration });

    if (response.data.errors && response.data.errors.length > 0) {
      const errorMessage = response.data.errors
        .map((err: any) => err.message)
        .join(", ");
      throw new Error(`GraphQL errors: ${errorMessage}`);
    }

    if (!response.data.data) {
      throw new Error("GraphQL response missing data field");
    }

    return response.data;
  }

  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    settings: any,
  ): Promise<T> {
    let attempts = 0;

    while (attempts <= settings.maxRetries) {
      try {
        return await operation();
      } catch (error) {
        attempts++;

        if (attempts > settings.maxRetries) {
          throw error;
        }

        let delayMs: number;

        if (axios.isAxiosError(error) && error.response?.status === 429) {
          const retryAfter = error.response.headers["retry-after"];
          delayMs = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : 1000 * Math.pow(2, attempts);
          logger.warn("Rate limited, waiting before retry", {
            delayMs,
            attempt: attempts,
            maxRetries: settings.maxRetries,
          });
        } else if (this.isRetryableError(error)) {
          const backoff = 500 * Math.pow(2, attempts);
          delayMs = backoff;
          logger.warn("Retryable error, waiting before retry", {
            delayMs,
            attempt: attempts,
            maxRetries: settings.maxRetries,
          });
        } else {
          throw error;
        }

        logger.info("Retry delay", { delayMs });
        await this.sleep(delayMs);
      }
    }

    throw new Error("Max retries exceeded");
  }

  private isRetryableError(error: any): boolean {
    if (axios.isAxiosError(error)) {
      if (!error.response) {
        // Network errors are retryable
        return true;
      }
      // Retry on server errors and rate limiting
      const status = error.response.status;
      return status >= 500 || status === 429;
    }
    return false;
  }

  private async fetchTotalCount(
    queryConfig: any,
    settings: any,
  ): Promise<number | undefined> {
    try {
      // Detect which variables are actually used in the query
      const queryText = queryConfig.query;
      const countVariables: any = {
        ...(queryConfig.variables || {}),
      };

      // Only include variables that are actually in the query
      if (queryText.includes("$limit")) {
        countVariables.limit = 0;
      }
      if (queryText.includes("$first")) {
        countVariables.first = 0;
      }
      if (queryText.includes("$offset")) {
        countVariables.offset = 0;
      }
      if (queryText.includes("$after")) {
        const afterVarType = this.getGraphQLVariableType(
          queryConfig.query,
          "after",
        );
        countVariables.after = this.getDefaultForAfter(afterVarType);
      }

      const response = await this.executeGraphQLQuery(
        queryConfig.query,
        countVariables,
        settings,
      );

      return this.getValueByPath(response, queryConfig.total_count_path);
    } catch (error) {
      logger.warn("Could not fetch total count", { error });
      return undefined;
    }
  }

  // Extract a GraphQL variable's declared type from the query text, e.g.
  // query($after: timestamptz = "1970-01-01") => returns "timestamptz"
  private getGraphQLVariableType(
    queryText: string,
    varName: string,
  ): string | undefined {
    try {
      const regex = new RegExp(`\\$${varName}\\s*:\\s*([!\\[\\]\\w_]+)`, "i");
      const match = queryText.match(regex);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  // Choose a sensible default for the $after variable based on its type.
  // - For Hasura timestamptz/String types, use a string date starting epoch.
  // - For numeric types (Int), use 0.
  private getDefaultForAfter(varType?: string): any {
    if (!varType) return 0;
    const t = varType.toLowerCase();
    if (
      t.includes("timestamptz") ||
      t.includes("timestamp") ||
      t.includes("string")
    ) {
      return "1970-01-01";
    }
    return 0;
  }

  private getQueryConfig(name: string): any {
    if (!this.dataSource.config.queries) return undefined;
    const query = this.dataSource.config.queries.find(
      (q: any) => q.name === name,
    );
    if (!query) return undefined;

    // Normalize property names - check both snake_case and camelCase
    return {
      name: query.name,
      query: query.query,
      variables: query.variables,
      data_path: (query as any)["data_path"] || query.dataPath || "",
      total_count_path:
        (query as any)["total_count_path"] || query.totalCountPath || "",
      has_next_page_path:
        (query as any)["has_next_page_path"] || query.hasNextPagePath || "",
      cursor_path: (query as any)["cursor_path"] || query.cursorPath || "",
      batch_size:
        Number((query as any)["batch_size"] || (query as any)["batchSize"]) ||
        100,
    };
  }

  private getValueByPath(obj: any, path: string): any {
    return path.split(".").reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : null;
    }, obj);
  }
}
