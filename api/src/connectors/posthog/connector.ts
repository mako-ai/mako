import {
  BaseConnector,
  ConnectionTestResult,
  FetchOptions,
  ResumableFetchOptions,
  FetchState,
  EntityMetadata,
  type IncrementalCapabilities,
  type ConnectorEntitySchema,
} from "../base/BaseConnector";
import axios, { AxiosInstance } from "axios";
import { resolvePosthogEntitySchema } from "./schema";

type JsonRecord = Record<string, unknown>;

/** Built-in REST entities (alongside user-defined HogQL query entities). */
export const POSTHOG_BUILTIN_ENTITIES = [
  "surveys",
  "survey_responses",
] as const;

type BuiltinEntity = (typeof POSTHOG_BUILTIN_ENTITIES)[number];

type PaginatedList<T> = {
  results: T[];
  count?: number;
  next?: string | null;
  has_more?: boolean;
  limit?: number;
  offset?: number;
};

function isBuiltinEntity(entity: string): entity is BuiltinEntity {
  return (POSTHOG_BUILTIN_ENTITIES as readonly string[]).includes(entity);
}

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
        // Built-in entities (surveys) can sync without any HogQL queries.
        required: false,
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
              "Optional placeholders: $limit, $offset, and $since / {{since}}. If limit/offset are omitted, pagination will be appended automatically.",
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
      version: "1.1.0",
      description:
        "Connector for PostHog Surveys API and HogQL Query API (each query is an entity)",
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

  private getProjectId(): string {
    return String(this.dataSource.config.project_id);
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

      // Prefer a lightweight surveys list probe (validates survey:read too).
      // Fall back to a trivial HogQL query for keys without survey scope.
      try {
        await this.executeWithRetry(() =>
          this.getHttpClient().get(
            `/api/projects/${this.getProjectId()}/surveys/`,
            { params: { limit: 1 }, timeout: 15000 },
          ),
        );
      } catch {
        await this.executeQuery("SELECT 1 LIMIT 1");
      }

      return {
        success: true,
        message: "Successfully connected to PostHog API",
      };
    } catch (error) {
      return {
        success: false,
        message: "Failed to connect to PostHog API",
        details: axios.isAxiosError(error) ? error.message : String(error),
      };
    }
  }

  private getQueryEntityNames(): string[] {
    const list = this.dataSource.config.queries || [];
    return list
      .filter((q: { name?: unknown; query?: unknown }) => {
        const nameOk = typeof q?.name === "string" && q.name.trim().length > 0;
        const queryOk =
          typeof q?.query === "string" && q.query.trim().length > 0;
        return nameOk && queryOk;
      })
      .map((q: { name: string }) => q.name);
  }

  getAvailableEntities(): string[] {
    return [...POSTHOG_BUILTIN_ENTITIES, ...this.getQueryEntityNames()];
  }

  getEntityMetadata(): EntityMetadata[] {
    const layoutSuggestion = {
      partitionField: "_syncedAt",
      partitionGranularity: "day" as const,
      clusterFields: ["_dataSourceId", "id"],
    };

    const builtins: EntityMetadata[] = [
      {
        name: "surveys",
        label: "Surveys",
        description:
          "PostHog survey definitions (questions, targeting, status)",
        layoutSuggestion: {
          partitionField: "created_at",
          partitionGranularity: "day",
          clusterFields: ["_dataSourceId", "id"],
        },
      },
      {
        name: "survey_responses",
        label: "Survey Responses",
        description:
          "Individual survey responses across all surveys (answers + metadata)",
        layoutSuggestion: {
          partitionField: "submitted_at",
          partitionGranularity: "day",
          clusterFields: ["_dataSourceId", "survey_id", "id"],
        },
      },
    ];

    const queryEntities: EntityMetadata[] = this.getQueryEntityNames().map(
      name => ({
        name,
        label: name,
        description: "HogQL query entity",
        layoutSuggestion,
      }),
    );

    return [...builtins, ...queryEntities];
  }

  async resolveSchema(entity: string): Promise<ConnectorEntitySchema | null> {
    return resolvePosthogEntitySchema(entity);
  }

  supportsResumableFetching(): boolean {
    return true;
  }

  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    const { entity } = options;

    if (entity === "surveys") {
      return this.fetchSurveysChunk(options);
    }
    if (entity === "survey_responses") {
      return this.fetchSurveyResponsesChunk(options);
    }

    return this.fetchHogqlChunk(options);
  }

  async fetchEntity(options: FetchOptions): Promise<void> {
    await this.fetchEntityChunk({
      ...options,
      maxIterations: Number.MAX_SAFE_INTEGER,
    });
  }

  // --- Surveys (REST) ---

  private async fetchSurveysPage(options: {
    limit: number;
    offset: number;
  }): Promise<PaginatedList<JsonRecord>> {
    const response = await this.executeWithRetry(() =>
      this.getHttpClient().get(
        `/api/projects/${this.getProjectId()}/surveys/`,
        {
          params: { limit: options.limit, offset: options.offset },
          timeout: this.dataSource.settings?.timeout_ms || 30000,
        },
      ),
    );
    const data = response.data as PaginatedList<JsonRecord>;
    return {
      results: Array.isArray(data?.results) ? data.results : [],
      count: data?.count,
      next: data?.next ?? null,
    };
  }

  private async fetchSurveysChunk(
    options: ResumableFetchOptions,
  ): Promise<FetchState> {
    const { onBatch, onProgress, since, state } = options;
    const maxIterations = options.maxIterations || 10;
    const batchSize = options.batchSize || this.getBatchSize();
    const rateDelay = options.rateLimitDelay || this.getRateLimitDelay();

    let offset = state?.offset || 0;
    let processed = state?.totalProcessed || 0;
    let iterations = 0;
    let hasMore = state?.hasMore !== false;
    const totalCount = state?.metadata?.totalCount as number | undefined;

    if (!state && onProgress) {
      onProgress(0, undefined);
    }

    while (hasMore && iterations < maxIterations) {
      const page = await this.fetchSurveysPage({ limit: batchSize, offset });
      let records = page.results;

      // Surveys list has no updated-since filter; optional client filter on
      // created_at only (misses later edits — declared as created-anchor).
      if (since instanceof Date) {
        const sinceMs = since.getTime();
        records = records.filter(record => {
          const created =
            typeof record.created_at === "string"
              ? new Date(record.created_at).getTime()
              : NaN;
          return Number.isFinite(created) ? created >= sinceMs : false;
        });
      }

      if (records.length > 0) {
        await onBatch(records);
        processed += records.length;
        if (onProgress) onProgress(processed, page.count ?? totalCount);
      }

      hasMore = Boolean(page.next) || page.results.length === batchSize;
      if (!hasMore) {
        return {
          offset,
          totalProcessed: processed,
          hasMore: false,
          iterationsInChunk: iterations + 1,
          metadata: { totalCount: page.count ?? totalCount },
        };
      }

      offset += batchSize;
      iterations += 1;
      await this.sleep(rateDelay);
    }

    return {
      offset,
      totalProcessed: processed,
      hasMore,
      iterationsInChunk: iterations,
      metadata: { totalCount },
    };
  }

  // --- Survey responses (REST, nested per survey) ---

  private async fetchSurveyResponsesPage(options: {
    surveyId: string;
    limit: number;
    offset: number;
    since?: Date;
  }): Promise<PaginatedList<JsonRecord>> {
    const params: Record<string, string | number | boolean> = {
      limit: options.limit,
      offset: options.offset,
      exclude_archived: false,
    };
    if (options.since instanceof Date) {
      params.since = options.since.toISOString();
    }

    const response = await this.executeWithRetry(() =>
      this.getHttpClient().get(
        `/api/projects/${this.getProjectId()}/surveys/${options.surveyId}/responses/`,
        {
          params,
          timeout: this.dataSource.settings?.timeout_ms || 30000,
        },
      ),
    );
    const data = response.data as PaginatedList<JsonRecord>;
    return {
      results: Array.isArray(data?.results) ? data.results : [],
      has_more: data?.has_more,
      limit: data?.limit,
      offset: data?.offset,
      next: data?.next ?? null,
    };
  }

  private normalizeSurveyResponse(
    surveyId: string,
    row: JsonRecord,
  ): JsonRecord {
    const uuid =
      typeof row.uuid === "string"
        ? row.uuid
        : typeof row.id === "string"
          ? row.id
          : undefined;
    return {
      ...row,
      id: uuid ?? `${surveyId}:${String(row.submitted_at ?? "")}`,
      uuid: uuid ?? null,
      survey_id: surveyId,
    };
  }

  private async fetchSurveyResponsesChunk(
    options: ResumableFetchOptions,
  ): Promise<FetchState> {
    const { onBatch, onProgress, since, state } = options;
    const maxIterations = options.maxIterations || 10;
    const batchSize = options.batchSize || this.getBatchSize();
    const rateDelay = options.rateLimitDelay || this.getRateLimitDelay();

    // Resume: walk surveys by offset, then responses within the current survey.
    let surveyOffset = (state?.metadata?.surveyOffset as number) ?? 0;
    let responseOffset = (state?.metadata?.responseOffset as number) ?? 0;
    let currentSurveyId =
      (state?.metadata?.currentSurveyId as string | undefined) ?? undefined;
    const surveysDone =
      (state?.metadata?.surveysDone as boolean | undefined) ?? false;
    let processed = state?.totalProcessed || 0;
    let iterations = 0;

    if (!state && onProgress) {
      onProgress(0, undefined);
    }

    while (iterations < maxIterations) {
      if (!currentSurveyId) {
        if (surveysDone) {
          return {
            totalProcessed: processed,
            hasMore: false,
            iterationsInChunk: iterations,
            metadata: {
              surveyOffset,
              responseOffset: 0,
              currentSurveyId: null,
              surveysDone: true,
            },
          };
        }

        const surveysPage = await this.fetchSurveysPage({
          limit: 1,
          offset: surveyOffset,
        });
        if (surveysPage.results.length === 0) {
          return {
            totalProcessed: processed,
            hasMore: false,
            iterationsInChunk: iterations + 1,
            metadata: {
              surveyOffset,
              responseOffset: 0,
              currentSurveyId: null,
              surveysDone: true,
            },
          };
        }

        const nextSurvey = surveysPage.results[0];
        const nextId =
          typeof nextSurvey?.id === "string" ? nextSurvey.id : null;
        if (!nextId) {
          surveyOffset += 1;
          iterations += 1;
          continue;
        }

        currentSurveyId = nextId;
        responseOffset = 0;
        // Advance survey cursor now so a crash after finishing responses
        // resumes on the next survey, not the current one again.
        surveyOffset += 1;
        iterations += 1;
        await this.sleep(rateDelay);
        if (iterations >= maxIterations) break;
      }

      const page = await this.fetchSurveyResponsesPage({
        surveyId: currentSurveyId,
        limit: batchSize,
        offset: responseOffset,
        since: since instanceof Date ? since : undefined,
      });

      const records = page.results.map(row =>
        this.normalizeSurveyResponse(currentSurveyId as string, row),
      );

      if (records.length > 0) {
        await onBatch(records);
        processed += records.length;
        if (onProgress) onProgress(processed, undefined);
      }

      const pageHasMore =
        typeof page.has_more === "boolean"
          ? page.has_more
          : Boolean(page.next) || page.results.length === batchSize;

      iterations += 1;

      if (pageHasMore) {
        responseOffset += batchSize;
      } else {
        // Move to next survey; empty surveys page on the next loop ends the run.
        currentSurveyId = undefined;
        responseOffset = 0;
      }

      await this.sleep(rateDelay);
    }

    return {
      totalProcessed: processed,
      hasMore: !surveysDone || Boolean(currentSurveyId),
      iterationsInChunk: iterations,
      metadata: {
        surveyOffset,
        responseOffset,
        currentSurveyId: currentSurveyId ?? null,
        surveysDone,
      },
    };
  }

  // --- HogQL query entities ---

  private async fetchHogqlChunk(
    options: ResumableFetchOptions,
  ): Promise<FetchState> {
    const { entity, onBatch, onProgress, since, state } = options;
    const maxIterations = options.maxIterations || 10;

    const q = this.getQueryConfig(entity);
    if (!q || !q.query || q.query.trim().length === 0) {
      if (isBuiltinEntity(entity)) {
        throw new Error(`Unsupported PostHog entity: ${entity}`);
      }
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
      const paginated = this.buildPaginatedQuery(
        q.query,
        batchSize,
        offset,
        since instanceof Date ? since : undefined,
      );
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

  // --- Helpers ---
  private getQueryConfig(
    name: string,
  ): { name: string; query: string; batch_size?: number } | undefined {
    const queries = this.dataSource.config.queries || [];
    const found = queries.find((q: { name?: string }) => q.name === name);
    if (!found) return undefined;
    return {
      name: found.name,
      query: found.query,
      batch_size:
        Number(
          (found as { batch_size?: number; batchSize?: number })[
            "batch_size"
          ] || (found as { batchSize?: number })["batchSize"],
        ) || undefined,
    };
  }

  private buildPaginatedQuery(
    baseQuery: string,
    limit: number,
    offset: number,
    since?: Date,
  ): string {
    let q = baseQuery;

    // Replace common placeholders first
    q = q.replace(/\$limit\b/gi, String(limit));
    q = q.replace(/\$offset\b/gi, String(offset));
    q = q.replace(/\{\{\s*limit\s*\}\}/gi, String(limit));
    q = q.replace(/\{\{\s*offset\s*\}\}/gi, String(offset));

    const sinceValue =
      since instanceof Date ? since.toISOString() : "1970-01-01T00:00:00.000Z";
    if (/\$since\b|\{\{\s*since\s*\}\}/i.test(q)) {
      q = q.replace(/\$since\b/gi, sinceValue);
      q = q.replace(/\{\{\s*since\s*\}\}/gi, sinceValue);
    }

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

  private async executeQuery(hogqlQuery: string): Promise<unknown> {
    const client = this.getHttpClient();
    const projectId = this.getProjectId();

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

  private extractRows(response: unknown): unknown[] {
    if (!response || typeof response !== "object") return [];
    const rows = (response as { results?: unknown }).results;
    return Array.isArray(rows) ? rows : [];
  }

  private mapRowsToObjects(rows: unknown[], response: unknown): unknown[] {
    const columns: string[] = Array.isArray(
      (response as { columns?: unknown })?.columns,
    )
      ? (response as { columns: string[] }).columns
      : [];

    if (columns.length === 0) {
      // Fallback: wrap raw rows
      return rows.map(r => ({ value: r }));
    }

    return rows.map(row => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) {
        const key = columns[i] || `col_${i}`;
        obj[key] = Array.isArray(row) ? row[i] : (row as unknown[])?.[i];
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

  getIncrementalCapabilities(): IncrementalCapabilities {
    return {
      supported: true,
      // HogQL query entities substitute $since when the placeholder is present.
      mode: "native",
      anchorField: "$since",
      perEntity: {
        // Surveys list has no updated-since filter; client filter on created_at
        // misses later edits to an existing survey.
        surveys: { mode: "created-anchor", anchorField: "created_at" },
        // Responses API accepts a real `since` query parameter.
        survey_responses: { mode: "native", anchorField: "since" },
      },
      warning:
        "Incremental substitutes $since/{{since}} in your HogQL. Queries without that placeholder still full-repull every poll — add the placeholder or use Full Refresh. Surveys only filter by created_at (edits need a full reconcile).",
    };
  }
}
