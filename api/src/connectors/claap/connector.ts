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
  ProvisionWebhookOptions,
  ProvisionWebhookResult,
  type WebhookCapabilities,
  type ConnectorEntitySchema,
  type IncrementalCapabilities,
} from "../base/BaseConnector";
import { resolveClaapEntitySchema } from "./schema";
import axios, { AxiosError, AxiosInstance } from "axios";
import { loggers } from "../../logging";
import { safeFetch } from "../../services/safe-fetch.service";

const logger = loggers.connector("claap");

const DEFAULT_BASE_URL = "https://api.claap.io";
const MAX_PAGE_LIMIT = 100;

const TRANSCRIPTS_ENTITY = "recording_transcripts";
// Every recording on a page triggers one download per language, so transcript
// pages are kept small: each page is one batch (and one heartbeat) of roughly
// this many downloads.
const TRANSCRIPT_PAGE_LIMIT = 50;
// A poll re-lists recordings created this long before `since`, so transcripts
// that finish processing (or translations added) after the recording first
// appeared are still picked up, and failed downloads are retried.
const TRANSCRIPT_RECHECK_MS = 2 * 24 * 60 * 60 * 1000;
// Claap enforces a per-workspace daily quota shared by every key. Stop before
// it runs dry so other integrations of the workspace keep working; the run
// resumes from its checkpoint once the rolling window has refilled.
const DAILY_QUOTA_RESERVE = 500;
const TRANSCRIPT_MAX_BYTES = 50_000_000;
const TRANSCRIPT_TIMEOUT_MS = 60_000;

const SUPPORTED_WEBHOOK_EVENTS = [
  "recording_added",
  "recording_updated",
] as const;

type ClaapWebhookRecord = {
  id: string;
  url: string;
  secret?: string;
};

type ClaapListRecordingsResult = {
  recordings: Record<string, unknown>[];
  pagination: {
    nextCursor?: string;
    totalCount?: number;
  };
  dailyRemaining?: number;
};

type ClaapTranscriptRef = {
  langIso2?: unknown;
  isTranscript?: unknown;
  isActive?: unknown;
  url?: unknown;
};

type ClaapTranscriptSegment = {
  startedAt: number;
  endedAt: number;
  text: string;
  speaker?: string;
  languageCode?: string;
};

/**
 * Pull the segments out of a transcript document. The signed `url` download
 * and `GET /v1/recordings/{id}/transcript?format=json` may wrap them
 * differently, so accept `{ result: { transcript: { segments } } }`,
 * `{ transcript: { segments } }`, `{ segments }` and a bare array. Per-word
 * timings (`words`) are dropped: they multiply the size for no use downstream.
 */
export function parseClaapTranscriptSegments(
  document: unknown,
): ClaapTranscriptSegment[] | null {
  const unwrapped = extractClaapResult(document);
  const container =
    unwrapped && typeof unwrapped === "object" && "transcript" in unwrapped
      ? (unwrapped as { transcript: unknown }).transcript
      : unwrapped;
  const rawSegments = Array.isArray(container)
    ? container
    : container && typeof container === "object"
      ? (container as { segments?: unknown }).segments
      : undefined;
  if (!Array.isArray(rawSegments)) return null;

  const segments: ClaapTranscriptSegment[] = [];
  for (const raw of rawSegments) {
    if (!raw || typeof raw !== "object") continue;
    const segment = raw as Record<string, unknown>;
    if (typeof segment.text !== "string") continue;
    segments.push({
      startedAt: Number(segment.startedAt) || 0,
      endedAt: Number(segment.endedAt) || 0,
      text: segment.text,
      ...(typeof segment.speaker === "string" && { speaker: segment.speaker }),
      ...(typeof segment.languageCode === "string" && {
        languageCode: segment.languageCode,
      }),
    });
  }
  return segments;
}

function formatTranscriptTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}`
    : `${pad(minutes)}:${pad(secs)}`;
}

/**
 * Plain-text rendering in Claap's own `format=text` layout
 * (`02:17 speaker_1: Hello there!`), one line per segment, so the text needs
 * no second download.
 */
export function renderClaapTranscriptText(
  segments: ClaapTranscriptSegment[],
): string {
  return segments
    .map(segment => {
      const speaker = segment.speaker ? ` ${segment.speaker}:` : "";
      return `${formatTranscriptTimestamp(segment.startedAt)}${speaker} ${segment.text}`;
    })
    .join("\n");
}

function readDailyRemaining(headers: unknown): number | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== "x-ratelimit-daily-remaining") continue;
    const parsed = Number(Array.isArray(value) ? value[0] : value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function extractClaapResult(data: unknown): unknown {
  if (data && typeof data === "object" && "result" in data) {
    return (data as { result: unknown }).result;
  }
  return data;
}

function resolveClaapWebhookUrl(record: unknown): string {
  if (!record || typeof record !== "object") return "";
  const candidate = record as Record<string, unknown>;
  for (const key of ["url", "endpoint", "callbackUrl", "targetUrl"]) {
    const value = candidate[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function resolveClaapWebhookId(record: unknown): string {
  if (!record || typeof record !== "object") return "";
  const candidate = record as Record<string, unknown>;
  for (const key of ["id", "_id", "webhookId"]) {
    const value = candidate[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function resolveClaapSigningSecret(record: unknown): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const candidate = record as Record<string, unknown>;
  for (const key of [
    "secret",
    "signingSecret",
    "signing_secret",
    "webhookSecret",
  ]) {
    const value = candidate[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeClaapWebhookList(data: unknown): ClaapWebhookRecord[] {
  const result = extractClaapResult(data);
  const rawList = Array.isArray(result)
    ? result
    : result && typeof result === "object"
      ? ((result as { webhooks?: unknown }).webhooks ??
        (result as { data?: unknown }).data ??
        [])
      : [];

  if (!Array.isArray(rawList)) return [];

  const normalized: ClaapWebhookRecord[] = [];
  for (const item of rawList) {
    const id = resolveClaapWebhookId(item);
    const url = resolveClaapWebhookUrl(item);
    if (!id || !url) continue;
    normalized.push({
      id,
      url,
      secret: resolveClaapSigningSecret(item),
    });
  }
  return normalized;
}

function normalizeClaapWebhookRecord(data: unknown): ClaapWebhookRecord | null {
  const result = extractClaapResult(data);
  const candidate =
    result && typeof result === "object"
      ? ((result as { webhook?: unknown }).webhook ?? result)
      : data;
  const id = resolveClaapWebhookId(candidate);
  const url = resolveClaapWebhookUrl(candidate);
  if (!id) return null;
  return {
    id,
    url,
    secret: resolveClaapSigningSecret(candidate),
  };
}

function formatClaapApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data as
      { error?: { message?: string }; message?: string } | string | undefined;

    const directError =
      typeof data === "string"
        ? data
        : typeof data?.error?.message === "string"
          ? data.error.message
          : typeof data?.message === "string"
            ? data.message
            : undefined;

    const serialized =
      !directError && data && typeof data === "object"
        ? JSON.stringify(data)
        : undefined;

    const detail = directError || serialized || error.message;
    return status ? `HTTP ${status}: ${detail}` : detail;
  }

  return error instanceof Error ? error.message : String(error);
}

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
      version: "1.1.0",
      description:
        "Connector for Claap meeting recordings, their transcripts, workspace metadata, and webhooks",
      supportedEntities: ["recordings", TRANSCRIPTS_ENTITY, "workspace"],
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
    return ["recordings", TRANSCRIPTS_ENTITY, "workspace"];
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
        name: TRANSCRIPTS_ENTITY,
        label: "Recording transcripts",
        description:
          "Transcript text and speaker segments, one row per recording and language",
        layoutSuggestion: {
          partitionField: "recordingCreatedAt",
          partitionGranularity: "day" as const,
          clusterFields: ["recordingId"],
        },
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
    headers?: unknown,
  ): ClaapListRecordingsResult {
    const result = (data as { result?: ClaapListRecordingsResult })?.result;
    return {
      recordings: Array.isArray(result?.recordings) ? result.recordings : [],
      pagination: result?.pagination ?? {},
      dailyRemaining: readDailyRemaining(headers),
    };
  }

  private async fetchRecordingsPage(options: {
    cursor?: string;
    since?: Date;
    limit?: number;
    includeAiFields?: boolean;
  }): Promise<ClaapListRecordingsResult> {
    const api = this.getClaapClient();
    const params: Record<string, string | number | boolean> = {
      limit: Math.min(options.limit ?? this.getBatchSize(), MAX_PAGE_LIMIT),
      sort: "created_asc",
    };
    if (options.includeAiFields ?? true) {
      // Opt into Claap's new AI output structure (`aiFields`). Without this the
      // API returns the legacy `insightTemplates`, which stops being populated
      // as of 2026-06-26.
      params.returnAiFields = true;
    }

    if (options.cursor) {
      params.cursor = options.cursor;
    }
    if (options.since) {
      params.createdAfter = options.since.toISOString();
    }

    const response = await this.executeWithRetry(() =>
      api.get("/v1/recordings", { params }),
    );

    return this.parseListRecordingsResponse(response.data, response.headers);
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

    if (entity === TRANSCRIPTS_ENTITY) {
      return this.fetchTranscriptsChunk(options);
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

  /**
   * `recording_transcripts`: one row per recording × transcript language.
   * Claap's transcript links expire after 24 hours, so each page of recordings
   * is listed and its transcripts are downloaded straight away, in the same
   * chunk. Downloads that fail are still emitted (fetchStatus `failed`) so the
   * gap is visible; the next poll's overlap window retries them.
   */
  private async fetchTranscriptsChunk(
    options: ResumableFetchOptions,
  ): Promise<FetchState> {
    const { onBatch, onProgress, onLog, since, state } = options;
    const maxIterations = options.maxIterations ?? 10;
    const createdAfter = since
      ? new Date(since.getTime() - TRANSCRIPT_RECHECK_MS)
      : undefined;

    let cursor = (state?.metadata?.cursor as string | undefined) ?? undefined;
    let totalCount = state?.metadata?.totalCount as number | undefined;
    let recordingsSeen =
      (state?.metadata?.recordingsSeen as number | undefined) ?? 0;
    let recordCount = state?.totalProcessed ?? 0;
    let iterations = 0;

    while (iterations < maxIterations) {
      const page = await this.fetchRecordingsPage({
        cursor,
        since: createdAfter,
        limit: TRANSCRIPT_PAGE_LIMIT,
        includeAiFields: false,
      });
      totalCount ??= page.pagination.totalCount;

      if (
        page.dailyRemaining !== undefined &&
        page.dailyRemaining < DAILY_QUOTA_RESERVE
      ) {
        const message = `Claap daily API quota nearly used up (${page.dailyRemaining} calls left, reserve ${DAILY_QUOTA_RESERVE}); stopping transcript downloads until it refills`;
        onLog?.("warn", message);
        if (iterations > 0) {
          // Save the progress made in this chunk; the next chunk stops here.
          return {
            totalProcessed: recordCount,
            hasMore: true,
            iterationsInChunk: iterations,
            metadata: { cursor, totalCount, recordingsSeen },
          };
        }
        throw new Error(message);
      }

      const rows: Record<string, unknown>[] = [];
      for (const recording of page.recordings) {
        rows.push(...(await this.fetchRecordingTranscripts(recording)));
      }
      if (rows.length > 0) {
        await onBatch(rows);
        recordCount += rows.length;
      }
      recordingsSeen += page.recordings.length;
      onProgress?.(recordingsSeen, totalCount);

      cursor = page.pagination.nextCursor;
      iterations++;

      if (!cursor) {
        return {
          totalProcessed: recordCount,
          hasMore: false,
          iterationsInChunk: iterations,
          metadata: { cursor: null, totalCount, recordingsSeen },
        };
      }
    }

    return {
      totalProcessed: recordCount,
      hasMore: true,
      iterationsInChunk: iterations,
      metadata: { cursor, totalCount, recordingsSeen },
    };
  }

  private async fetchRecordingTranscripts(
    recording: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const recordingId =
      typeof recording.id === "string" && recording.id.length > 0
        ? recording.id
        : undefined;
    if (!recordingId || !Array.isArray(recording.transcripts)) return [];

    const recordingCreatedAt =
      typeof recording.createdAt === "string" ? recording.createdAt : null;
    const rows: Record<string, unknown>[] = [];

    for (const ref of recording.transcripts as ClaapTranscriptRef[]) {
      const langIso2 =
        typeof ref?.langIso2 === "string" && ref.langIso2.trim().length > 0
          ? ref.langIso2.trim().toLowerCase()
          : undefined;
      if (!langIso2) continue;

      const base = {
        id: `${recordingId}:${langIso2}`,
        recordingId,
        langIso2,
        isTranscript: ref.isTranscript === true,
        isActive: ref.isActive === true,
        recordingCreatedAt,
      };

      try {
        const segments = await this.downloadTranscriptSegments(
          recordingId,
          langIso2,
          ref.url,
        );
        const transcriptText = renderClaapTranscriptText(segments);
        rows.push({
          ...base,
          transcriptText,
          segments,
          segmentCount: segments.length,
          charCount: transcriptText.length,
          fetchStatus: segments.length > 0 ? "ok" : "empty",
          fetchError: null,
          fetchedAt: new Date().toISOString(),
        });
      } catch (error) {
        logger.warn("Could not download Claap transcript", {
          recordingId,
          langIso2,
          error: formatClaapApiError(error),
        });
        rows.push({
          ...base,
          transcriptText: null,
          segments: null,
          segmentCount: null,
          charCount: null,
          fetchStatus: "failed",
          fetchError: formatClaapApiError(error).slice(0, 500),
          fetchedAt: new Date().toISOString(),
        });
      }

      await this.sleep(this.getRateLimitDelay());
    }

    return rows;
  }

  /**
   * The signed link from the listing first (it carries its own token, so the
   * API key is never sent to it); the transcript endpoint when the link is
   * missing, expired or unreadable.
   */
  private async downloadTranscriptSegments(
    recordingId: string,
    langIso2: string,
    url: unknown,
  ): Promise<ClaapTranscriptSegment[]> {
    if (typeof url === "string" && url.startsWith("https://")) {
      try {
        const body = await this.downloadSignedUrl(url);
        const segments = parseClaapTranscriptSegments(JSON.parse(body));
        if (segments) return segments;
        logger.warn("Claap transcript link returned no segments", {
          recordingId,
          langIso2,
        });
      } catch (error) {
        logger.warn("Claap transcript link failed; using the API endpoint", {
          recordingId,
          langIso2,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const api = this.getClaapClient();
    const response = await this.executeWithRetry(() =>
      api.get(`/v1/recordings/${encodeURIComponent(recordingId)}/transcript`, {
        params: { lang: langIso2, format: "json" },
      }),
    );
    const segments = parseClaapTranscriptSegments(response.data);
    if (!segments) {
      throw new Error("Claap transcript response has no segments");
    }
    return segments;
  }

  protected async downloadSignedUrl(url: string): Promise<string> {
    const response = await safeFetch(url, {
      maxBytes: TRANSCRIPT_MAX_BYTES,
      timeoutMs: TRANSCRIPT_TIMEOUT_MS,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status} downloading transcript`);
    }
    return response.body.toString("utf8");
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

  supportsWebhookProvisioning(): boolean {
    return true;
  }

  getWebhookCapabilities(): WebhookCapabilities {
    return {
      supported: true,
      provisioning: {
        supported: true,
        providerLabel: "Claap",
        storesSecretAutomatically: false,
        actionHint: "(copy the secret into this form if Claap shows it once)",
      },
      secretHelpText:
        "Enter the X-Claap-Webhook-Secret from your Claap webhook settings",
    };
  }

  getIncrementalCapabilities(): IncrementalCapabilities {
    return {
      supported: true,
      // `workspace` is a single-object fetch with no time filter at all.
      mode: "none",
      perEntity: {
        // `createdAfter` only — a recording edited after creation won't be
        // re-polled; only the webhook trigger catches later edits.
        recordings: { mode: "created-anchor", anchorField: "createdAfter" },
        // Same anchor, re-read with a two-day overlap: a transcript that is
        // regenerated later than that is only caught by a full backfill.
        [TRANSCRIPTS_ENTITY]: {
          mode: "created-anchor",
          anchorField: "createdAfter",
        },
      },
      warning:
        "Claap recordings are matched by creation date only; edits to existing recordings require the webhook trigger.",
    };
  }

  async createWebhookSubscription(
    options: ProvisionWebhookOptions,
  ): Promise<ProvisionWebhookResult> {
    const api = this.getClaapClient();

    const requestedEvents = Array.isArray(options.events)
      ? options.events
          .map(event => event.trim())
          .filter((event): event is string => event.length > 0)
      : [];

    const effectiveEvents =
      requestedEvents.length > 0
        ? requestedEvents
        : this.getWebhookEventsForEntities(options.enabledEntities ?? []);

    const unsupported = effectiveEvents.filter(
      event =>
        !SUPPORTED_WEBHOOK_EVENTS.includes(
          event as (typeof SUPPORTED_WEBHOOK_EVENTS)[number],
        ),
    );
    if (requestedEvents.length > 0 && unsupported.length > 0) {
      logger.warn("Ignoring unsupported Claap webhook events", {
        unsupportedEvents: unsupported,
      });
    }

    const events = effectiveEvents.filter(event =>
      SUPPORTED_WEBHOOK_EVENTS.includes(
        event as (typeof SUPPORTED_WEBHOOK_EVENTS)[number],
      ),
    );

    if (events.length === 0) {
      throw new Error(
        requestedEvents.length > 0
          ? `No valid Claap webhook events configured. Unsupported events: ${unsupported.join(", ")}`
          : "No valid Claap webhook events configured",
      );
    }

    const payload = {
      url: options.endpointUrl,
      events,
    };

    try {
      const existingResponse = await this.executeWithRetry(() =>
        api.get("/v1/webhooks"),
      );
      const existing = normalizeClaapWebhookList(existingResponse.data).find(
        webhook => webhook.url === options.endpointUrl,
      );

      if (existing) {
        try {
          await this.executeWithRetry(() =>
            api.put(`/v1/webhooks/${existing.id}`, payload),
          );
          logger.info(
            "Updated Claap webhook events for existing subscription",
            {
              webhookId: existing.id,
              eventCount: events.length,
            },
          );
        } catch (updateError) {
          logger.warn("Could not update events on existing Claap webhook", {
            webhookId: existing.id,
            error: updateError,
          });
        }

        return {
          providerWebhookId: existing.id,
          endpointUrl: options.endpointUrl,
          signingSecret: existing.secret,
        };
      }

      const response = await this.executeWithRetry(() =>
        api.post("/v1/webhooks", payload),
      );
      const created = normalizeClaapWebhookRecord(response.data);
      const providerWebhookId = created?.id;
      if (!providerWebhookId) {
        throw new Error(
          "Claap webhook created but no subscription id returned by API",
        );
      }

      return {
        providerWebhookId,
        endpointUrl: options.endpointUrl,
        signingSecret: created.secret,
      };
    } catch (error) {
      throw new Error(
        `Failed to create Claap webhook subscription: ${formatClaapApiError(error)}`,
        { cause: error },
      );
    }
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
