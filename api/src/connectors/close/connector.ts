/**
 * The Close CRM connector. The class is the public entry point; the work
 * lives in sibling modules:
 *
 * - client.ts        HTTP client (rate gate, retry policy, sync-log lines)
 * - entities.ts      entity catalog, endpoints, incremental capabilities
 * - custom-fields.ts cached custom-field lookups
 * - search.ts        Search API walk (leads/contacts/opportunities/activities)
 * - list-fetchers.ts offset-paginated list endpoints
 * - records.ts       record normalization (leads, custom-field flattening)
 * - webhooks.ts      webhook events, verification, provisioning
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
import { resolveCloseEntitySchema } from "./schema";
import axios, { AxiosInstance } from "axios";
import { loggers } from "../../logging";
import { createCloseClient, type CloseLogLevel } from "./client";
import {
  CLOSE_SIMPLE_ENTITY_ENDPOINTS,
  closeAvailableEntities,
  closeEntityMetadata,
  closeIncrementalCapabilities,
  closeSearchObjectType,
  isCloseSearchEntity,
} from "./entities";
import { CloseCustomFieldCache } from "./custom-fields";
import type { CloseSearchContext } from "./fetch-context";
import {
  CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH,
  fetchCloseViaSearchApi,
} from "./search";
import {
  fetchAllCloseCustomFields,
  fetchCloseGroupsChunk,
  fetchCloseListChunk,
  fetchCloseLookupChunk,
  fetchCloseUsersChunk,
} from "./list-fetchers";
import { normalizeClosePayload } from "./records";
import {
  closeSupportedWebhookEvents,
  closeWebhookEventMapping,
  closeWebhookEventsForEntities,
  extractCloseWebhookData,
  fillCloseWebhookPartialRecords,
  provisionCloseWebhook,
  verifyCloseWebhook,
} from "./webhooks";

export { formatCloseApiErrorResponse } from "./client";
export { CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH } from "./search";

const logger = loggers.connector("close");

export class CloseConnector extends BaseConnector {
  private readonly customFields = new CloseCustomFieldCache(() =>
    this.getCloseClient(),
  );

  /**
   * Current per-request budget of `custom.cf_*` selectors for the Search
   * API. Starts at CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH and only ever shrinks,
   * when Close answers a field selection with HTTP 400.
   */
  private customSelectorBatchSize = CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH;

  private closeApi: AxiosInstance | null = null;
  private activeLogCallback?: (
    level: CloseLogLevel,
    message: string,
    metadata?: any,
  ) => void;
  private activeEntity?: string;
  private activeSyncMode: "full" | "incremental" = "full";

  async resolveSchema(entity: string): Promise<ConnectorEntitySchema | null> {
    const customFields = await this.customFields.forEntity(entity);
    return resolveCloseEntitySchema(entity, customFields);
  }

  private setLogContext(options: {
    entity: string;
    since?: Date;
    onLog?: any;
  }) {
    this.activeEntity = options.entity;
    this.activeSyncMode = options.since ? "incremental" : "full";
    this.activeLogCallback = options.onLog;
  }

  private emitSyncLog(
    level: CloseLogLevel,
    message: string,
    metadata?: Record<string, unknown>,
  ) {
    if (this.activeLogCallback) {
      this.activeLogCallback(level, message, {
        connector: "close",
        entity: this.activeEntity,
        syncMode: this.activeSyncMode,
        ...metadata,
      });
    }
  }

  private getSearchObjectType(entity: string): string {
    return closeSearchObjectType(entity);
  }

  /** What the fetch modules read from this instance, always late-bound. */
  private fetchContext(): CloseSearchContext {
    return {
      api: () => this.getCloseClient(),
      sleep: ms => this.sleep(ms),
      batchSize: () => this.getBatchSize(),
      rateLimitDelay: () => this.getRateLimitDelay(),
      log: (level, message, metadata) =>
        this.emitSyncLog(level, message, metadata),
      customFields: this.customFields,
      selectorBudget: () => this.customSelectorBatchSize,
      setSelectorBudget: size => {
        this.customSelectorBatchSize = size;
      },
    };
  }

  static getConfigSchema() {
    return {
      fields: [
        {
          name: "api_key",
          label: "API Key",
          type: "password",
          required: true,
          helperText: "Close API Key (generate in Close settings)",
        },
      ],
    };
  }

  getMetadata() {
    return {
      name: "Close",
      version: "1.0.0",
      description: "Connector for Close CRM",
      supportedEntities: [
        "leads",
        "opportunities",
        "activities",
        "contacts",
        "users",
        "custom_fields",
      ],
    };
  }

  validateConfig() {
    const base = super.validateConfig();
    const errors = [...base.errors];

    if (!this.sourceConnection.config.api_key) {
      errors.push("Close API key is required");
    }

    return { valid: errors.length === 0, errors };
  }

  private getCloseClient(): AxiosInstance {
    if (!this.closeApi) {
      if (!this.sourceConnection.config.api_key) {
        throw new Error("Close API key not configured");
      }
      this.closeApi = createCloseClient({
        apiKey: this.sourceConnection.config.api_key,
        minDelayMs: Math.max(500, this.getRateLimitDelay()),
        emitLog: (level, message, metadata) =>
          this.emitSyncLog(level, message, metadata),
        // Late-bound so tests that stub `sleep` on the instance stay fast.
        sleep: ms => this.sleep(ms),
      });
    }
    return this.closeApi;
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

      const api = this.getCloseClient();

      // Test connection by fetching user info
      await api.get("/me/");

      return {
        success: true,
        message: "Successfully connected to Close API",
      };
    } catch (error) {
      return {
        success: false,
        message: "Failed to connect to Close API",
        details: axios.isAxiosError(error) ? error.message : String(error),
      };
    }
  }

  getAvailableEntities(): string[] {
    return closeAvailableEntities();
  }

  getEntityMetadata(): EntityMetadata[] {
    return closeEntityMetadata();
  }

  supportsResumableFetching(): boolean {
    return true;
  }

  /**
   * Fetch a chunk of data with resumable state
   */
  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    this.setLogContext(options);
    const { entity, state } = options;
    const ctx = this.fetchContext();

    // custom_fields is not paginated: one chunk reads everything.
    if (entity === "custom_fields") {
      if (!state || state.totalProcessed === 0) {
        await fetchAllCloseCustomFields(ctx, options);
        return {
          totalProcessed: -1,
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

    if (entity === "users") {
      return await fetchCloseUsersChunk(ctx, options);
    }

    if (entity === "groups") {
      return await fetchCloseGroupsChunk(ctx, options);
    }

    if (entity in CLOSE_SIMPLE_ENTITY_ENDPOINTS) {
      return await fetchCloseLookupChunk(
        ctx,
        options,
        CLOSE_SIMPLE_ENTITY_ENDPOINTS[entity],
      );
    }

    // Custom objects require lead_id — backfill not supported, webhook-only
    if (entity === "custom_objects") {
      logger.warn(
        "Skipping custom_objects: backfill requires lead_id, use webhooks instead",
      );
      return { totalProcessed: 0, hasMore: false, iterationsInChunk: 0 };
    }

    // Bare "activities" without a subtype can't map to a Search API object type.
    if (entity === "activities") {
      logger.warn(
        "Bare 'activities' entity not supported — use activities:Call etc.",
      );
      return { totalProcessed: 0, hasMore: false, iterationsInChunk: 0 };
    }

    // Leads, contacts, opportunities, and activities all use the Search API
    // with native cursor pagination (no _skip limits).
    if (isCloseSearchEntity(entity)) {
      return await fetchCloseViaSearchApi(ctx, options);
    }

    // Offset-based pagination fallback for other entities
    return await fetchCloseListChunk(ctx, entity, options, () =>
      this.customFields.leadSelection(),
    );
  }

  async fetchEntity(options: FetchOptions): Promise<void> {
    this.setLogContext(options);
    const { entity } = options;
    const ctx = this.fetchContext();
    const drain = Number.POSITIVE_INFINITY;

    if (entity === "custom_fields") {
      await fetchAllCloseCustomFields(ctx, options);
      return;
    }

    // Users - always a full sync
    if (entity === "users") {
      await fetchCloseUsersChunk(ctx, {
        ...options,
        state: undefined,
        maxIterations: drain,
      });
      return;
    }

    // Groups expose functional-team membership; backfill all pages.
    if (entity === "groups") {
      await fetchCloseGroupsChunk(ctx, {
        ...options,
        maxIterations: Number.MAX_SAFE_INTEGER,
      });
      return;
    }

    // Simple entities (statuses, types) — paginated with the chunk default
    if (entity in CLOSE_SIMPLE_ENTITY_ENDPOINTS) {
      await fetchCloseLookupChunk(
        ctx,
        options,
        CLOSE_SIMPLE_ENTITY_ENDPOINTS[entity],
      );
      return;
    }

    // Activities use the Search API (same as leads/contacts/opportunities)
    if (entity.startsWith("activities:")) {
      await fetchCloseViaSearchApi(ctx, {
        ...options,
        maxIterations: Number.MAX_SAFE_INTEGER,
      });
      return;
    }

    // Leads, contacts, opportunities: the legacy list endpoints, every page.
    await fetchCloseListChunk(
      ctx,
      entity,
      { ...options, state: undefined, maxIterations: drain },
      () => this.customFields.leadSelection(),
    );
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
        providerLabel: "Close",
        storesSecretAutomatically: true,
        actionHint: "and stores its signing secret",
      },
      secretHelpText: "Enter the webhook signing secret from your provider",
    };
  }

  getIncrementalCapabilities(): IncrementalCapabilities {
    return closeIncrementalCapabilities();
  }

  async createWebhookSubscription(
    options: ProvisionWebhookOptions,
  ): Promise<ProvisionWebhookResult> {
    return provisionCloseWebhook(this.getCloseClient(), options, entities =>
      this.getWebhookEventsForEntities(entities),
    );
  }

  /**
   * Verify webhook signature and parse event
   */
  async verifyWebhook(
    options: WebhookHandlerOptions,
  ): Promise<WebhookVerificationResult> {
    return verifyCloseWebhook(options);
  }

  getWebhookEventMapping(eventType: string): WebhookEventMapping | null {
    return closeWebhookEventMapping(eventType);
  }

  getSupportedWebhookEvents(): string[] {
    return closeSupportedWebhookEvents();
  }

  /**
   * Return only the webhook event strings relevant to the given entities.
   * Falls back to all supported events when the entity list is empty
   * (i.e. no explicit selection — sync everything).
   */
  getWebhookEventsForEntities(entities: string[]): string[] {
    return closeWebhookEventsForEntities(entities);
  }

  extractWebhookData(event: any): { id: string; data: any } | null {
    return extractCloseWebhookData(event);
  }

  extractWebhookCdcRecords(
    event: any,
    eventType?: string,
  ): NormalizedCdcRecord[] {
    const records = super.extractWebhookCdcRecords(event, eventType);
    const innerEvent = event?.event;
    const candidateTs =
      innerEvent?.date_updated ||
      innerEvent?.date_created ||
      event?.date_updated ||
      event?.date_created ||
      event?.timestamp;

    if (!candidateTs) {
      return records;
    }

    const sourceTs = new Date(String(candidateTs));
    if (Number.isNaN(sourceTs.getTime())) {
      return records;
    }

    return records.map(record => ({
      ...record,
      payload: normalizeClosePayload(
        record.entity,
        (record.payload || {}) as Record<string, unknown>,
      ),
      sourceTs,
      // Close nests its unique event id at `event.event.id`. Prefer it FIRST
      // so distinct updates get distinct changeIds; the per-record fallback
      // includes sourceTs so it can never collapse multiple updates onto one
      // idempotency key (the bug that froze destinations at first-seen state).
      changeId:
        innerEvent?.id ||
        event?.id ||
        record.changeId ||
        `${eventType || "close.event"}:${record.entity}:${record.recordId}:${sourceTs.toISOString()}`,
    }));
  }

  /**
   * Close webhook payloads leave out an object's expansions (a lead's
   * contacts, opportunities and tasks, an email's quoted bodies, …). Read
   * them from the REST object before the record is applied, so a webhook
   * upsert never NULLs them (see fillCloseWebhookPartialRecords).
   */
  async enrichWebhookCdcRecords(
    records: NormalizedCdcRecord[],
    options: { isEntityEnabled: (entity: string) => boolean },
  ): Promise<NormalizedCdcRecord[]> {
    return fillCloseWebhookPartialRecords(
      () => this.getCloseClient(),
      records,
      // The flow drops records of entities it does not sync; never spend a
      // request on them.
      record => options.isEntityEnabled(record.entity),
    );
  }

  normalizeBackfillRecord(
    entity: string,
    record: Record<string, unknown>,
  ): NormalizedCdcRecord | null {
    const normalized = super.normalizeBackfillRecord(entity, record);
    if (!normalized) {
      return null;
    }

    return {
      ...normalized,
      payload: normalizeClosePayload(
        entity,
        (normalized.payload || {}) as Record<string, unknown>,
      ),
      sourceTs: this.resolveRecordTimestamp(record),
    };
  }
}
