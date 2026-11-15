/**
 * The Claap connector. The class is the public entry point; the work lives
 * in sibling modules:
 *
 * - client.ts      X-Claap-Key client, API errors, `{ result }`, daily quota
 * - recordings.ts  recordings backfill (list + per-recording detail)
 * - transcripts.ts recording_transcripts (signed-link downloads)
 * - webhooks.ts    provisioning, shared-secret verification, payloads
 */
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
import axios, { AxiosInstance } from "axios";
import { loggers } from "../../logging";
import { createRetryExecutor } from "../base/http-client";
import {
  CLAAP_DEFAULT_BASE_URL,
  createClaapClient,
  resolveClaapBaseUrl,
  type ClaapContext,
} from "./client";
import { fetchClaapRecordingsChunk } from "./recordings";
import {
  CLAAP_TRANSCRIPTS_ENTITY as TRANSCRIPTS_ENTITY,
  downloadClaapSignedUrl,
  fetchClaapRecordingTranscripts,
  fetchClaapTranscriptsChunk,
} from "./transcripts";
import {
  CLAAP_SUPPORTED_WEBHOOK_EVENTS,
  extractClaapWebhookData,
  provisionClaapWebhook,
  verifyClaapWebhook,
} from "./webhooks";

export {
  parseClaapTranscriptSegments,
  renderClaapTranscriptText,
} from "./transcripts";

const logger = loggers.connector("claap");

export class ClaapConnector extends BaseConnector {
  private claapApi: AxiosInstance | null = null;

  /** Shared policy: backoff with jitter, Retry-After, 429/5xx/network. */
  private readonly executeWithRetry = createRetryExecutor({
    label: "Claap",
    logger,
    sleep: ms => this.sleep(ms),
  });

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
          default: CLAAP_DEFAULT_BASE_URL,
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

    if (!this.sourceConnection.config.api_key) {
      errors.push("Claap API key is required");
    }

    return { valid: errors.length === 0, errors };
  }

  private getClaapClient(): AxiosInstance {
    if (!this.claapApi) {
      if (!this.sourceConnection.config.api_key) {
        throw new Error("Claap API key not configured");
      }
      this.claapApi = createClaapClient(
        resolveClaapBaseUrl(this.sourceConnection.config.api_base_url),
        this.sourceConnection.config.api_key,
      );
    }
    return this.claapApi;
  }

  /** What the fetch and webhook modules read, always late-bound. */
  private context(): ClaapContext {
    return {
      api: () => this.getClaapClient(),
      execute: (fn, maxRetries) => this.executeWithRetry(fn, maxRetries),
      sleep: ms => this.sleep(ms),
      batchSize: () => this.getBatchSize(),
      rateLimitDelay: () => this.getRateLimitDelay(),
      recordingsLookbackDays: () =>
        this.sourceConnection.config.recordings_lookback_days,
      downloadSignedUrl: url => this.downloadSignedUrl(url),
    };
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
      return fetchClaapTranscriptsChunk(this.context(), options);
    }

    if (entity !== "recordings") {
      throw new Error(`Unsupported entity for Claap connector: ${entity}`);
    }

    return fetchClaapRecordingsChunk(this.context(), options);
  }

  protected async downloadSignedUrl(url: string): Promise<string> {
    return downloadClaapSignedUrl(url);
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
    return provisionClaapWebhook(this.context(), options, entities =>
      this.getWebhookEventsForEntities(entities),
    );
  }

  async verifyWebhook(
    options: WebhookHandlerOptions,
  ): Promise<WebhookVerificationResult> {
    return verifyClaapWebhook(options);
  }

  getWebhookEventMapping(eventType: string): WebhookEventMapping | null {
    const mappings: Record<string, WebhookEventMapping> = {
      recording_added: { entity: "recordings", operation: "upsert" },
      recording_updated: { entity: "recordings", operation: "upsert" },
    };
    return mappings[eventType] ?? null;
  }

  getSupportedWebhookEvents(): string[] {
    return [...CLAAP_SUPPORTED_WEBHOOK_EVENTS];
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
    return extractClaapWebhookData(event);
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

    const ctx = this.context();
    const enriched = [...records];
    for (const record of records) {
      if (record.entity !== "recordings" || record.operation !== "upsert") {
        continue;
      }
      const recording = (record.payload ?? {}) as Record<string, unknown>;
      const rows = await fetchClaapRecordingTranscripts(ctx, recording);
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
