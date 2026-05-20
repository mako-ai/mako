import {
  BaseConnector,
  ConnectionTestResult,
  FetchOptions,
  ResumableFetchOptions,
  FetchState,
  WebhookVerificationResult,
  WebhookHandlerOptions,
  WebhookEventMapping,
  EntityMetadata,
  NormalizedCdcRecord,
  type ConnectorEntitySchema,
} from "../base/BaseConnector";
import { resolveClaapEntitySchema } from "./schema";
import axios, { AxiosError, AxiosInstance } from "axios";
import { loggers } from "../../logging";

const logger = loggers.connector("claap");

const DEFAULT_BASE_URL = "https://api.claap.io";
const MAX_PAGE_LIMIT = 100;

const SUPPORTED_WEBHOOK_EVENTS = [
  "recording_added",
  "recording_updated",
] as const;

type ClaapListRecordingsResult = {
  recordings: Record<string, unknown>[];
  pagination: {
    nextCursor?: string;
    totalCount?: number;
  };
};

export class ClaapConnector extends BaseConnector {
  private claapApi: AxiosInstance | null = null;

  static getConfigSchema() {
    return {
      fields: [
        {
          name: "api_key",
          label: "API Key",
          type: "password",
          required: true,
          helperText:
            "Claap workspace API key (X-Claap-Key). Generate in Claap settings.",
        },
        {
          name: "api_base_url",
          label: "API Base URL",
          type: "string",
          required: false,
          default: DEFAULT_BASE_URL,
        },
      ],
    };
  }

  getMetadata() {
    return {
      name: "Claap",
      version: "1.0.0",
      description:
        "Connector for Claap meeting recordings, workspace metadata, and webhooks",
      supportedEntities: ["recordings", "workspace"],
    };
  }

  validateConfig() {
    const base = super.validateConfig();
    const errors = [...base.errors];

    if (!this.dataSource.config.api_key) {
      errors.push("Claap API key is required");
    }

    return { valid: errors.length === 0, errors };
  }

  private getBaseUrl(): string {
    const configured = this.dataSource.config.api_base_url;
    if (typeof configured === "string" && configured.trim().length > 0) {
      return configured.trim().replace(/\/+$/, "");
    }
    return DEFAULT_BASE_URL;
  }

  private getClaapClient(): AxiosInstance {
    if (!this.claapApi) {
      if (!this.dataSource.config.api_key) {
        throw new Error("Claap API key not configured");
      }

      this.claapApi = axios.create({
        baseURL: this.getBaseUrl(),
        headers: {
          "X-Claap-Key": this.dataSource.config.api_key,
          "Content-Type": "application/json",
        },
      });
    }
    return this.claapApi;
  }

  private headerValue(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string | undefined {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== lower) continue;
      if (Array.isArray(value)) return value[0];
      return value;
    }
    return undefined;
  }

  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    maxRetries = 5,
  ): Promise<T> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await fn();
      } catch (error) {
        const axiosError = error as AxiosError;
        const status = axiosError.response?.status;
        const retryable =
          status === 429 ||
          (status !== undefined && status >= 500 && status < 600);

        if (!retryable || attempt >= maxRetries) {
          throw error;
        }

        const retryAfterHeader = axiosError.response?.headers?.["retry-after"];
        const retryAfterSeconds = parseInt(
          String(retryAfterHeader ?? "60"),
          10,
        );
        const delayMs = Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds * 1000
          : Math.min(1000 * 2 ** attempt, 60_000);

        logger.warn("Claap API rate limited or server error, retrying", {
          status,
          attempt: attempt + 1,
          delayMs,
        });
        await this.sleep(delayMs);
        attempt++;
      }
    }
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

      const api = this.getClaapClient();
      await this.executeWithRetry(() => api.get("/v1/workspaces/mine"));

      return {
        success: true,
        message: "Successfully connected to Claap API",
      };
    } catch (error) {
      return {
        success: false,
        message: "Failed to connect to Claap API",
        details: axios.isAxiosError(error)
          ? (error.response?.data as { message?: string })?.message ||
            error.message
          : String(error),
      };
    }
  }

  getAvailableEntities(): string[] {
    return ["recordings", "workspace"];
  }

  getEntityMetadata(): EntityMetadata[] {
    const layoutSuggestion = {
      partitionField: "createdAt",
      partitionGranularity: "day" as const,
      clusterFields: ["_dataSourceId", "id"],
    };

    return [
      {
        name: "recordings",
        label: "Recordings",
        description: "Claap meeting and clip recordings",
        layoutSuggestion,
      },
      {
        name: "workspace",
        label: "Workspace",
        description: "Claap workspace metadata",
        layoutSuggestion: {
          partitionField: "createdAt",
          partitionGranularity: "day" as const,
          clusterFields: ["_dataSourceId", "id"],
        },
      },
    ];
  }

  async resolveSchema(entity: string): Promise<ConnectorEntitySchema | null> {
    return resolveClaapEntitySchema(entity);
  }

  supportsResumableFetching(): boolean {
    return true;
  }

  private parseListRecordingsResponse(
    data: unknown,
  ): ClaapListRecordingsResult {
    const result = (data as { result?: ClaapListRecordingsResult })?.result;
    return {
      recordings: Array.isArray(result?.recordings) ? result.recordings : [],
      pagination: result?.pagination ?? {},
    };
  }

  private async fetchRecordingsPage(options: {
    cursor?: string;
    since?: Date;
    limit?: number;
  }): Promise<ClaapListRecordingsResult> {
    const api = this.getClaapClient();
    const params: Record<string, string | number> = {
      limit: Math.min(options.limit ?? this.getBatchSize(), MAX_PAGE_LIMIT),
      sort: "created_asc",
    };

    if (options.cursor) {
      params.cursor = options.cursor;
    }
    if (options.since) {
      params.createdAfter = options.since.toISOString();
    }

    const response = await this.executeWithRetry(() =>
      api.get("/v1/recordings", { params }),
    );

    return this.parseListRecordingsResponse(response.data);
  }

  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    const { entity, onBatch, onProgress, since, state } = options;
    const maxIterations = options.maxIterations ?? 10;

    if (entity === "workspace") {
      if (!state || state.totalProcessed === 0) {
        await this.fetchWorkspace(options);
        return {
          totalProcessed: 1,
          hasMore: false,
          iterationsInChunk: 1,
        };
      }
      return {
        totalProcessed: state.totalProcessed,
        hasMore: false,
        iterationsInChunk: 0,
      };
    }

    if (entity !== "recordings") {
      throw new Error(`Unsupported entity for Claap connector: ${entity}`);
    }

    let cursor = (state?.metadata?.cursor as string | undefined) ?? undefined;
    let recordCount = state?.totalProcessed ?? 0;
    let iterations = 0;
    let totalCount = state?.metadata?.totalCount as number | undefined;

    if (!state && onProgress) {
      try {
        const first = await this.fetchRecordingsPage({
          limit: 1,
          since,
        });
        totalCount = first.pagination.totalCount;
        onProgress(0, totalCount);
      } catch (error) {
        logger.warn("Could not fetch recordings total count", { error });
        onProgress(0, undefined);
      }
    }

    while (iterations < maxIterations) {
      const page = await this.fetchRecordingsPage({
        cursor,
        since,
        limit: options.batchSize ?? this.getBatchSize(),
      });

      const records = page.recordings;
      if (records.length > 0) {
        await onBatch(records);
        recordCount += records.length;
        if (onProgress) {
          onProgress(recordCount, totalCount ?? page.pagination.totalCount);
        }
      }

      cursor = page.pagination.nextCursor;
      iterations++;

      if (!cursor) {
        return {
          totalProcessed: recordCount,
          hasMore: false,
          iterationsInChunk: iterations,
          metadata: { cursor: null, totalCount },
        };
      }

      await this.sleep(options.rateLimitDelay ?? this.getRateLimitDelay());
    }

    return {
      totalProcessed: recordCount,
      hasMore: true,
      iterationsInChunk: iterations,
      metadata: { cursor, totalCount },
    };
  }

  private async fetchWorkspace(options: FetchOptions): Promise<void> {
    const api = this.getClaapClient();
    const response = await this.executeWithRetry(() =>
      api.get("/v1/workspaces/mine"),
    );
    const workspace = (response.data as { result?: { workspace?: unknown } })
      ?.result?.workspace;

    if (workspace && typeof workspace === "object") {
      await options.onBatch([workspace as Record<string, unknown>]);
      options.onProgress?.(1, 1);
    }
  }

  async fetchEntity(options: FetchOptions): Promise<void> {
    if (options.entity === "workspace") {
      await this.fetchWorkspace(options);
      return;
    }

    await this.fetchEntityChunk({
      ...options,
      maxIterations: Number.MAX_SAFE_INTEGER,
    });
  }

  supportsWebhooks(): boolean {
    return true;
  }

  async verifyWebhook(
    options: WebhookHandlerOptions,
  ): Promise<WebhookVerificationResult> {
    const { payload, headers, secret } = options;

    const webhookSecret = this.headerValue(headers, "X-Claap-Webhook-Secret");

    if (!secret) {
      return { valid: false, error: "Missing webhook secret on flow" };
    }

    if (!webhookSecret) {
      return {
        valid: false,
        error: "Missing X-Claap-Webhook-Secret header",
      };
    }

    if (webhookSecret !== secret) {
      return { valid: false, error: "Invalid webhook secret" };
    }

    try {
      const parsed =
        typeof payload === "string" ? JSON.parse(payload) : payload;

      const eventType =
        typeof parsed?.event?.type === "string"
          ? parsed.event.type
          : typeof parsed?.type === "string"
            ? parsed.type
            : undefined;

      return {
        valid: true,
        event: {
          ...parsed,
          type: eventType,
          id:
            typeof parsed?.eventId === "string"
              ? parsed.eventId
              : typeof parsed?.id === "string"
                ? parsed.id
                : undefined,
        },
      };
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : "Failed to parse webhook",
      };
    }
  }

  getWebhookEventMapping(eventType: string): WebhookEventMapping | null {
    const mappings: Record<string, WebhookEventMapping> = {
      recording_added: { entity: "recordings", operation: "upsert" },
      recording_updated: { entity: "recordings", operation: "upsert" },
    };
    return mappings[eventType] ?? null;
  }

  getSupportedWebhookEvents(): string[] {
    return [...SUPPORTED_WEBHOOK_EVENTS];
  }

  getWebhookEventsForEntities(entities: string[]): string[] {
    if (entities.length === 0) return this.getSupportedWebhookEvents();
    const normalized = new Set(entities.map(e => e.toLowerCase()));
    if (normalized.has("recordings")) {
      return this.getSupportedWebhookEvents();
    }
    return [];
  }

  extractWebhookData(
    event: unknown,
  ): { id: string; data: Record<string, unknown> } | null {
    const payload = event as {
      event?: { recording?: Record<string, unknown> };
      recording?: Record<string, unknown>;
    };

    const recording = payload?.event?.recording ?? payload?.recording;
    const id =
      typeof recording?.id === "string"
        ? recording.id
        : typeof (recording as { _id?: string })?._id === "string"
          ? (recording as { _id: string })._id
          : undefined;

    if (!recording || !id) {
      return null;
    }

    return {
      id: String(id),
      data: { ...recording, id: String(id) },
    };
  }

  extractWebhookCdcRecords(
    event: unknown,
    eventType?: string,
  ): NormalizedCdcRecord[] {
    const records = super.extractWebhookCdcRecords(event, eventType);
    return records.map(record => ({
      ...record,
      sourceTs: this.resolveRecordingTimestamp(record.payload),
      changeId:
        record.changeId ||
        (typeof (event as { eventId?: string })?.eventId === "string"
          ? (event as { eventId: string }).eventId
          : `${eventType || "claap.event"}:${record.entity}:${record.recordId}`),
    }));
  }

  normalizeBackfillRecord(
    entity: string,
    record: Record<string, unknown>,
  ): NormalizedCdcRecord | null {
    const normalized = super.normalizeBackfillRecord(entity, record);
    if (!normalized) return null;

    return {
      ...normalized,
      sourceTs: this.resolveRecordingTimestamp(record),
    };
  }

  private resolveRecordingTimestamp(payload?: Record<string, unknown>): Date {
    const candidates = [
      payload?.updatedAt,
      payload?.date_updated,
      payload?.createdAt,
      payload?.date_created,
      payload?.timestamp,
    ];

    for (const candidate of candidates) {
      if (!candidate) continue;
      const date =
        candidate instanceof Date ? candidate : new Date(String(candidate));
      if (!Number.isNaN(date.getTime())) {
        return date;
      }
    }

    return new Date();
  }
}
