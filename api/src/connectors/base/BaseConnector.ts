import { IConnector } from "../../database/workspace-schema";

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
