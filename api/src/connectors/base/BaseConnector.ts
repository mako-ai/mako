import axios from "axios";
import { IConnector } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import type { NormalizedCdcEvent } from "../../sync-cdc/events";

const retryLogger = loggers.connector("http-retry");

/**
 * Options for {@link BaseConnector.executeHttpWithRetry}. Defaults preserve the
 * behavior the individual connectors previously hand-rolled: up to 5 retries on
 * HTTP 429 / 5xx, honoring a numeric `Retry-After` header, with exponential
 * backoff otherwise.
 */
export interface HttpRetryOptions {
  /** Max number of retries after the initial attempt. Default: 5. */
  maxRetries?: number;
  /** Base delay for exponential backoff, in ms. Default: 1000. */
  baseDelayMs?: number;
  /** Upper bound applied to exponential backoff, in ms. Default: 60_000. */
  maxDelayMs?: number;
  /**
   * Fixed wait (seconds) used when the error is retryable but carries no
   * numeric `Retry-After` header. When omitted, exponential backoff is used.
   * A present numeric `Retry-After` header always takes precedence.
   */
  retryAfterFallbackSeconds?: number;
  /**
   * Decide whether a thrown error should be retried. Default: HTTP 429 or 5xx.
   */
  isRetryable?: (error: unknown) => boolean;
  /**
   * Transform the error that is ultimately thrown (when not retryable or once
   * retries are exhausted). Lets connectors surface a friendlier message while
   * keeping the original error type.
   */
  transformFinalError?: (error: unknown) => unknown;
  /** Human-readable label used in the structured retry log line. */
  label?: string;
}

export interface SyncLogger {
  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    metadata?: any,
  ): void;
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  details?: any;
}

// Callback types for streaming data
export type DataBatchCallback<T = any> = (batch: T[]) => Promise<void>;
export type ProgressCallback = (current: number, total?: number) => void;

// New interface for tracking fetch state between chunks
export interface FetchState {
  // Common pagination state
  offset?: number;
  cursor?: string;
  page?: number;

  // Progress tracking
  totalProcessed: number;
  hasMore: boolean;

  // For tracking iterations in current chunk
  iterationsInChunk: number;

  // Connector-specific state
  metadata?: any;
}

// Options for fetching data
export interface FetchOptions {
  entity: string;
  batchSize?: number;
  onBatch: DataBatchCallback;
  onProgress?: ProgressCallback;
  onLog?: SyncLogger["log"];
  since?: Date; // For incremental syncs
  rateLimitDelay?: number;
  maxRetries?: number;
}

// New options for resumable fetching
export interface ResumableFetchOptions extends FetchOptions {
  maxIterations?: number; // Max API calls in this chunk (default: 10)
  state?: FetchState; // Resume from previous state
}

// Webhook verification result
export interface WebhookVerificationResult {
  valid: boolean;
  event?: any; // The parsed webhook event
  error?: string;
}

// Webhook event mapping
export interface WebhookEventMapping {
  entity: string;
  operation: "upsert" | "delete";
}

// Webhook handler options
export interface WebhookHandlerOptions {
  payload: any;
  headers: Record<string, string | string[] | undefined>;
  secret?: string;
}

export interface ProvisionWebhookOptions {
  endpointUrl: string;
  verifySsl?: boolean;
  events?: string[];
  enabledEntities?: string[];
}

export interface ProvisionWebhookResult {
  providerWebhookId: string;
  endpointUrl: string;
  signingSecret?: string;
}

/**
 * Static, UI-facing description of a connector's webhook support. Surfaced
 * through connector metadata so the generic webhook UI stays connector-agnostic
 * (no `if (type === "stripe")` branching in components — see rule 15).
 */
export interface WebhookProvisioningCapability {
  /** Connector can create the provider-side webhook subscription itself. */
  supported: boolean;
  /** Provider display name, used in copy like `Create in {providerLabel}`. */
  providerLabel: string;
  /** Provisioning persists the signing secret automatically on creation. */
  storesSecretAutomatically: boolean;
  /**
   * Optional clause appended after "One click creates the {provider} webhook"
   * (e.g. "and stores its signing secret").
   */
  actionHint?: string;
}

export interface WebhookCapabilities {
  /** Connector can receive inbound webhooks at all. */
  supported: boolean;
  /** Auto-provisioning capability + UI copy. */
  provisioning: WebhookProvisioningCapability;
  /** Help text for the manual signing-secret input field. */
  secretHelpText?: string;
}

export type NormalizedCdcRecord = Omit<NormalizedCdcEvent, "runId">;

export type ConnectorLogicalType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "timestamp"
  | "json";

export interface ConnectorFieldSchema {
  type: ConnectorLogicalType;
  nullable?: boolean;
  required?: boolean;
  defaultValue?: unknown;
  derivedFrom?: string;
}

export interface ConnectorEntitySchema {
  entity: string;
  fields: Record<string, ConnectorFieldSchema>;
  unknownFieldPolicy: "string" | "drop";
  keyColumns?: string[];
}

export const MAKO_SYSTEM_FIELDS: Record<string, ConnectorFieldSchema> = {
  _mako_deleted_at: { type: "timestamp", nullable: true },
  deleted_at: {
    type: "timestamp",
    nullable: true,
    derivedFrom: "_mako_deleted_at",
  },
  is_deleted: { type: "boolean", nullable: false, defaultValue: false },
  _mako_source_ts: { type: "timestamp", nullable: true },
  _mako_ingest_seq: { type: "integer", nullable: true },
  _dataSourceId: { type: "string", nullable: true },
  _dataSourceName: { type: "string", nullable: true },
  _syncedAt: { type: "timestamp", nullable: true },
};

// Suggested table layout for BigQuery destinations
export interface TableLayoutSuggestion {
  partitionField?: string;
  partitionGranularity?: "day" | "hour" | "month" | "year";
  clusterFields?: string[];
}

// Entity metadata for hierarchical entity structure
export interface EntityMetadata {
  name: string;
  label?: string;
  description?: string;
  subEntities?: EntityMetadata[];
  /** Suggested BigQuery table layout for this entity */
  layoutSuggestion?: TableLayoutSuggestion;
}

export abstract class BaseConnector {
  protected dataSource: IConnector;

  constructor(dataSource: IConnector) {
    this.dataSource = dataSource;
  }

  /**
   * Resolve the typed schema contract for an entity.
   * Connectors override this to declare field types explicitly,
   * including dynamically discovered custom fields.
   */
  async resolveSchema(_entity: string): Promise<ConnectorEntitySchema | null> {
    return null;
  }

  /**
   * Test the connection to the data source
   */
  abstract testConnection(): Promise<ConnectionTestResult>;

  /**
   * Get available entities that can be fetched from this source
   */
  abstract getAvailableEntities(): string[];

  /**
   * Get detailed entity metadata including sub-entities
   * Default implementation converts flat entity list to metadata format
   */
  getEntityMetadata(): EntityMetadata[] {
    // Default implementation for backward compatibility
    return this.getAvailableEntities().map(entity => ({
      name: entity,
      label: entity.charAt(0).toUpperCase() + entity.slice(1),
    }));
  }

  /**
   * Fetch data for a specific entity using callbacks
   * The connector should call onBatch for each batch of data fetched
   * and onProgress to report progress
   */
  abstract fetchEntity(options: FetchOptions): Promise<void>;

  /**
   * Fetch a chunk of data for a specific entity, returning state to resume
   * This method should perform up to maxIterations API calls and return
   * the state needed to resume from where it left off
   */
  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    // Default implementation that calls fetchEntity for backwards compatibility
    // Connectors should override this for proper resumable support
    if (!options.state || options.state.totalProcessed === 0) {
      // First chunk - just run the full fetch
      await this.fetchEntity(options);
      return {
        totalProcessed: -1, // Unknown
        hasMore: false,
        iterationsInChunk: -1,
      };
    }

    throw new Error(
      "Resumable fetching not implemented for this connector. Please use fetchEntity() instead.",
    );
  }

  /**
   * Check if connector supports resumable fetching
   */
  supportsResumableFetching(): boolean {
    // Connectors that implement fetchEntityChunk should override this
    return false;
  }

  /**
   * Get connector metadata
   */
  abstract getMetadata(): {
    name: string;
    version: string;
    description: string;
    author?: string;
    supportedEntities: string[];
  };

  /**
   * Validate data source configuration
   */
  validateConfig(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!this.dataSource.name) {
      errors.push("Data source name is required");
    }

    if (!this.dataSource.type) {
      errors.push("Data source type is required");
    }

    if (!this.dataSource.config) {
      errors.push("Data source configuration is required");
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get rate limit delay from settings
   */
  protected getRateLimitDelay(): number {
    return this.dataSource.settings?.rate_limit_delay_ms || 200;
  }

  /**
   * Get batch size from settings
   */
  protected getBatchSize(): number {
    return this.dataSource.settings?.sync_batch_size || 100;
  }

  /**
   * Sleep for rate limiting
   */
  protected async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Default retryability check: HTTP 429 (rate limited) or any 5xx.
   */
  protected static isRetryableHttpError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) return false;
    const status = error.response?.status;
    if (status === undefined) return false;
    return status === 429 || (status >= 500 && status < 600);
  }

  /**
   * Parse a numeric `Retry-After` header (in seconds) from an axios error.
   * Returns `undefined` when absent or non-numeric.
   */
  private static parseRetryAfterSeconds(error: unknown): number | undefined {
    if (!axios.isAxiosError(error)) return undefined;
    const header = error.response?.headers?.["retry-after"];
    if (header === undefined || header === null) return undefined;
    const seconds = parseInt(String(header), 10);
    return Number.isFinite(seconds) ? seconds : undefined;
  }

  /**
   * Shared HTTP retry wrapper for connectors (see rule 15: connectors should
   * use one retry pattern, honor `Retry-After`, and back off on 429/5xx instead
   * of ad-hoc loops). Connectors tune behavior via {@link HttpRetryOptions}.
   */
  protected async executeHttpWithRetry<T>(
    fn: () => Promise<T>,
    options: HttpRetryOptions = {},
  ): Promise<T> {
    const {
      maxRetries = 5,
      baseDelayMs = 1000,
      maxDelayMs = 60_000,
      retryAfterFallbackSeconds,
      isRetryable = BaseConnector.isRetryableHttpError,
      transformFinalError,
      label = "HTTP request",
    } = options;

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await fn();
      } catch (error) {
        if (!isRetryable(error) || attempt >= maxRetries) {
          throw transformFinalError ? transformFinalError(error) : error;
        }

        const headerSeconds = BaseConnector.parseRetryAfterSeconds(error);
        let delayMs: number;
        if (headerSeconds !== undefined) {
          delayMs = headerSeconds * 1000;
        } else if (retryAfterFallbackSeconds !== undefined) {
          delayMs = retryAfterFallbackSeconds * 1000;
        } else {
          delayMs = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
        }

        retryLogger.warn(`${label} failed; retrying`, {
          attempt: attempt + 1,
          maxRetries,
          delayMs,
          status: axios.isAxiosError(error)
            ? error.response?.status
            : undefined,
        });

        await this.sleep(delayMs);
        attempt++;
      }
    }
  }

  /**
   * Check if connector supports webhooks
   */
  supportsWebhooks(): boolean {
    // Connectors that support webhooks should override this
    return false;
  }

  /**
   * Check if connector can provision provider webhooks automatically.
   */
  supportsWebhookProvisioning(): boolean {
    // Connectors that can create provider-side subscriptions should override.
    return false;
  }

  /**
   * Static, UI-facing webhook capabilities. Defaults are derived from the
   * existing capability predicates; connectors override to provide provider
   * labels and help text so the generic webhook UI never hardcodes connector
   * types. Must be safe to call on a metadata-only (dummy) instance.
   */
  getWebhookCapabilities(): WebhookCapabilities {
    return {
      supported: this.supportsWebhooks(),
      provisioning: {
        supported: this.supportsWebhookProvisioning(),
        providerLabel: this.getMetadata().name,
        storesSecretAutomatically: false,
      },
      secretHelpText: "Enter the webhook signing secret from your provider",
    };
  }

  /**
   * Create a provider-side webhook subscription.
   */
  async createWebhookSubscription(
    _options: ProvisionWebhookOptions,
  ): Promise<ProvisionWebhookResult> {
    throw new Error("Webhook provisioning not supported by this connector");
  }

  /**
   * Verify webhook signature and parse event
   */
  async verifyWebhook(
    _options: WebhookHandlerOptions,
  ): Promise<WebhookVerificationResult> {
    // Default implementation - connectors should override
    return {
      valid: false,
      error: "Webhooks not supported by this connector",
    };
  }

  /**
   * Get webhook event mapping for a given event type
   */
  getWebhookEventMapping(_eventType: string): WebhookEventMapping | null {
    // Default implementation - connectors should override
    return null;
  }

  /**
   * Get supported webhook event types
   */
  getSupportedWebhookEvents(): string[] {
    // Default implementation - connectors should override
    return [];
  }

  /**
   * Extract entity data from webhook event
   */
  extractWebhookData(_event: any): { id: string; data: any } | null {
    // Default implementation - connectors should override
    return null;
  }

  /**
   * Convert webhook event payload into canonical CDC records.
   * Default implementation uses existing webhook mapping + extractWebhookData.
   */
  extractWebhookCdcRecords(
    event: any,
    eventType?: string,
  ): NormalizedCdcRecord[] {
    const resolvedEventType =
      eventType || event?.type || event?.event_type || event?.action;
    if (!resolvedEventType) {
      return [];
    }

    const mapping = this.getWebhookEventMapping(resolvedEventType);
    if (!mapping) {
      return [];
    }

    const extracted = this.extractWebhookData(event);
    if (!extracted) {
      return [];
    }

    const sourceTs = this.resolveRecordTimestamp(extracted.data);
    return [
      {
        entity: mapping.entity,
        recordId: extracted.id,
        operation: mapping.operation,
        payload: extracted.data,
        sourceTs,
        source: "webhook",
        // Prefer a vendor-unique event id. The final fallback now includes the
        // source timestamp so two DISTINCT updates of the same record never
        // share a changeId (which would otherwise collapse to one idempotency
        // key and silently drop every update after the first).
        changeId:
          event?.id ||
          event?.event_id ||
          event?.eventId ||
          event?.event?.id ||
          `${resolvedEventType}:${extracted.id}:${sourceTs.toISOString()}`,
      },
    ];
  }

  /**
   * Normalize backfill records into the same canonical CDC shape as webhooks.
   */
  normalizeBackfillRecord(
    entity: string,
    record: Record<string, unknown>,
  ): NormalizedCdcRecord | null {
    const recordId = String(record.id || record._id || "");
    if (!recordId) {
      return null;
    }

    return {
      entity,
      recordId,
      operation: "upsert",
      payload: record,
      sourceTs: this.resolveRecordTimestamp(record),
      source: "backfill",
    };
  }

  protected resolveRecordTimestamp(payload?: Record<string, unknown>): Date {
    const candidates = [
      payload?.date_updated,
      payload?.updated_at,
      payload?.updatedAt,
      payload?.date_created,
      payload?.created_at,
      payload?.createdAt,
      payload?.timestamp,
      payload?._syncedAt,
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

/**
 * Connector registry interface
 */
export interface ConnectorMetadata {
  type: string;
  connector: typeof BaseConnector;
  metadata: {
    name: string;
    version: string;
    description: string;
    author?: string;
    supportedEntities: string[];
  };
}
