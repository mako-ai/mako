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

// List items carry no AI output (aiFields, keyTakeaways, outlines,
// actionItems), companies or analytics, so every listed recording is re-read
// from `GET /v1/recordings/{id}`. One detail call per recording: pages stay
// small so each page is one batch of roughly this many calls.
const RECORDINGS_PAGE_LIMIT = 50;
// Claap allows 3 requests per second per workspace.
const DETAIL_MIN_INTERVAL_MS = 350;
const DAY_MS = 24 * 60 * 60 * 1000;
// Every poll re-reads each recording in the window, one call per recording,
// so the window is capped well below the daily quota.
const RECORDINGS_LOOKBACK_MAX_DAYS = 7;

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
        {
          name: "recordings_lookback_days",
          label: "Recordings re-read window (days)",
          type: "number",
          required: false,
          default: 0,
          placeholder: "0",
          helperText:
            "Incremental runs re-read recordings created this many days before the last sync, picking up AI fields Claap generates later. 0 reads only new recordings, max 7. Every poll re-reads the whole window at one API call per recording, so the cost is window × polls per day.",
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
    const { entity, state } = options;

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

    return this.fetchRecordingsChunk(options);
  }

  private getRecordingsLookbackMs(): number {
    const days = Number(this.dataSource.config.recordings_lookback_days);
    if (!Number.isFinite(days) || days <= 0) return 0;
    return Math.min(days, RECORDINGS_LOOKBACK_MAX_DAYS) * DAY_MS;
  }

  /**
   * `recordings`: list a page, then re-read every recording on it from the
   * detail endpoint and emit only the detail object. A list item is never
   * written: it lacks the AI output, and the destination MERGE nulls every
   * absent key, so upserting it would blank those columns.
   *
   * Only a 404 (recording deleted) or a Ready recording without `aiFields` is
   * skipped. Any other detail failure throws after emitting the rows read so
   * far: the poll anchor is MAX(_syncedAt), so a skipped recording would never
   * be listed again. A chunk that read details but emitted nothing throws too.
   *
   * Detail calls spend the workspace's daily quota one per recording, so the
   * chunk checkpoints mid-page (`cursor` of the page plus `pageOffset`) when
   * the reserve is reached, and resumes there. The checkpoint carries
   * `createdAfter`: a resumed chunk gets no `since`, and listing without it
   * would restart from the oldest recording.
   */
  private async fetchRecordingsChunk(
    options: ResumableFetchOptions,
  ): Promise<FetchState> {
    const { onBatch, onProgress, onLog, since, state } = options;
    const maxIterations = options.maxIterations ?? 10;
    const savedCreatedAfter = state?.metadata?.createdAfter;
    const createdAfter =
      typeof savedCreatedAfter === "string"
        ? new Date(savedCreatedAfter)
        : since
          ? new Date(since.getTime() - this.getRecordingsLookbackMs())
          : undefined;
    const createdAfterIso = createdAfter?.toISOString() ?? null;
    const detailDelay = Math.max(
      options.rateLimitDelay ?? this.getRateLimitDelay(),
      DETAIL_MIN_INTERVAL_MS,
    );

    let cursor = (state?.metadata?.cursor as string | undefined) ?? undefined;
    let pageOffset = (state?.metadata?.pageOffset as number | undefined) ?? 0;
    let totalCount = state?.metadata?.totalCount as number | undefined;
    let recordingsSeen =
      (state?.metadata?.recordingsSeen as number | undefined) ?? 0;
    let recordCount = state?.totalProcessed ?? 0;
    let iterations = 0;
    let detailCalls = 0;
    let emittedInChunk = 0;

    while (iterations < maxIterations) {
      const pageCursor = cursor;
      const page = await this.fetchRecordingsPage({
        cursor: pageCursor,
        since: createdAfter,
        limit: Math.min(
          options.batchSize ?? this.getBatchSize(),
          RECORDINGS_PAGE_LIMIT,
        ),
      });
      totalCount ??= page.pagination.totalCount;
      let quotaLeft = page.dailyRemaining;

      const rows: Record<string, unknown>[] = [];
      const skipped: string[] = [];
      let stoppedAt: number | undefined;

      for (let index = pageOffset; index < page.recordings.length; index++) {
        if (quotaLeft !== undefined && quotaLeft < DAILY_QUOTA_RESERVE) {
          stoppedAt = index;
          break;
        }
        const listItem = page.recordings[index];
        const recordingId =
          typeof listItem.id === "string" && listItem.id.length > 0
            ? listItem.id
            : undefined;
        recordingsSeen++;
        if (!recordingId) continue;

        const detail = await this.fetchRecordingDetail(recordingId);
        detailCalls++;
        quotaLeft =
          detail.dailyRemaining ??
          (quotaLeft !== undefined ? quotaLeft - 1 : undefined);
        if (detail.recording) {
          rows.push(detail.recording);
        } else if (detail.notFound || detail.missingAiFields) {
          // TODO(claap): a 404 here means the recording was deleted between
          // the list and the detail call. Backfill batches are upsert-only
          // (an id-only tombstone would null every column), so deleted
          // recordings are not propagated yet.
          skipped.push(recordingId);
          logger.warn("Skipping Claap recording", {
            recordingId,
            notFound: detail.notFound === true,
            missingAiFields: detail.missingAiFields === true,
          });
        } else {
          if (rows.length > 0) await onBatch(rows);
          throw new Error(
            `Could not read Claap recording ${recordingId}: ${detail.error ?? "unknown error"}`,
          );
        }
        await this.sleep(detailDelay);
      }

      if (rows.length > 0) {
        await onBatch(rows);
        recordCount += rows.length;
        emittedInChunk += rows.length;
      }
      if (skipped.length > 0) {
        onLog?.(
          "warn",
          `Skipped ${skipped.length} Claap recording(s): deleted (404) or Ready without aiFields`,
          { recordingIds: skipped },
        );
      }
      onProgress?.(recordingsSeen, totalCount);

      if (stoppedAt !== undefined) {
        const message = `Claap daily API quota nearly used up (${quotaLeft} calls left, reserve ${DAILY_QUOTA_RESERVE}); stopping recording reads until it refills`;
        onLog?.("warn", message);
        if (detailCalls === 0) throw new Error(message);
        this.assertSomethingEmitted(detailCalls, emittedInChunk);
        // Save the progress made in this chunk; the next chunk resumes on
        // this page, at the first recording not yet read.
        return {
          totalProcessed: recordCount,
          hasMore: true,
          iterationsInChunk: iterations + 1,
          metadata: {
            cursor: pageCursor ?? null,
            pageOffset: stoppedAt,
            createdAfter: createdAfterIso,
            totalCount,
            recordingsSeen,
          },
        };
      }

      pageOffset = 0;
      cursor = page.pagination.nextCursor;
      iterations++;

      if (!cursor) {
        this.assertSomethingEmitted(detailCalls, emittedInChunk);
        return {
          totalProcessed: recordCount,
          hasMore: false,
          iterationsInChunk: iterations,
          metadata: {
            cursor: null,
            pageOffset: 0,
            createdAfter: createdAfterIso,
            totalCount,
            recordingsSeen,
          },
        };
      }
    }

    this.assertSomethingEmitted(detailCalls, emittedInChunk);
    return {
      totalProcessed: recordCount,
      hasMore: true,
      iterationsInChunk: iterations,
      metadata: {
        cursor,
        pageOffset: 0,
        createdAfter: createdAfterIso,
        totalCount,
        recordingsSeen,
      },
    };
  }

  // A chunk where every detail read was skipped is treated as a failure, not
  // an empty success: it is what an API shape change or a wrong endpoint looks
  // like, and a green run would hide it.
  private assertSomethingEmitted(detailCalls: number, emitted: number): void {
    if (detailCalls > 0 && emitted === 0) {
      throw new Error(
        `None of the ${detailCalls} Claap recording(s) read in this chunk could be written (all deleted or without aiFields)`,
      );
    }
  }

  private async fetchRecordingDetail(recordingId: string): Promise<{
    recording?: Record<string, unknown>;
    notFound?: boolean;
    missingAiFields?: boolean;
    error?: string;
    dailyRemaining?: number;
  }> {
    const api = this.getClaapClient();
    try {
      const response = await this.executeWithRetry(() =>
        api.get(`/v1/recordings/${encodeURIComponent(recordingId)}`, {
          params: { returnAiFields: true },
        }),
      );
      const dailyRemaining = readDailyRemaining(response.headers);
      const result = extractClaapResult(response.data);
      const candidate =
        result && typeof result === "object" && "recording" in result
          ? (result as { recording: unknown }).recording
          : result;
      if (
        !candidate ||
        typeof candidate !== "object" ||
        (candidate as { id?: unknown }).id !== recordingId
      ) {
        return {
          error: "Claap recording response has no matching recording",
          dailyRemaining,
        };
      }
      const recording = candidate as Record<string, unknown>;
      // A Ready recording must carry `aiFields` (an empty array is fine):
      // without the key the MERGE would null the stored AI output. Other
      // states (Empty, Uploaded, Failed) have no AI output to lose.
      if (recording.state === "Ready" && !Array.isArray(recording.aiFields)) {
        return { missingAiFields: true, dailyRemaining };
      }
      return { recording, dailyRemaining };
    } catch (error) {
      return {
        notFound: axios.isAxiosError(error) && error.response?.status === 404,
        error: formatClaapApiError(error).slice(0, 500),
        dailyRemaining: axios.isAxiosError(error)
          ? readDailyRemaining(error.response?.headers)
          : undefined,
      };
    }
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
        // `createdAfter` only, moved back by `recordings_lookback_days`: edits
        // to recordings older than that window are only caught by the
        // webhook trigger or a full backfill.
        recordings: { mode: "created-anchor", anchorField: "createdAfter" },
        // Same anchor, re-read with a two-day overlap: a transcript that is
        // regenerated later than that is only caught by a full backfill.
        [TRANSCRIPTS_ENTITY]: {
          mode: "created-anchor",
          anchorField: "createdAfter",
        },
      },
      warning:
        "Claap recordings are matched by creation date only; edits to recordings older than the re-read window (recordings_lookback_days) require the webhook trigger or a full backfill.",
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
    // Transcripts ride on the recording events (enrichWebhookCdcRecords).
    if (normalized.has("recordings") || normalized.has(TRANSCRIPTS_ENTITY)) {
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

  /**
   * `recording_added` / `recording_updated` carry the recording's transcript
   * links, valid for 24 hours. When the flow syncs `recording_transcripts`,
   * download them now and emit one transcript record per language next to
   * the recording, so every new call lands with its text and no poll is
   * needed.
   */
  async enrichWebhookCdcRecords(
    records: NormalizedCdcRecord[],
    options: { isEntityEnabled: (entity: string) => boolean },
  ): Promise<NormalizedCdcRecord[]> {
    if (!options.isEntityEnabled(TRANSCRIPTS_ENTITY)) return records;

    const enriched = [...records];
    for (const record of records) {
      if (record.entity !== "recordings" || record.operation !== "upsert") {
        continue;
      }
      const recording = (record.payload ?? {}) as Record<string, unknown>;
      const rows = await this.fetchRecordingTranscripts(recording);
      for (const row of rows) {
        enriched.push({
          entity: TRANSCRIPTS_ENTITY,
          recordId: String(row.id),
          operation: "upsert",
          payload: row,
          sourceTs: new Date(String(row.fetchedAt)),
          source: "webhook",
          changeId: `${record.changeId || record.recordId}:${TRANSCRIPTS_ENTITY}:${row.id}`,
        });
      }
    }
    return enriched;
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
