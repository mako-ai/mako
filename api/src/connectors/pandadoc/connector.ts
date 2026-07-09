import crypto from "node:crypto";
import axios, { AxiosError, AxiosInstance } from "axios";
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
  type IncrementalCapabilities,
  type ConnectorEntitySchema,
} from "../base/BaseConnector";
import { resolvePandaDocEntitySchema } from "./schema";
import { loggers } from "../../logging";

const logger = loggers.connector("pandadoc");

const DEFAULT_BASE_URL = "https://api.pandadoc.com";
const MAX_PAGE_LIMIT = 100;

const SUPPORTED_ENTITIES = [
  "documents",
  "templates",
  "contacts",
  "members",
] as const;

type SupportedEntity = (typeof SUPPORTED_ENTITIES)[number];

// Entities that paginate via ?count=&page=. Contacts/members return the whole
// collection in a single response (no pagination params).
const PAGINATED_ENTITIES: Record<SupportedEntity, boolean> = {
  documents: true,
  templates: true,
  contacts: false,
  members: false,
};

const ENTITY_LIST_PATH: Record<SupportedEntity, string> = {
  documents: "/public/v1/documents",
  templates: "/public/v1/templates",
  contacts: "/public/v1/contacts",
  members: "/public/v1/members",
};

// The document LIST endpoint only returns a shallow projection. The rich nested
// objects (fields, tokens, metadata, pricing, products, grand_total,
// recipients, ...) live exclusively on the per-document DETAILS endpoint, so
// backfill must hydrate each listed document from here.
const documentDetailPath = (documentId: string): string =>
  `/public/v1/documents/${encodeURIComponent(documentId)}/details`;

// How many document-detail requests to run concurrently while hydrating a list
// page. Kept small so a backfill stays well under PandaDoc's rate limits while
// still being meaningfully faster than a fully sequential loop.
const DOCUMENT_DETAIL_CONCURRENCY = 5;

// When detail hydration is on, every list page fans out into up to
// `pageCount` extra detail requests. Cap the pages processed per resumable
// chunk so a single chunk's wall-clock stays bounded; the resume cursor picks
// up the remaining pages on the next chunk.
const DETAIL_HYDRATION_MAX_PAGES_PER_CHUNK = 2;

// All PandaDoc webhook triggers. document_deleted/template_deleted map to a
// CDC delete; everything else is an upsert.
const DOCUMENT_TRIGGERS = [
  "document_state_changed",
  "document_updated",
  "document_creation_failed",
  "document_completed_pdf_ready",
  "document_section_added",
  "recipient_completed",
  "quote_updated",
  "document_deleted",
] as const;

const TEMPLATE_TRIGGERS = [
  "template_created",
  "template_updated",
  "template_deleted",
] as const;

const SUPPORTED_WEBHOOK_EVENTS = [
  ...DOCUMENT_TRIGGERS,
  ...TEMPLATE_TRIGGERS,
] as const;

type PandaDocListResponse<T = Record<string, unknown>> = {
  results?: T[];
};

type PandaDocWebhookItem = {
  event?: string;
  data?: Record<string, unknown>;
};

/**
 * PandaDoc members have no `id`; their stable identifier is `membership_id`.
 * Mirror it onto `id` so the key column is uniform across entities.
 */
function withId(
  entity: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  if (record == null) return record;
  if (typeof record.id === "string" && record.id.length > 0) return record;
  if (entity === "members" && typeof record.membership_id === "string") {
    return { ...record, id: record.membership_id };
  }
  return record;
}

function formatPandaDocApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data as
      | {
          detail?: unknown;
          message?: string;
          type?: string;
        }
      | string
      | undefined;

    const direct =
      typeof data === "string"
        ? data
        : typeof data?.message === "string"
          ? data.message
          : typeof data?.detail === "string"
            ? data.detail
            : data?.detail && typeof data.detail === "object"
              ? JSON.stringify(data.detail)
              : undefined;

    const detail = direct || error.message;
    return status ? `HTTP ${status}: ${detail}` : detail;
  }

  return error instanceof Error ? error.message : String(error);
}

export class PandaDocConnector extends BaseConnector {
  private pandaDocApi: AxiosInstance | null = null;

  static getConfigSchema() {
    return {
      fields: [
        {
          name: "api_key",
          label: "API Key",
          type: "password",
          required: true,
          helperText:
            "PandaDoc API Key (generate in the Developer Dashboard). Used as `Authorization: API-Key <key>`.",
        },
        {
          name: "api_base_url",
          label: "API Base URL",
          type: "string",
          required: false,
          default: DEFAULT_BASE_URL,
        },
        {
          name: "fetch_document_details",
          label: "Fetch full document details",
          type: "boolean",
          required: false,
          default: true,
          helperText:
            "Hydrate each document with its full detail (fields, tokens, metadata, pricing, products, recipients) during backfill. The document list endpoint omits these. Disable to reduce API calls if you hit rate limits.",
        },
      ],
    };
  }

  getMetadata() {
    return {
      name: "PandaDoc",
      version: "1.0.0",
      description:
        "Connector for PandaDoc documents, templates, contacts, and members. Real-time document + template webhooks (CDC); scheduled backfill covers contacts and members.",
      supportedEntities: [...SUPPORTED_ENTITIES],
    };
  }

  validateConfig() {
    const base = super.validateConfig();
    const errors = [...base.errors];

    if (!this.dataSource.config.api_key) {
      errors.push("PandaDoc API key is required");
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

  private getClient(): AxiosInstance {
    if (!this.pandaDocApi) {
      if (!this.dataSource.config.api_key) {
        throw new Error("PandaDoc API key not configured");
      }

      this.pandaDocApi = axios.create({
        baseURL: this.getBaseUrl(),
        headers: {
          Authorization: `API-Key ${this.dataSource.config.api_key}`,
          "Content-Type": "application/json",
        },
      });
    }
    return this.pandaDocApi;
  }

  private headerValue(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string | undefined {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== lower) continue;
      return Array.isArray(value) ? value[0] : value;
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
          if (axios.isAxiosError(error)) {
            error.message = formatPandaDocApiError(error);
          }
          throw error;
        }

        const retryAfterHeader = axiosError.response?.headers?.["retry-after"];
        const retryAfterSeconds = parseInt(String(retryAfterHeader ?? ""), 10);
        const delayMs = Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds * 1000
          : Math.min(1000 * 2 ** attempt, 60_000);

        logger.warn("PandaDoc API rate limited or server error, retrying", {
          status,
          attempt: attempt + 1,
          delayMs,
        });
        await this.sleep(delayMs);
        attempt++;
      }
    }
  }

  private resolvePageCount(batchSize?: number): number {
    const requested =
      typeof batchSize === "number" && batchSize > 0
        ? batchSize
        : this.getBatchSize();
    return Math.min(Math.max(requested, 1), MAX_PAGE_LIMIT);
  }

  /**
   * Whether to hydrate listed documents from the per-document details endpoint.
   * Defaults to ON; the `fetch_document_details` config flag can disable it for
   * rate-limit-constrained workspaces.
   */
  private shouldFetchDocumentDetails(): boolean {
    const configured = this.dataSource.config.fetch_document_details;
    return configured !== false && configured !== "false";
  }

  /**
   * Hydrate each document from `GET /public/v1/documents/{id}/details`, merging
   * the rich nested objects (fields, tokens, metadata, pricing, products,
   * grand_total, recipients, ...) over the shallow list projection. Detail
   * fetches run in small concurrent batches and a per-document failure falls
   * back to the list projection rather than failing the whole backfill.
   */
  private async enrichDocumentsWithDetails(
    records: Record<string, unknown>[],
    rateLimitDelay: number,
  ): Promise<Record<string, unknown>[]> {
    if (records.length === 0 || !this.shouldFetchDocumentDetails()) {
      return records;
    }

    const api = this.getClient();
    const enriched = [...records];

    for (let start = 0; start < enriched.length; start += DOCUMENT_DETAIL_CONCURRENCY) {
      const batch = enriched.slice(start, start + DOCUMENT_DETAIL_CONCURRENCY);

      await Promise.all(
        batch.map(async (record, offset) => {
          const documentId =
            typeof record.id === "string" && record.id.length > 0
              ? record.id
              : undefined;
          if (!documentId) return;

          try {
            const response = await this.executeWithRetry(() =>
              api.get<Record<string, unknown>>(documentDetailPath(documentId)),
            );
            const detail = response.data;
            if (detail && typeof detail === "object") {
              enriched[start + offset] = withId("documents", {
                ...record,
                ...detail,
              });
            }
          } catch (error) {
            logger.warn(
              "Failed to fetch PandaDoc document details; keeping list projection",
              {
                documentId,
                error: formatPandaDocApiError(error),
              },
            );
          }
        }),
      );

      if (start + DOCUMENT_DETAIL_CONCURRENCY < enriched.length) {
        await this.sleep(rateLimitDelay);
      }
    }

    return enriched;
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

      const api = this.getClient();
      // Lightweight authenticated call: list a single document.
      await this.executeWithRetry(() =>
        api.get(ENTITY_LIST_PATH.documents, { params: { count: 1, page: 1 } }),
      );

      return {
        success: true,
        message: "Successfully connected to PandaDoc API",
      };
    } catch (error) {
      return {
        success: false,
        message: "Failed to connect to PandaDoc API",
        details: formatPandaDocApiError(error),
      };
    }
  }

  getAvailableEntities(): string[] {
    return [...SUPPORTED_ENTITIES];
  }

  getEntityMetadata(): EntityMetadata[] {
    const layout = (partitionField: string) => ({
      partitionField,
      partitionGranularity: "day" as const,
      clusterFields: ["_dataSourceId", "id"],
    });

    return [
      {
        name: "documents",
        label: "Documents",
        description: "PandaDoc documents with status, recipients, and pricing",
        layoutSuggestion: layout("date_created"),
      },
      {
        name: "templates",
        label: "Templates",
        description: "Document templates",
        layoutSuggestion: layout("date_created"),
      },
      {
        name: "contacts",
        label: "Contacts",
        description: "Workspace contacts directory",
        layoutSuggestion: {
          partitionField: "_syncedAt",
          partitionGranularity: "day",
          clusterFields: ["_dataSourceId", "id"],
        },
      },
      {
        name: "members",
        label: "Members",
        description: "Workspace members (users)",
        layoutSuggestion: layout("date_created"),
      },
    ];
  }

  async resolveSchema(entity: string): Promise<ConnectorEntitySchema | null> {
    return resolvePandaDocEntitySchema(entity);
  }

  supportsResumableFetching(): boolean {
    return true;
  }

  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    const { entity } = options;

    if (!(SUPPORTED_ENTITIES as readonly string[]).includes(entity)) {
      throw new Error(`Unsupported entity for PandaDoc connector: ${entity}`);
    }

    const typedEntity = entity as SupportedEntity;
    return PAGINATED_ENTITIES[typedEntity]
      ? this.fetchPaginatedChunk(options, typedEntity)
      : this.fetchSingleShotChunk(options, typedEntity);
  }

  private buildListParams(
    entity: SupportedEntity,
    page: number,
    count: number,
    since?: Date,
  ): Record<string, string | number> {
    const params: Record<string, string | number> = { count, page };

    if (entity === "documents") {
      params.order_by = "date_modified";
      if (since instanceof Date) {
        params.modified_from = since.toISOString();
      }
    }

    return params;
  }

  private mapRecords(
    entity: SupportedEntity,
    rawResults: Record<string, unknown>[],
    since?: Date,
  ): Record<string, unknown>[] {
    let records = rawResults.map(item => withId(entity, item));

    // Documents are filtered server-side via modified_from. Templates and
    // members expose date_modified but no incremental query param, so filter
    // client-side. Contacts carry no timestamp — always full sync.
    if (
      since instanceof Date &&
      (entity === "templates" || entity === "members")
    ) {
      const sinceMs = since.getTime();
      records = records.filter(item => {
        const modified =
          typeof item.date_modified === "string"
            ? new Date(item.date_modified).getTime()
            : NaN;
        return Number.isFinite(modified) ? modified >= sinceMs : true;
      });
    }

    return records;
  }

  private async fetchPaginatedChunk(
    options: ResumableFetchOptions,
    entity: SupportedEntity,
  ): Promise<FetchState> {
    const { onBatch, onProgress, since, state, batchSize } = options;
    const api = this.getClient();
    const path = ENTITY_LIST_PATH[entity];
    const count = this.resolvePageCount(batchSize);
    const rateLimitDelay = options.rateLimitDelay ?? this.getRateLimitDelay();

    // Hydrating documents fans each page out into many detail requests, so cap
    // the pages handled per chunk to keep the chunk's runtime bounded.
    const hydrateDocuments =
      entity === "documents" && this.shouldFetchDocumentDetails();
    const maxIterations = Math.min(
      options.maxIterations ?? 10,
      hydrateDocuments ? DETAIL_HYDRATION_MAX_PAGES_PER_CHUNK : Number.MAX_SAFE_INTEGER,
    );

    let page = (state?.page as number | undefined) ?? 1;
    let recordCount = state?.totalProcessed ?? 0;
    let iterations = 0;

    while (iterations < maxIterations) {
      const params = this.buildListParams(entity, page, count, since);
      const response = await this.executeWithRetry(() =>
        api.get<PandaDocListResponse>(path, { params }),
      );
      const results = Array.isArray(response.data?.results)
        ? response.data.results
        : [];

      let records = this.mapRecords(
        entity,
        results as Record<string, unknown>[],
        since,
      );

      if (hydrateDocuments) {
        records = await this.enrichDocumentsWithDetails(records, rateLimitDelay);
      }

      if (records.length > 0) {
        await onBatch(records);
        recordCount += records.length;
        onProgress?.(recordCount, undefined);
      }

      iterations++;

      // A short page means the dataset is exhausted.
      if (results.length < count) {
        return {
          page,
          totalProcessed: recordCount,
          hasMore: false,
          iterationsInChunk: iterations,
        };
      }

      page++;
      await this.sleep(rateLimitDelay);
    }

    return {
      page,
      totalProcessed: recordCount,
      hasMore: true,
      iterationsInChunk: iterations,
    };
  }

  private async fetchSingleShotChunk(
    options: ResumableFetchOptions,
    entity: SupportedEntity,
  ): Promise<FetchState> {
    const { onBatch, onProgress, since, state } = options;

    // Non-paginated endpoints return everything at once, so a resumed chunk has
    // nothing left to do.
    if (state && state.totalProcessed !== 0) {
      return {
        totalProcessed: state.totalProcessed,
        hasMore: false,
        iterationsInChunk: 0,
      };
    }

    const api = this.getClient();
    const path = ENTITY_LIST_PATH[entity];
    const response = await this.executeWithRetry(() =>
      api.get<PandaDocListResponse>(path),
    );
    const results = Array.isArray(response.data?.results)
      ? response.data.results
      : [];

    const records = this.mapRecords(
      entity,
      results as Record<string, unknown>[],
      since,
    );

    if (records.length > 0) {
      await onBatch(records);
      onProgress?.(records.length, records.length);
    }

    return {
      totalProcessed: records.length,
      hasMore: false,
      iterationsInChunk: 1,
    };
  }

  async fetchEntity(options: FetchOptions): Promise<void> {
    // Drain every chunk. Looping (rather than one giant maxIterations) keeps the
    // internal per-chunk caps used for detail hydration from truncating a full,
    // non-resumable fetch.
    let state: FetchState | undefined;
    do {
      state = await this.fetchEntityChunk({ ...options, state });
    } while (state.hasMore);
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
        providerLabel: "PandaDoc",
        storesSecretAutomatically: true,
      },
      secretHelpText:
        "Enter the webhook subscription Shared Key from the PandaDoc Developer Dashboard (used to verify the HMAC signature).",
    };
  }

  getIncrementalCapabilities(): IncrementalCapabilities {
    return {
      supported: true,
      // Fallback for any entity not listed below (e.g. contacts): `since`
      // is not applied by `fetchEntityChunk`, so treat as unsupported.
      mode: "none",
      perEntity: {
        documents: { mode: "native", anchorField: "modified_from" },
        templates: { mode: "client-filter" },
        members: { mode: "client-filter" },
      },
    };
  }

  async createWebhookSubscription(
    options: ProvisionWebhookOptions,
  ): Promise<ProvisionWebhookResult> {
    const api = this.getClient();

    const requestedEvents = Array.isArray(options.events)
      ? options.events.map(event => event.trim()).filter(Boolean)
      : [];

    const effectiveEvents =
      requestedEvents.length > 0
        ? requestedEvents
        : this.getWebhookEventsForEntities(options.enabledEntities ?? []);

    const triggers = effectiveEvents.filter(event =>
      (SUPPORTED_WEBHOOK_EVENTS as readonly string[]).includes(event),
    );

    if (triggers.length === 0) {
      throw new Error(
        requestedEvents.length > 0
          ? `No valid PandaDoc webhook events configured. Supported: ${SUPPORTED_WEBHOOK_EVENTS.join(", ")}`
          : "No webhook events resolved for the selected entities",
      );
    }

    const payload = {
      name: "Mako",
      url: options.endpointUrl,
      active: true,
      // Include the rich payload sections so document rows carry pricing,
      // fields, products, tokens, and metadata.
      payload: ["fields", "products", "tokens", "metadata", "pricing"],
      triggers,
    };

    try {
      const response = await this.executeWithRetry(() =>
        api.post("/public/v1/webhook-subscriptions", payload),
      );
      const data = (response.data ?? {}) as {
        uuid?: string;
        shared_key?: string;
      };
      const providerWebhookId = data.uuid;
      if (!providerWebhookId) {
        throw new Error(
          "PandaDoc webhook created but no subscription uuid returned by API",
        );
      }
      return {
        providerWebhookId: String(providerWebhookId),
        endpointUrl: options.endpointUrl,
        signingSecret:
          typeof data.shared_key === "string" && data.shared_key.length > 0
            ? data.shared_key
            : undefined,
      };
    } catch (error) {
      throw new Error(
        `Failed to create PandaDoc webhook subscription: ${formatPandaDocApiError(error)}`,
      );
    }
  }

  async verifyWebhook(
    options: WebhookHandlerOptions,
  ): Promise<WebhookVerificationResult> {
    const { payload, headers, secret, query } = options;

    if (!secret) {
      return { valid: false, error: "Missing webhook shared key on flow" };
    }

    // PandaDoc appends the HMAC signature as a `signature` query parameter; some
    // setups also surface it via a header.
    const querySignature = query?.signature;
    const signature =
      (Array.isArray(querySignature) ? querySignature[0] : querySignature) ||
      this.headerValue(headers, "signature");

    if (!signature || typeof signature !== "string") {
      return { valid: false, error: "Missing PandaDoc signature parameter" };
    }

    try {
      const body =
        typeof payload === "string" ? payload : JSON.stringify(payload);
      const expected = crypto
        .createHmac("sha256", secret)
        .update(body, "utf8")
        .digest("hex");

      const expectedBuf = Buffer.from(expected, "hex");
      const providedBuf = Buffer.from(signature, "hex");
      if (
        expectedBuf.length !== providedBuf.length ||
        !crypto.timingSafeEqual(expectedBuf, providedBuf)
      ) {
        return { valid: false, error: "Invalid signature" };
      }

      const parsed =
        typeof payload === "string" ? JSON.parse(payload) : payload;
      const items = this.toWebhookItems(parsed);
      const firstTrigger = items.find(item => item.event)?.event;

      // PandaDoc deliveries have no event id; derive a stable one from the body
      // so genuine re-deliveries dedupe on the (flowId, eventId) index.
      const deliveryId = crypto
        .createHash("sha1")
        .update(body, "utf8")
        .digest("hex");

      return {
        valid: true,
        event: {
          type: firstTrigger,
          id: deliveryId,
          events: items,
        },
      };
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : "Failed to verify webhook",
      };
    }
  }

  getWebhookEventMapping(eventType: string): WebhookEventMapping | null {
    if ((DOCUMENT_TRIGGERS as readonly string[]).includes(eventType)) {
      return {
        entity: "documents",
        operation: eventType === "document_deleted" ? "delete" : "upsert",
      };
    }
    if ((TEMPLATE_TRIGGERS as readonly string[]).includes(eventType)) {
      return {
        entity: "templates",
        operation: eventType === "template_deleted" ? "delete" : "upsert",
      };
    }
    return null;
  }

  getSupportedWebhookEvents(): string[] {
    return [...SUPPORTED_WEBHOOK_EVENTS];
  }

  getWebhookEventsForEntities(entities: string[]): string[] {
    if (entities.length === 0) return this.getSupportedWebhookEvents();
    const normalized = new Set(entities.map(e => e.toLowerCase()));
    const events: string[] = [];

    if (normalized.has("documents")) {
      events.push(...DOCUMENT_TRIGGERS);
    }
    if (normalized.has("templates")) {
      events.push(...TEMPLATE_TRIGGERS);
    }

    return events;
  }

  /**
   * Normalize a PandaDoc webhook body into an array of `{ event, data }` items.
   * Accepts the raw provider array, the wrapped shape produced by
   * verifyWebhook (`{ events: [...] }`), or a single item.
   */
  private toWebhookItems(event: unknown): PandaDocWebhookItem[] {
    if (Array.isArray(event)) {
      return event as PandaDocWebhookItem[];
    }
    if (event && typeof event === "object") {
      const wrapped = (event as { events?: unknown }).events;
      if (Array.isArray(wrapped)) {
        return wrapped as PandaDocWebhookItem[];
      }
      if ("data" in (event as Record<string, unknown>)) {
        return [event as PandaDocWebhookItem];
      }
    }
    return [];
  }

  extractWebhookData(
    event: unknown,
  ): { id: string; data: Record<string, unknown> } | null {
    const items = this.toWebhookItems(event);
    for (const item of items) {
      const data = item?.data;
      if (data && typeof data === "object") {
        const id = typeof data.id === "string" ? data.id : "";
        if (id) return { id, data };
      }
    }
    return null;
  }

  extractWebhookCdcRecords(
    event: unknown,
    eventType?: string,
  ): NormalizedCdcRecord[] {
    const items = this.toWebhookItems(event);
    const records: NormalizedCdcRecord[] = [];

    for (const item of items) {
      const trigger = item?.event || eventType;
      const data = item?.data;
      if (!trigger || !data || typeof data !== "object") continue;

      const mapping = this.getWebhookEventMapping(trigger);
      if (!mapping) continue;

      const recordId = typeof data.id === "string" ? data.id : "";
      if (!recordId) continue;

      const sourceTs = this.resolveRecordTimestamp(data);
      records.push({
        entity: mapping.entity,
        recordId,
        operation: mapping.operation,
        payload: data,
        sourceTs,
        source: "webhook",
        changeId: `${trigger}:${recordId}:${sourceTs.toISOString()}`,
      });
    }

    return records;
  }

  normalizeBackfillRecord(
    entity: string,
    record: Record<string, unknown>,
  ): NormalizedCdcRecord | null {
    const enriched = withId(entity, record);
    const recordId = String(enriched.id ?? "");
    if (!recordId) return null;

    return {
      entity,
      recordId,
      operation: "upsert",
      payload: enriched,
      sourceTs: this.resolveRecordTimestamp(enriched),
      source: "backfill",
    };
  }
}
