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
} from "../base/BaseConnector";
import axios, { AxiosInstance } from "axios";
import { loggers } from "../../logging";

const logger = loggers.connector("claap");

const CLAAP_API_BASE = "https://api.claap.io";

const WEBHOOK_EVENT_MAPPINGS: Record<string, WebhookEventMapping> = {
  recording_added: { entity: "recordings", operation: "upsert" },
  recording_updated: { entity: "recordings", operation: "upsert" },
};

function flattenRecording(
  recording: Record<string, unknown>,
): Record<string, unknown> {
  const flat: Record<string, unknown> = {
    id: recording.id,
    title: recording.title,
    state: recording.state,
    created_at: recording.createdAt,
    duration_seconds: recording.durationSeconds,
    url: recording.url,
    thumbnail_url: recording.thumbnailUrl,
    labels: recording.labels,
  };

  const recorder = recording.recorder as Record<string, unknown> | undefined;
  if (recorder) {
    flat.recorder_id = recorder.id;
    flat.recorder_email = recorder.email;
    flat.recorder_name = recorder.name;
    flat.recorder_attended = recorder.attended;
  }

  const channel = recording.channel as Record<string, unknown> | undefined;
  if (channel) {
    flat.channel_id = channel.id;
    flat.channel_name = channel.name;
  }

  const workspace = recording.workspace as Record<string, unknown> | undefined;
  if (workspace) {
    flat.workspace_id = workspace.id;
    flat.workspace_name = workspace.name;
  }

  const meeting = recording.meeting as Record<string, unknown> | undefined;
  if (meeting) {
    flat.meeting_type = meeting.type;
    flat.meeting_starting_at = meeting.startingAt;
    flat.meeting_ending_at = meeting.endingAt;
    flat.meeting_conference_url = meeting.conferenceUrl;
    flat.participants = JSON.stringify(meeting.participants || []);
  }

  const video = recording.video as Record<string, unknown> | undefined;
  if (video) {
    flat.video_url = video.url;
  }

  const deal = recording.deal as Record<string, unknown> | undefined;
  if (deal) {
    flat.deal_id = deal.id;
    flat.deal_name = deal.name;
  }

  const crmInfo = recording.crmInfo as Record<string, unknown> | undefined;
  if (crmInfo) {
    flat.crm_type = crmInfo.crm;
    const crmDeal = crmInfo.deal as Record<string, unknown> | undefined;
    flat.crm_deal_id = crmDeal?.id;
  }

  const companies = recording.companies as
    | Array<Record<string, unknown>>
    | undefined;
  if (companies) {
    flat.companies = JSON.stringify(companies);
  }

  flat.key_takeaways = safeJsonStringify(recording.keyTakeaways);
  flat.outlines = safeJsonStringify(recording.outlines);
  flat.action_items = safeJsonStringify(recording.actionItems);
  flat.insights = safeJsonStringify(recording.insightTemplates);

  const transcripts = recording.transcripts as
    | Array<Record<string, unknown>>
    | undefined;
  if (transcripts) {
    flat.transcript_languages = transcripts
      .map(t => t.langIso2)
      .filter(Boolean);
  }

  return flat;
}

function safeJsonStringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export class ClaapConnector extends BaseConnector {
  private api: AxiosInstance | null = null;

  static getConfigSchema() {
    return {
      fields: [
        {
          name: "api_key",
          label: "API Key",
          type: "password",
          required: true,
          helperText: "Your Claap API key (starts with cla_)",
        },
      ],
    };
  }

  getMetadata() {
    return {
      name: "Claap",
      version: "1.0.0",
      description: "Connector for Claap meeting recordings and transcripts",
      supportedEntities: ["recordings", "transcripts"],
    };
  }

  getAvailableEntities(): string[] {
    return ["recordings", "transcripts"];
  }

  getEntityMetadata(): EntityMetadata[] {
    return [
      {
        name: "recordings",
        label: "Recordings",
        description:
          "Meeting recordings with metadata, insights, and action items",
        layoutSuggestion: {
          partitionField: "created_at",
          partitionGranularity: "day",
          clusterFields: ["recorder_email", "meeting_type"],
        },
      },
      {
        name: "transcripts",
        label: "Transcripts",
        description: "Full transcripts with speaker segments and timing",
        layoutSuggestion: {
          partitionField: "created_at",
          partitionGranularity: "day",
          clusterFields: ["recording_id"],
        },
      },
    ];
  }

  supportsResumableFetching(): boolean {
    return true;
  }

  supportsWebhooks(): boolean {
    return true;
  }

  validateConfig() {
    const base = super.validateConfig();
    const errors = [...base.errors];
    if (!this.dataSource.config?.api_key) {
      errors.push("Claap API key is required");
    }
    return { valid: errors.length === 0, errors };
  }

  private getApi(): AxiosInstance {
    if (!this.api) {
      const apiKey = this.dataSource.config?.api_key;
      if (!apiKey) {
        throw new Error("Claap API key not configured");
      }
      this.api = axios.create({
        baseURL: CLAAP_API_BASE,
        headers: {
          "X-Claap-Key": apiKey,
          "Content-Type": "application/json",
        },
        timeout: 30_000,
      });
    }
    return this.api;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const api = this.getApi();
      const response = await api.get("/v1/workspaces/mine");
      const workspace = response.data?.result?.workspace;
      return {
        success: true,
        message: `Connected to workspace "${workspace?.name}" (${workspace?.recordingsCount} recordings)`,
        details: workspace,
      };
    } catch (error) {
      const message =
        axios.isAxiosError(error) && error.response?.status === 401
          ? "Invalid API key"
          : error instanceof Error
            ? error.message
            : "Connection failed";
      return { success: false, message };
    }
  }

  async fetchEntity(options: FetchOptions): Promise<void> {
    let state: FetchState | undefined;
    do {
      state = await this.fetchEntityChunk({ ...options, state });
    } while (state.hasMore);
  }

  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    const { entity } = options;

    if (entity === "recordings") {
      return this.fetchRecordingsChunk(options);
    }
    if (entity === "transcripts") {
      return this.fetchTranscriptsChunk(options);
    }

    throw new Error(`Unknown entity: ${entity}`);
  }

  private async fetchRecordingsChunk(
    options: ResumableFetchOptions,
  ): Promise<FetchState> {
    const api = this.getApi();
    const maxIterations = options.maxIterations || 10;
    const batchSize = Math.min(options.batchSize || 100, 100);
    const rateLimitDelay = options.rateLimitDelay || this.getRateLimitDelay();

    let cursor = options.state?.cursor;
    let totalProcessed = options.state?.totalProcessed || 0;
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;

      const params: Record<string, string | number> = {
        sort: "created_asc",
        limit: batchSize,
      };
      if (cursor) params.cursor = cursor;
      if (options.since) {
        params.createdAfter = options.since.toISOString();
      }

      let response;
      try {
        response = await api.get("/v1/recordings", { params });
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          const retryAfter = parseInt(
            String(error.response.headers["retry-after"] || "30"),
          );
          logger.warn("Rate limited, waiting", {
            retryAfterSeconds: retryAfter,
          });
          await this.sleep(retryAfter * 1000);
          iterations--;
          continue;
        }
        throw error;
      }

      const recordings: any[] = response.data?.result?.recordings || [];
      const pagination = response.data?.result?.pagination;

      if (recordings.length === 0) {
        return {
          totalProcessed,
          hasMore: false,
          iterationsInChunk: iterations,
        };
      }

      const detailedRecordings = await Promise.all(
        recordings.map(async (rec: any) => {
          try {
            const detail = await api.get(`/v1/recordings/${rec.id}`);
            await this.sleep(rateLimitDelay);
            return detail.data?.result?.recording || rec;
          } catch (error) {
            logger.warn("Failed to fetch recording details, using list data", {
              recordingId: rec.id,
              error: error instanceof Error ? error.message : String(error),
            });
            return rec;
          }
        }),
      );

      const batch = detailedRecordings.map(flattenRecording);
      await options.onBatch(batch);
      totalProcessed += batch.length;

      if (options.onProgress) {
        options.onProgress(totalProcessed, pagination?.totalCount);
      }

      cursor = pagination?.nextCursor;
      if (!cursor) {
        return {
          totalProcessed,
          hasMore: false,
          iterationsInChunk: iterations,
        };
      }

      await this.sleep(rateLimitDelay);
    }

    return {
      totalProcessed,
      hasMore: true,
      iterationsInChunk: iterations,
      cursor,
    };
  }

  private async fetchTranscriptsChunk(
    options: ResumableFetchOptions,
  ): Promise<FetchState> {
    const api = this.getApi();
    const maxIterations = options.maxIterations || 10;
    const batchSize = Math.min(options.batchSize || 100, 100);
    const rateLimitDelay = options.rateLimitDelay || this.getRateLimitDelay();

    let cursor = options.state?.cursor;
    let totalProcessed = options.state?.totalProcessed || 0;
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;

      const params: Record<string, string | number> = {
        sort: "created_asc",
        limit: batchSize,
      };
      if (cursor) params.cursor = cursor;
      if (options.since) {
        params.createdAfter = options.since.toISOString();
      }

      let response;
      try {
        response = await api.get("/v1/recordings", { params });
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          const retryAfter = parseInt(
            String(error.response.headers["retry-after"] || "30"),
          );
          logger.warn("Rate limited on transcript list, waiting", {
            retryAfterSeconds: retryAfter,
          });
          await this.sleep(retryAfter * 1000);
          iterations--;
          continue;
        }
        throw error;
      }

      const recordings: any[] = response.data?.result?.recordings || [];
      const pagination = response.data?.result?.pagination;

      if (recordings.length === 0) {
        return {
          totalProcessed,
          hasMore: false,
          iterationsInChunk: iterations,
        };
      }

      const transcriptBatch: Record<string, unknown>[] = [];
      for (const rec of recordings) {
        try {
          const transcriptResp = await api.get(
            `/v1/recordings/${rec.id}/transcript`,
            { params: { format: "json" } },
          );
          await this.sleep(rateLimitDelay);

          const transcript = transcriptResp.data?.result?.transcript;
          if (transcript) {
            transcriptBatch.push({
              id: rec.id,
              recording_id: rec.id,
              recording_title: rec.title,
              created_at: rec.createdAt,
              language_code: transcript.languageCode,
              segments: JSON.stringify(transcript.segments || []),
              segment_count: Array.isArray(transcript.segments)
                ? transcript.segments.length
                : 0,
            });
          }
        } catch (error) {
          logger.warn("Failed to fetch transcript", {
            recordingId: rec.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (transcriptBatch.length > 0) {
        await options.onBatch(transcriptBatch);
      }
      totalProcessed += transcriptBatch.length;

      if (options.onProgress) {
        options.onProgress(totalProcessed, pagination?.totalCount);
      }

      cursor = pagination?.nextCursor;
      if (!cursor) {
        return {
          totalProcessed,
          hasMore: false,
          iterationsInChunk: iterations,
        };
      }

      await this.sleep(rateLimitDelay);
    }

    return {
      totalProcessed,
      hasMore: true,
      iterationsInChunk: iterations,
      cursor,
    };
  }

  // --- Webhook support ---

  async verifyWebhook(
    options: WebhookHandlerOptions,
  ): Promise<WebhookVerificationResult> {
    const { payload, headers, secret } = options;

    const webhookSecret =
      headers["x-claap-webhook-secret"] || headers["X-Claap-Webhook-Secret"];

    if (!secret) {
      return { valid: false, error: "No webhook secret configured" };
    }

    const receivedSecret = Array.isArray(webhookSecret)
      ? webhookSecret[0]
      : webhookSecret;

    if (receivedSecret !== secret) {
      return { valid: false, error: "Webhook secret mismatch" };
    }

    const event = typeof payload === "string" ? JSON.parse(payload) : payload;

    return { valid: true, event };
  }

  getSupportedWebhookEvents(): string[] {
    return Object.keys(WEBHOOK_EVENT_MAPPINGS);
  }

  getWebhookEventMapping(eventType: string): WebhookEventMapping | null {
    return WEBHOOK_EVENT_MAPPINGS[eventType] || null;
  }

  extractWebhookData(event: any): { id: string; data: any } | null {
    const recording = event?.event?.recording || event?.recording;
    if (!recording?.id) {
      return null;
    }

    return {
      id: recording.id,
      data: flattenRecording(recording),
    };
  }

  extractWebhookCdcRecords(
    event: any,
    eventType?: string,
  ): NormalizedCdcRecord[] {
    const resolvedEventType = eventType || event?.event?.type || event?.type;
    if (!resolvedEventType) {
      return [];
    }

    const mapping = this.getWebhookEventMapping(resolvedEventType);
    if (!mapping) {
      return [];
    }

    const recording = event?.event?.recording || event?.recording;
    if (!recording?.id) {
      return [];
    }

    const flat = flattenRecording(recording);

    return [
      {
        entity: mapping.entity,
        recordId: recording.id,
        operation: mapping.operation,
        payload: flat,
        sourceTs: new Date(recording.createdAt || Date.now()),
        source: "webhook",
        changeId:
          event?.eventId ||
          `${resolvedEventType}:${recording.id}:${Date.now()}`,
      },
    ];
  }
}
