import { IConnector } from "../../database/workspace-schema";
import type { NormalizedCdcEvent } from "../../sync-cdc/events";

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
}

export interface ProvisionWebhookResult {
  providerWebhookId: string;
  endpointUrl: string;
  signingSecret?: string;
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

    return [
      {
        entity: mapping.entity,
        recordId: extracted.id,
        operation: mapping.operation,
        payload: extracted.data,
        sourceTs: this.resolveRecordTimestamp(extracted.data),
        source: "webhook",
        changeId:
          event?.id ||
          event?.event_id ||
          event?.eventId ||
          `${resolvedEventType}:${extracted.id}`,
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
      payload?.date_created,
      payload?.created_at,
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
