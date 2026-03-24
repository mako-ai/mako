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
} from "../base/BaseConnector";
import axios, { AxiosInstance } from "axios";
import * as crypto from "crypto";
import { loggers } from "../../logging";

const logger = loggers.connector("close");

// Close.com activity types
const CLOSE_ACTIVITY_TYPES = [
  { name: "Email", label: "Email", description: "Email communications" },
  {
    name: "EmailThread",
    label: "Email Thread",
    description: "Email thread activities",
  },
  { name: "Call", label: "Call", description: "Phone calls" },
  { name: "SMS", label: "SMS", description: "Text messages" },
  { name: "Meeting", label: "Meeting", description: "Scheduled meetings" },
  {
    name: "LeadStatusChange",
    label: "Lead Status Change",
    description: "Lead status updates",
  },
  {
    name: "OpportunityStatusChange",
    label: "Opportunity Status Change",
    description: "Opportunity status updates",
  },
  { name: "Note", label: "Note", description: "Manual notes" },
  {
    name: "TaskCompleted",
    label: "Task Completed",
    description: "Completed tasks",
  },
  {
    name: "CustomActivity",
    label: "Custom Activity",
    description: "Custom activity instances",
  },
];

type CloseWebhookSelector = {
  object_type: string;
  action: string;
};

// Close webhook selectors from official event list.
const CLOSE_SUPPORTED_WEBHOOK_SELECTORS: CloseWebhookSelector[] = [
  { object_type: "lead", action: "created" },
  { object_type: "lead", action: "updated" },
  { object_type: "lead", action: "deleted" },
  { object_type: "lead", action: "merged" },
  { object_type: "contact", action: "updated" },
  { object_type: "opportunity", action: "created" },
  { object_type: "opportunity", action: "updated" },
  { object_type: "opportunity", action: "deleted" },
  { object_type: "activity.call", action: "created" },
  { object_type: "activity.email", action: "created" },
  { object_type: "activity.email", action: "updated" },
  { object_type: "activity.email", action: "deleted" },
  { object_type: "activity.email", action: "sent" },
  { object_type: "activity.email_thread", action: "created" },
  { object_type: "activity.email_thread", action: "updated" },
  { object_type: "activity.email_thread", action: "deleted" },
  { object_type: "activity.sms", action: "created" },
  { object_type: "activity.sms", action: "updated" },
  { object_type: "activity.sms", action: "deleted" },
  { object_type: "activity.sms", action: "sent" },
  { object_type: "activity.note", action: "created" },
  { object_type: "activity.note", action: "updated" },
  { object_type: "activity.note", action: "deleted" },
  { object_type: "activity.meeting", action: "created" },
  { object_type: "activity.meeting", action: "updated" },
  { object_type: "activity.meeting", action: "deleted" },
  { object_type: "activity.meeting", action: "scheduled" },
  { object_type: "activity.meeting", action: "started" },
  { object_type: "activity.meeting", action: "completed" },
  { object_type: "activity.meeting", action: "canceled" },
  { object_type: "activity.lead_status_change", action: "created" },
  { object_type: "activity.lead_status_change", action: "updated" },
  { object_type: "activity.lead_status_change", action: "deleted" },
  { object_type: "activity.opportunity_status_change", action: "created" },
  { object_type: "activity.opportunity_status_change", action: "updated" },
  { object_type: "activity.opportunity_status_change", action: "deleted" },
  { object_type: "activity.task_completed", action: "created" },
  { object_type: "activity.task_completed", action: "deleted" },
  { object_type: "activity.custom_activity", action: "created" },
  { object_type: "activity.custom_activity", action: "updated" },
  { object_type: "activity.custom_activity", action: "deleted" },
  { object_type: "custom_fields.lead", action: "created" },
  { object_type: "custom_fields.lead", action: "updated" },
  { object_type: "custom_fields.lead", action: "deleted" },
  { object_type: "custom_fields.contact", action: "created" },
  { object_type: "custom_fields.contact", action: "updated" },
  { object_type: "custom_fields.contact", action: "deleted" },
  { object_type: "custom_fields.opportunity", action: "created" },
  { object_type: "custom_fields.opportunity", action: "updated" },
  { object_type: "custom_fields.opportunity", action: "deleted" },
  { object_type: "custom_fields.activity", action: "deleted" },
  { object_type: "custom_fields.custom_object", action: "deleted" },
  { object_type: "custom_fields.shared", action: "created" },
  { object_type: "custom_fields.shared", action: "updated" },
  { object_type: "custom_fields.shared", action: "deleted" },
  { object_type: "custom_activity_type", action: "updated" },
  { object_type: "custom_object_type", action: "updated" },
  { object_type: "custom_object", action: "created" },
  { object_type: "custom_object", action: "updated" },
  { object_type: "custom_object", action: "deleted" },
  { object_type: "status.lead", action: "created" },
  { object_type: "status.lead", action: "updated" },
  { object_type: "status.lead", action: "deleted" },
  { object_type: "status.opportunity", action: "created" },
  { object_type: "status.opportunity", action: "updated" },
  { object_type: "status.opportunity", action: "deleted" },
];

const CLOSE_SUPPORTED_WEBHOOK_SELECTOR_KEYS = new Set(
  CLOSE_SUPPORTED_WEBHOOK_SELECTORS.map(
    selector => `${selector.object_type}:${selector.action}`,
  ),
);

export class CloseConnector extends BaseConnector {
  private static readonly LEAD_BASE_FIELDS = [
    "id",
    "name",
    "display_name",
    "description",
    "date_created",
    "date_updated",
    "created_by",
    "created_by_name",
    "updated_by",
    "updated_by_name",
    "organization_id",
    "status_id",
    "status_label",
    "addresses",
    "url",
    "source",
    "contact_ids",
  ] as const;

  private static readonly LEAD_ALLOWED_NORMALIZED_FIELDS = new Set<string>(
    CloseConnector.LEAD_BASE_FIELDS,
  );

  private closeApi: AxiosInstance | null = null;
  private activeLogCallback?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    metadata?: any,
  ) => void;
  private activeEntity?: string;
  private activeSyncMode: "full" | "incremental" = "full";
  private requestSeq = 0;
  private cachedLeadFieldSelection?: string;

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
    level: "debug" | "info" | "warn" | "error",
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

  /**
   * Resolve Close API endpoint for a given activities sub-type.
   * Falls back to generic /activity/ if unknown.
   */
  private getActivityEndpointForType(subType?: string): string {
    if (!subType) return "/activity/";
    const map: Record<string, string> = {
      LeadStatusChange: "/activity/status_change/lead/",
      OpportunityStatusChange: "/activity/status_change/opportunity/",
      Call: "/activity/call/",
      Meeting: "/activity/meeting/",
      Email: "/activity/email/",
      EmailThread: "/activity/email_thread/",
      SMS: "/activity/sms/",
      Note: "/activity/note/",
      TaskCompleted: "/activity/task_completed/",
      CustomActivity: "/activity/custom/",
    };
    return map[subType] || "/activity/";
  }

  private async getLeadFieldSelection(): Promise<string> {
    if (this.cachedLeadFieldSelection) {
      return this.cachedLeadFieldSelection;
    }

    const fields = new Set<string>(CloseConnector.LEAD_BASE_FIELDS);
    const api = this.getCloseClient();
    const customFieldEndpoints = [
      "/custom_field/lead/",
      "/custom_field/shared/",
    ];

    for (const endpoint of customFieldEndpoints) {
      try {
        const response = await api.get(endpoint);
        const customFields = Array.isArray(response?.data?.data)
          ? response.data.data
          : [];
        for (const customField of customFields) {
          const customFieldId =
            typeof customField?.id === "string" ? customField.id.trim() : "";
          if (!customFieldId) continue;
          fields.add(`custom.${customFieldId}`);
        }
      } catch (error) {
        logger.warn("Could not fetch custom field selectors for lead query", {
          endpoint,
          error,
        });
      }
    }

    this.cachedLeadFieldSelection = Array.from(fields).join(",");
    return this.cachedLeadFieldSelection;
  }

  private extractLeadContactIds(record: Record<string, unknown>): string[] {
    const ids = new Set<string>();
    const addId = (candidate: unknown) => {
      if (typeof candidate !== "string") return;
      const trimmed = candidate.trim();
      if (trimmed.length > 0) ids.add(trimmed);
    };
    const addFromValue = (value: unknown) => {
      if (!value) return;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") {
            addId(item);
          } else if (item && typeof item === "object") {
            addId((item as Record<string, unknown>).id);
          }
        }
        return;
      }
      if (typeof value === "string") {
        try {
          const parsed = JSON.parse(value);
          addFromValue(parsed);
        } catch {
          // Keep raw string values if they look like scalar ids.
          addId(value);
        }
      }
    };

    addFromValue(record.contact_ids);
    if (ids.size === 0) {
      addFromValue(record.contacts);
    }

    return Array.from(ids);
  }

  private normalizeLeadRecord(
    record: Record<string, unknown>,
  ): Record<string, unknown> {
    const normalized: Record<string, unknown> = {};
    for (const [rawKey, value] of Object.entries(record || {})) {
      const key = rawKey.replace(/\./g, "_");
      if (
        CloseConnector.LEAD_ALLOWED_NORMALIZED_FIELDS.has(key) ||
        key.startsWith("custom_cf_")
      ) {
        normalized[key] = value;
      }
    }

    const contactIds = this.extractLeadContactIds(record);
    if (contactIds.length > 0) {
      normalized.contact_ids = contactIds;
    }

    return normalized;
  }

  private normalizeLeadBatch(records: any[]): any[] {
    return records.map(record =>
      this.normalizeLeadRecord((record || {}) as Record<string, unknown>),
    );
  }

  private async requestLeadsPage(options: {
    limit: number;
    offset: number;
    since?: Date;
    orderBy: string;
  }): Promise<any> {
    const api = this.getCloseClient();
    const fields = await this.getLeadFieldSelection();
    const params: Record<string, unknown> = {
      _limit: options.limit,
      _skip: options.offset,
      _order_by: options.orderBy,
      _fields: fields,
    };

    if (options.since) {
      const dateFilter = options.since.toISOString().split("T")[0];
      params.query = `date_updated>="${dateFilter}"`;
    }

    return api.post(
      "/lead/",
      { _params: params },
      {
        headers: {
          "x-http-method-override": "GET",
        },
      },
    );
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
        {
          name: "api_base_url",
          label: "API Base URL",
          type: "string",
          required: false,
          default: "https://api.close.com/api/v1",
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

    if (!this.dataSource.config.api_key) {
      errors.push("Close API key is required");
    }

    return { valid: errors.length === 0, errors };
  }

  private getCloseClient(): AxiosInstance {
    if (!this.closeApi) {
      if (!this.dataSource.config.api_key) {
        throw new Error("Close API key not configured");
      }

      this.closeApi = axios.create({
        baseURL: "https://api.close.com/api/v1",
        auth: {
          username: this.dataSource.config.api_key,
          password: "",
        },
        headers: {
          "Content-Type": "application/json",
        },
      });

      this.closeApi.interceptors.request.use(config => {
        const requestId = `close_req_${Date.now()}_${++this.requestSeq}`;
        (config as any).__makoMeta = {
          requestId,
          startedAt: Date.now(),
        };
        this.emitSyncLog("info", "Close API request sent", {
          requestId,
          method: (config.method || "get").toUpperCase(),
          endpoint: config.url || "",
        });
        return config;
      });

      this.closeApi.interceptors.response.use(
        response => {
          const meta = (response.config as any).__makoMeta;
          this.emitSyncLog("info", "Close API response received", {
            requestId: meta?.requestId,
            method: (response.config.method || "get").toUpperCase(),
            endpoint: response.config.url || "",
            status: response.status,
            durationMs: meta?.startedAt
              ? Date.now() - Number(meta.startedAt)
              : undefined,
          });
          return response;
        },
        error => {
          const config = error?.config || {};
          const meta = (config as any).__makoMeta;
          this.emitSyncLog("warn", "Close API request failed", {
            requestId: meta?.requestId,
            method: (config.method || "get").toUpperCase(),
            endpoint: config.url || "",
            status: error?.response?.status,
            durationMs: meta?.startedAt
              ? Date.now() - Number(meta.startedAt)
              : undefined,
            error: axios.isAxiosError(error) ? error.message : String(error),
          });
          return Promise.reject(error);
        },
      );
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
    const baseEntities = [
      "leads",
      "opportunities",
      "activities",
      "contacts",
      "users",
      "custom_fields",
      "custom_activity_types",
      "custom_object_types",
      "custom_objects",
      "lead_statuses",
      "opportunity_statuses",
    ];

    const activitySubEntities = CLOSE_ACTIVITY_TYPES.map(
      type => `activities:${type.name}`,
    );

    return [...baseEntities, ...activitySubEntities];
  }

  /**
   * Get entity metadata with sub-entities for activities
   */
  getEntityMetadata(): EntityMetadata[] {
    const defaultLayout = {
      partitionField: "date_created",
      partitionGranularity: "day" as const,
      clusterFields: ["_dataSourceId", "id"],
    };
    return [
      { name: "leads", label: "Leads", layoutSuggestion: defaultLayout },
      {
        name: "opportunities",
        label: "Opportunities",
        layoutSuggestion: defaultLayout,
      },
      {
        name: "activities",
        label: "Activities",
        description: "All activity types from Close.com",
        layoutSuggestion: {
          partitionField: "date_created",
          partitionGranularity: "day",
          clusterFields: ["_dataSourceId", "id"],
        },
        subEntities: CLOSE_ACTIVITY_TYPES.map(type => ({
          name: type.name,
          label: type.label,
          description: type.description,
        })),
      },
      { name: "contacts", label: "Contacts", layoutSuggestion: defaultLayout },
      { name: "users", label: "Users", layoutSuggestion: defaultLayout },
      {
        name: "custom_fields",
        label: "Custom Fields",
        layoutSuggestion: defaultLayout,
      },
    ];
  }

  /**
   * Check if connector supports resumable fetching
   */
  supportsResumableFetching(): boolean {
    return true;
  }

  /**
   * Fetch a chunk of data with resumable state
   */
  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    this.setLogContext(options);
    const { entity, onBatch, onProgress, since, state } = options;
    const maxIterations = options.maxIterations || 10;

    // Special handling for custom_fields and users (non-paginated)
    if (entity === "custom_fields") {
      if (!state || state.totalProcessed === 0) {
        await this.fetchAllCustomFields(options);
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
      return await this.fetchUsersChunk(options);
    }

    if (entity in CloseConnector.SIMPLE_ENTITY_ENDPOINTS) {
      return await this.fetchSimpleEntityChunk(entity, options);
    }

    // Custom objects require lead_id — backfill not supported, webhook-only
    if (entity === "custom_objects") {
      logger.warn(
        "Skipping custom_objects: backfill requires lead_id, use webhooks instead",
      );
      return { totalProcessed: 0, hasMore: false, iterationsInChunk: 0 };
    }

    // Handle activities and activity sub-entities (e.g., "activities:Call")
    if (entity === "activities" || entity.startsWith("activities:")) {
      return await this.fetchActivitiesChunk(options);
    }

    const api = this.getCloseClient();
    const batchSize = options.batchSize || this.getBatchSize();
    const rateLimitDelay = options.rateLimitDelay || this.getRateLimitDelay();

    // Initialize or restore state
    let offset = state?.offset || 0;
    let recordCount = state?.totalProcessed || 0;
    let hasMore = true;
    let iterations = 0;

    // Get total count if this is the first chunk
    let totalCount: number | undefined = state?.metadata?.totalCount;
    if (!state && onProgress) {
      totalCount = await this.fetchTotalCount(entity, since);
      if (totalCount !== undefined) {
        onProgress(0, totalCount);
      }
    }

    while (hasMore && iterations < maxIterations) {
      let response: any;
      const params: any = {
        _limit: batchSize,
        _skip: offset,
        _order_by: "id", // Add consistent ordering for pagination stability
      };

      try {
        if (entity === "leads") {
          response = await this.requestLeadsPage({
            limit: batchSize,
            offset,
            since,
            orderBy: since ? "-date_updated" : "id",
          });
        } else {
          let endpoint: string;
          switch (entity) {
            case "opportunities":
              endpoint = "/opportunity/";
              break;
            case "activities":
              endpoint = "/activity/";
              break;
            case "contacts":
              endpoint = "/contact/";
              break;
            default:
              throw new Error(`Unsupported entity: ${entity}`);
          }

          // For incremental sync, use POST with query in body
          if (since) {
            const dateFilter = since.toISOString().split("T")[0];
            const postData = {
              _params: {
                _limit: batchSize,
                _skip: offset,
                _order_by: "-date_updated",
                query: `date_updated>="${dateFilter}"`,
              },
            };

            response = await api.post(endpoint, postData, {
              headers: {
                "x-http-method-override": "GET",
              },
            });
          } else {
            response = await api.get(endpoint, { params });
          }
        }

        const rawData = response.data.data || [];
        const data =
          entity === "leads" ? this.normalizeLeadBatch(rawData) : rawData;

        if (data.length > 0) {
          await onBatch(data);
          recordCount += data.length;

          if (onProgress) {
            onProgress(recordCount, totalCount);
          }
        }

        hasMore = response.data.has_more || false;

        if (hasMore) {
          offset += batchSize;
          iterations++;

          // Rate limiting
          await this.sleep(rateLimitDelay);
        } else {
          // No more data
          break;
        }
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          const retryAfter = parseInt(
            error.response.headers["retry-after"] || "60",
          );
          logger.warn("Rate limited, waiting", {
            retryAfterSeconds: retryAfter,
          });
          await this.sleep(retryAfter * 1000);
          // Don't increment iterations for rate limit retries
        } else {
          throw error;
        }
      }
    }

    return {
      offset,
      totalProcessed: recordCount,
      hasMore,
      iterationsInChunk: iterations,
      metadata: { totalCount },
    };
  }

  private async fetchUsersChunk(
    options: ResumableFetchOptions,
  ): Promise<FetchState> {
    const { onBatch, onProgress, state } = options;
    const api = this.getCloseClient();
    const batchSize = options.batchSize || this.getBatchSize();
    const rateLimitDelay = options.rateLimitDelay || this.getRateLimitDelay();
    const maxIterations = options.maxIterations || 10;

    let offset = state?.offset || 0;
    let recordCount = state?.totalProcessed || 0;
    let hasMore = true;
    let iterations = 0;

    let totalCount: number | undefined = state?.metadata?.totalCount;
    if (!state && onProgress) {
      try {
        const countResponse = await api.get("/user/", {
          params: { _limit: 0 },
        });
        totalCount = countResponse.data.total_results;
        onProgress(0, totalCount);
      } catch (error) {
        logger.warn("Could not fetch total count for users", { error });
      }
    }

    while (hasMore && iterations < maxIterations) {
      try {
        const params = {
          _limit: batchSize,
          _skip: offset,
          // Note: /user/ endpoint doesn't support _order_by parameter
        };

        const response = await api.get("/user/", { params });
        const data = response.data.data || [];

        if (data.length > 0) {
          await onBatch(data);
          recordCount += data.length;

          if (onProgress) {
            onProgress(recordCount, totalCount);
          }
        }

        hasMore = response.data.has_more || false;

        if (hasMore) {
          offset += batchSize;
          iterations++;
          await this.sleep(rateLimitDelay);
        }
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          const retryAfter = parseInt(
            error.response.headers["retry-after"] || "60",
          );
          logger.warn("Rate limited, waiting", {
            retryAfterSeconds: retryAfter,
          });
          await this.sleep(retryAfter * 1000);
        } else {
          throw error;
        }
      }
    }

    return {
      offset,
      totalProcessed: recordCount,
      hasMore,
      iterationsInChunk: iterations,
      metadata: { totalCount },
    };
  }

  private async fetchActivitiesChunk(
    options: ResumableFetchOptions,
  ): Promise<FetchState> {
    const { entity, onBatch, onProgress, since, state } = options;
    const api = this.getCloseClient();
    const batchSize = options.batchSize || this.getBatchSize();
    const rateLimitDelay = options.rateLimitDelay || this.getRateLimitDelay();
    const maxIterations = options.maxIterations || 10;

    let activitySubType: string | undefined;
    if (entity.includes(":")) {
      const [, activityType] = entity.split(":");
      activitySubType = activityType;
    }

    let recordCount = state?.totalProcessed || 0;
    let iterations = 0;

    // Cursor-based pagination ascending by date_created.
    // Uses gte so ties are included — MERGE deduplicates on import.
    let cursor: string | null = state?.metadata?.cursor ?? null;
    const endDate =
      since ||
      (state?.metadata?.endDate ? new Date(state.metadata.endDate) : null);

    if (!state && onProgress) {
      onProgress(0, undefined);
    }

    while (iterations < maxIterations) {
      try {
        const queryParts: string[] = [];
        if (cursor) {
          queryParts.push(`date_created__gt="${cursor}"`);
        }
        if (endDate) {
          queryParts.push(`date_created__lte="${endDate.toISOString()}"`);
        }

        const params: any = {
          _limit: batchSize,
          _order_by: "date_created",
        };
        if (queryParts.length > 0) {
          params.query = queryParts.join(" AND ");
        }

        const response = await api.post(
          this.getActivityEndpointForType(activitySubType),
          { _params: params },
          { headers: { "x-http-method-override": "GET" } },
        );

        const data = response.data.data || [];

        if (data.length > 0) {
          await onBatch(data);
          recordCount += data.length;
          cursor = data[data.length - 1].date_created;
          if (onProgress) {
            onProgress(recordCount, undefined);
          }
        }

        if (!response.data.has_more || data.length === 0) {
          return {
            totalProcessed: recordCount,
            hasMore: false,
            iterationsInChunk: iterations + 1,
            metadata: { cursor, endDate: endDate?.toISOString() },
          };
        }

        iterations++;
        await this.sleep(rateLimitDelay);
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          const retryAfter = parseInt(
            error.response.headers["retry-after"] || "60",
          );
          logger.warn("Rate limited, waiting", {
            retryAfterSeconds: retryAfter,
          });
          await this.sleep(retryAfter * 1000);
        } else {
          throw error;
        }
      }
    }

    return {
      totalProcessed: recordCount,
      hasMore: true,
      iterationsInChunk: iterations,
      metadata: { cursor, endDate: endDate?.toISOString() },
    };
  }

  async fetchEntity(options: FetchOptions): Promise<void> {
    this.setLogContext(options);
    const { entity, onBatch, onProgress, since } = options;

    // Special handling for custom_fields
    if (entity === "custom_fields") {
      await this.fetchAllCustomFields(options);
      return;
    }

    // Special handling for users - always do full sync
    if (entity === "users") {
      await this.fetchAllUsers(options);
      return;
    }

    // Simple entities (statuses, types) — fetch all via pagination
    if (entity in CloseConnector.SIMPLE_ENTITY_ENDPOINTS) {
      await this.fetchSimpleEntityChunk(entity, options as any);
      return;
    }

    // Special handling for activities (and sub-types) - use date-based pagination and type-specific endpoints
    if (entity === "activities" || entity.startsWith("activities:")) {
      await this.fetchAllActivities(options);
      return;
    }

    const api = this.getCloseClient();
    const batchSize = options.batchSize || this.getBatchSize();
    const rateLimitDelay = options.rateLimitDelay || this.getRateLimitDelay();

    let hasMore = true;
    let offset = 0;
    let recordCount = 0;
    let totalCount: number | undefined;

    // Try to get total count first for better progress reporting
    if (onProgress) {
      totalCount = await this.fetchTotalCount(entity, since);
      if (totalCount !== undefined) {
        onProgress(0, totalCount);
      }
    }

    while (hasMore) {
      let response: any;
      const params: any = {
        _limit: batchSize,
        _skip: offset,
        _order_by: "id", // Add consistent ordering for pagination stability
      };

      // Fetch data based on entity type
      try {
        if (entity === "leads") {
          response = await this.requestLeadsPage({
            limit: batchSize,
            offset,
            since,
            orderBy: since ? "-date_updated" : "id",
          });
        } else {
          let endpoint: string;
          switch (entity) {
            case "opportunities":
              endpoint = "/opportunity/";
              break;
            case "activities":
              endpoint = "/activity/";
              break;
            case "contacts":
              endpoint = "/contact/";
              break;
            case "users":
              endpoint = "/user/";
              break;
            default:
              throw new Error(`Unsupported entity: ${entity}`);
          }

          // For incremental sync, use POST with query in body (Close API requirement)
          if (since) {
            const dateFilter = since.toISOString().split("T")[0]; // Format as YYYY-MM-DD
            const postData = {
              _params: {
                _limit: batchSize,
                _skip: offset,
                _order_by: "-date_updated",
                query: `date_updated>="${dateFilter}"`,
              },
            };

            response = await api.post(endpoint, postData, {
              headers: {
                "x-http-method-override": "GET",
              },
            });
          } else {
            // Regular GET request for full sync
            response = await api.get(endpoint, { params });
          }
        }

        const rawData = response.data.data || [];
        const data =
          entity === "leads" ? this.normalizeLeadBatch(rawData) : rawData;

        // Pass batch to callback
        if (data.length > 0) {
          await onBatch(data);
          recordCount += data.length;

          if (onProgress) {
            onProgress(recordCount, totalCount);
          }
        }

        // Check for more pages
        hasMore = response.data.has_more || false;

        if (hasMore) {
          offset += batchSize;

          // Rate limiting
          await this.sleep(rateLimitDelay);
        }
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          // Handle rate limiting
          const retryAfter = parseInt(
            error.response.headers["retry-after"] || "60",
          );
          logger.warn("Rate limited, waiting", {
            retryAfterSeconds: retryAfter,
          });
          await this.sleep(retryAfter * 1000);
          // Don't increment offset, retry the same page
        } else {
          throw error;
        }
      }
    }
  }

  private async fetchAllCustomFields(options: FetchOptions): Promise<void> {
    const { onBatch, onProgress } = options;
    const api = this.getCloseClient();

    // Custom field endpoints to fetch from
    const customFieldEndpoints = [
      { endpoint: "/custom_field/lead/", type: "lead" },
      { endpoint: "/custom_field/contact/", type: "contact" },
      { endpoint: "/custom_field/opportunity/", type: "opportunity" },
      { endpoint: "/custom_field/shared/", type: "shared" },
    ];

    let totalFields = 0;
    let processedFields = 0;

    // First, get total count
    if (onProgress) {
      for (const { endpoint } of customFieldEndpoints) {
        try {
          const response = await api.get(endpoint, { params: { _limit: 0 } });
          totalFields += response.data.total_results || 0;
        } catch (error) {
          // Skip if endpoint doesn't exist or errors
          logger.warn("Could not fetch count from endpoint", {
            endpoint,
            error,
          });
        }
      }
      onProgress(0, totalFields);
    }

    // Fetch from each custom field endpoint
    for (const { endpoint, type } of customFieldEndpoints) {
      try {
        const response = await api.get(endpoint);
        const fields = response.data.data || [];

        // Add type information to each field
        const fieldsWithType = fields.map((field: any) => ({
          ...field,
          custom_field_type: type,
        }));

        if (fieldsWithType.length > 0) {
          await onBatch(fieldsWithType);
          processedFields += fieldsWithType.length;

          if (onProgress) {
            onProgress(processedFields, totalFields);
          }
        }
      } catch (error) {
        // Log but continue with other endpoints
        logger.warn("Error fetching from endpoint", { endpoint, error });
      }
    }
  }

  private async fetchAllUsers(options: FetchOptions): Promise<void> {
    const { onBatch, onProgress } = options;
    const api = this.getCloseClient();
    const batchSize = options.batchSize || this.getBatchSize();
    const rateLimitDelay = options.rateLimitDelay || this.getRateLimitDelay();

    let hasMore = true;
    let offset = 0;
    let recordCount = 0;
    let totalCount: number | undefined;

    // Try to get total count first for better progress reporting
    if (onProgress) {
      try {
        const countResponse = await api.get("/user/", {
          params: { _limit: 0 },
        });
        totalCount = countResponse.data.total_results;
        onProgress(0, totalCount);
      } catch (error) {
        logger.warn("Could not fetch total count for users", { error });
      }
    }

    while (hasMore) {
      try {
        const params = {
          _limit: batchSize,
          _skip: offset,
          // Note: /user/ endpoint doesn't support _order_by parameter
        };

        const response = await api.get("/user/", { params });
        const data = response.data.data || [];

        // Pass batch to callback
        if (data.length > 0) {
          await onBatch(data);
          recordCount += data.length;

          if (onProgress) {
            onProgress(recordCount, totalCount);
          }
        }

        // Check for more pages
        hasMore = response.data.has_more || false;

        if (hasMore) {
          offset += batchSize;

          // Rate limiting
          await this.sleep(rateLimitDelay);
        }
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          // Handle rate limiting
          const retryAfter = parseInt(
            error.response.headers["retry-after"] || "60",
          );
          logger.warn("Rate limited, waiting", {
            retryAfterSeconds: retryAfter,
          });
          await this.sleep(retryAfter * 1000);
          // Don't increment offset, retry the same page
        } else {
          throw error;
        }
      }
    }
  }

  private async fetchAllActivities(options: FetchOptions): Promise<void> {
    const { entity, onBatch, onProgress, since } = options;
    const api = this.getCloseClient();
    const batchSize = options.batchSize || this.getBatchSize();
    const rateLimitDelay = options.rateLimitDelay || this.getRateLimitDelay();

    // Parse sub-entity for endpoint selection (e.g., "activities:Call")
    let activitySubType: string | undefined;
    if (entity.includes(":")) {
      const [, activityType] = entity.split(":");
      activitySubType = activityType;
    }

    let recordCount = 0;
    const now = new Date();
    let currentDate = new Date(now);
    const endDate = since;
    let isCheckingForOlderData = false;
    let shouldContinue = true;

    if (onProgress) {
      // We can't accurately predict total count with date-based pagination
      onProgress(0, undefined);
    }

    while (shouldContinue) {
      let hasMoreInCurrentQuery = true;
      let dailyOffset = 0;

      while (hasMoreInCurrentQuery) {
        try {
          const params: any = {
            _limit: isCheckingForOlderData ? 1 : batchSize, // Only check if older data exists, don't fetch it all
            _skip: dailyOffset,
            _order_by: "-date_created",
          };

          // Build the query based on current state
          let query = "";
          if (isCheckingForOlderData) {
            // Final check: only filter by date_created__lt to see if any older data exists
            // Query for data BEFORE the current day (not including it, to avoid re-fetching)
            query = `date_created__lt="${currentDate.toISOString().split("T")[0]}"`;
          } else {
            // Normal date range for a specific day
            const nextDay = new Date(currentDate);
            nextDay.setDate(nextDay.getDate() + 1);
            query = `date_created__gte="${currentDate.toISOString().split("T")[0]}" AND date_created__lt="${nextDay.toISOString().split("T")[0]}"`;
          }

          // No need to add _type filter - hitting type-specific endpoint

          const postData = {
            _params: {
              ...params,
              query,
            },
          };

          const response = await api.post(
            this.getActivityEndpointForType(activitySubType),
            postData,
            {
              headers: {
                "x-http-method-override": "GET",
              },
            },
          );

          const data = response.data.data || [];

          // Only process and count data if we're not just checking for existence
          if (data.length > 0 && !isCheckingForOlderData) {
            await onBatch(data);
            recordCount += data.length;

            if (onProgress) {
              onProgress(recordCount, undefined);
            }
          }

          hasMoreInCurrentQuery = response.data.has_more || false;

          if (isCheckingForOlderData) {
            // Probe mode issues a single request; avoid paginating older windows.
            if (data.length === 0) {
              // No older data exists - we're done
              shouldContinue = false;
              break;
            } else {
              // Older data exists - jump directly to that date and continue normal fetching
              const oldestRecord = data[0];
              const dateCreated = new Date(oldestRecord.date_created);
              currentDate = new Date(
                dateCreated.getFullYear(),
                dateCreated.getMonth(),
                dateCreated.getDate(),
              );
              dailyOffset = 0;
              isCheckingForOlderData = false;
              await this.sleep(rateLimitDelay);
              break; // Break inner loop to continue with next day
            }
          } else if (hasMoreInCurrentQuery) {
            dailyOffset += batchSize;
            await this.sleep(rateLimitDelay);
          } else {
            // Finished current day
            if (data.length < batchSize && !since) {
              // Found a day with less than a full page in full sync - need to check if older data exists
              isCheckingForOlderData = true;
              await this.sleep(rateLimitDelay);
            } else {
              // Move on to the next iteration (previous day)
              break;
            }
          }
        } catch (error) {
          if (axios.isAxiosError(error) && error.response?.status === 429) {
            const retryAfter = parseInt(
              error.response.headers["retry-after"] || "60",
            );
            logger.warn("Rate limited, waiting", {
              retryAfterSeconds: retryAfter,
            });
            await this.sleep(retryAfter * 1000);
          } else {
            throw error;
          }
        }
      }

      if (!isCheckingForOlderData) {
        // Move to previous day
        currentDate = new Date(currentDate);
        currentDate.setDate(currentDate.getDate() - 1);

        // Check if we've reached the end date (for incremental sync)
        if (endDate && currentDate < endDate) {
          shouldContinue = false;
        }

        await this.sleep(rateLimitDelay);
      }
    }
  }

  private static readonly SIMPLE_ENTITY_ENDPOINTS: Record<string, string> = {
    lead_statuses: "/status/lead/",
    opportunity_statuses: "/status/opportunity/",
    custom_activity_types: "/custom_activity/",
    custom_object_types: "/custom_object_type/",
  };

  private async fetchSimpleEntityChunk(
    entity: string,
    options: ResumableFetchOptions,
  ): Promise<FetchState> {
    const { onBatch, onProgress, state } = options;

    if (state && !state.hasMore) {
      return {
        totalProcessed: state.totalProcessed,
        hasMore: false,
        iterationsInChunk: 0,
      };
    }

    const api = this.getCloseClient();
    const endpoint = CloseConnector.SIMPLE_ENTITY_ENDPOINTS[entity];
    if (!endpoint) throw new Error(`No endpoint for entity: ${entity}`);

    const batchSize = options.batchSize || this.getBatchSize();
    const rateLimitDelay = options.rateLimitDelay || this.getRateLimitDelay();
    const maxIterations = options.maxIterations || 10;

    let offset = state?.offset || 0;
    let recordCount = state?.totalProcessed || 0;
    let hasMore = true;
    let iterations = 0;

    while (hasMore && iterations < maxIterations) {
      try {
        const response = await api.get(endpoint, {
          params: { _limit: batchSize, _skip: offset },
        });
        const data = response.data.data || [];

        if (data.length > 0) {
          await onBatch(data);
          recordCount += data.length;
          if (onProgress) onProgress(recordCount, undefined);
        }

        hasMore = response.data.has_more || false;
        if (hasMore) {
          offset += batchSize;
          iterations++;
          await this.sleep(rateLimitDelay);
        }
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          const retryAfter = parseInt(
            error.response.headers["retry-after"] || "60",
          );
          logger.warn("Rate limited, waiting", {
            retryAfterSeconds: retryAfter,
          });
          await this.sleep(retryAfter * 1000);
        } else {
          throw error;
        }
      }
    }

    return {
      offset,
      totalProcessed: recordCount,
      hasMore,
      iterationsInChunk: iterations,
    };
  }

  private async fetchTotalCount(
    entity: string,
    since?: Date,
  ): Promise<number | undefined> {
    try {
      const api = this.getCloseClient();

      // Special handling for custom_fields
      if (entity === "custom_fields") {
        const customFieldEndpoints = [
          "/custom_field/lead/",
          "/custom_field/contact/",
          "/custom_field/opportunity/",
          "/custom_field/shared/",
        ];

        let totalCount = 0;
        for (const endpoint of customFieldEndpoints) {
          try {
            const response = await api.get(endpoint, { params: { _limit: 0 } });
            totalCount += response.data.total_results || 0;
          } catch (error) {
            // Skip if endpoint doesn't exist
            logger.warn("Could not fetch count from endpoint", {
              endpoint,
              error,
            });
          }
        }
        return totalCount > 0 ? totalCount : undefined;
      }

      let endpoint: string;
      switch (entity) {
        case "leads":
          endpoint = "/lead/";
          break;
        case "opportunities":
          endpoint = "/opportunity/";
          break;
        case "activities":
          endpoint = "/activity/";
          break;
        case "contacts":
          endpoint = "/contact/";
          break;
        case "users":
          endpoint = "/user/";
          break;
        default:
          return undefined;
      }

      let response: any;

      // For incremental sync with date filter, use POST request
      if (since) {
        const dateFilter = since.toISOString().split("T")[0]; // Format as YYYY-MM-DD
        const postData = {
          _params: {
            _limit: 0,
            _fields: "id",
            query: `date_updated>="${dateFilter}"`,
          },
        };

        response = await api.post(endpoint, postData, {
          headers: {
            "x-http-method-override": "GET",
          },
        });
      } else {
        // Regular GET request for full sync
        const params = {
          _limit: 0,
          _fields: "id",
        };
        response = await api.get(endpoint, { params });
      }

      // Close API returns total_results in the response
      return response.data.total_results || undefined;
    } catch (error) {
      logger.warn("Could not fetch total count for entity", { entity, error });
      return undefined;
    }
  }

  /**
   * Check if connector supports webhooks
   */
  supportsWebhooks(): boolean {
    return true;
  }

  supportsWebhookProvisioning(): boolean {
    return true;
  }

  async createWebhookSubscription(
    options: ProvisionWebhookOptions,
  ): Promise<ProvisionWebhookResult> {
    const api = this.getCloseClient();
    const parseEventSelector = (
      eventType: string,
    ): CloseWebhookSelector | null => {
      const value = eventType.trim();
      if (!value) return null;
      const separator = value.lastIndexOf(".");
      if (separator <= 0 || separator >= value.length - 1) return null;

      const objectType = value.slice(0, separator).trim();
      const action = value.slice(separator + 1).trim();
      if (!objectType || !action) return null;

      return { object_type: objectType, action };
    };

    const normalizeEventSelectors = (eventTypes: string[]) => {
      const unique = new Map<string, CloseWebhookSelector>();
      const unsupported: string[] = [];
      for (const eventType of eventTypes) {
        const parsed = parseEventSelector(eventType);
        if (!parsed) {
          unsupported.push(eventType);
          continue;
        }

        const key = `${parsed.object_type}:${parsed.action}`;
        if (!CLOSE_SUPPORTED_WEBHOOK_SELECTOR_KEYS.has(key)) {
          unsupported.push(eventType);
          continue;
        }

        unique.set(key, parsed);
      }
      return { selectors: Array.from(unique.values()), unsupported };
    };

    const requestedEvents = Array.isArray(options.events)
      ? options.events
          .map(event => event.trim())
          .filter((event): event is string => event.length > 0)
      : [];
    const normalized = normalizeEventSelectors(
      requestedEvents.length > 0
        ? requestedEvents
        : this.getSupportedWebhookEvents(),
    );
    if (requestedEvents.length > 0 && normalized.unsupported.length > 0) {
      logger.warn("Ignoring unsupported Close webhook events", {
        unsupportedEvents: normalized.unsupported,
      });
    }

    if (normalized.selectors.length === 0) {
      throw new Error(
        requestedEvents.length > 0
          ? `No valid Close webhook events configured. Unsupported events: ${normalized.unsupported.join(", ")}`
          : "No valid Close webhook events configured",
      );
    }

    const payload: Record<string, unknown> = {
      url: options.endpointUrl,
      verify_ssl: options.verifySsl !== false,
      events: normalized.selectors,
    };

    try {
      // Avoid creating duplicates when the flow already has a provider webhook.
      const existingResponse = await api.get("/webhook/");
      const existingList = Array.isArray(existingResponse?.data)
        ? existingResponse.data
        : Array.isArray(existingResponse?.data?.data)
          ? existingResponse.data.data
          : [];
      const existing = existingList.find((item: any) => {
        const candidateUrl =
          typeof item?.url === "string"
            ? item.url
            : typeof item?.endpoint === "string"
              ? item.endpoint
              : "";
        return candidateUrl === options.endpointUrl;
      });
      if (existing) {
        const existingId =
          existing.id ||
          existing._id ||
          existing.subscription_id ||
          existing.webhook_id;
        if (existingId) {
          return {
            providerWebhookId: String(existingId),
            endpointUrl: options.endpointUrl,
          };
        }
      }

      const response = await api.post("/webhook/", payload);
      const data = response?.data || {};
      const providerWebhookId =
        data.id || data._id || data.subscription_id || data.webhook_id;
      if (!providerWebhookId) {
        throw new Error(
          "Close webhook created but no subscription id returned by API",
        );
      }

      const signingSecret =
        data.signature_key || data.signing_secret || data.secret;

      return {
        providerWebhookId: String(providerWebhookId),
        endpointUrl: options.endpointUrl,
        signingSecret:
          typeof signingSecret === "string" && signingSecret.length > 0
            ? signingSecret
            : undefined,
      };
    } catch (error) {
      const message = (() => {
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const data = error.response?.data;

          const directError =
            typeof data?.error === "string"
              ? data.error
              : typeof data?.message === "string"
                ? data.message
                : typeof data === "string"
                  ? data
                  : undefined;

          const serialized =
            !directError && data && typeof data === "object"
              ? JSON.stringify(data)
              : undefined;

          const detail = directError || serialized || error.message;
          return status ? `HTTP ${status}: ${detail}` : detail;
        }

        return error instanceof Error ? error.message : String(error);
      })();
      throw new Error(
        `Failed to create Close webhook subscription: ${message}`,
      );
    }
  }

  /**
   * Verify webhook signature and parse event
   */
  async verifyWebhook(
    options: WebhookHandlerOptions,
  ): Promise<WebhookVerificationResult> {
    const { payload, headers, secret } = options;

    const sigHash = headers["close-sig-hash"];
    const sigTimestamp = headers["close-sig-timestamp"];

    if (!sigHash || typeof sigHash !== "string") {
      return { valid: false, error: "Missing close-sig-hash header" };
    }

    if (!sigTimestamp || typeof sigTimestamp !== "string") {
      return { valid: false, error: "Missing close-sig-timestamp header" };
    }

    if (!secret) {
      return { valid: false, error: "Missing webhook secret" };
    }

    try {
      const body =
        typeof payload === "string" ? payload : JSON.stringify(payload);
      // Close: HMAC-SHA256(hex_decoded_key, timestamp + body) — no separator
      const data = sigTimestamp + body;
      const keyBytes = Buffer.from(secret, "hex");
      const expectedSignature = crypto
        .createHmac("sha256", keyBytes)
        .update(data, "utf-8")
        .digest("hex");

      if (
        !crypto.timingSafeEqual(
          Buffer.from(sigHash),
          Buffer.from(expectedSignature),
        )
      ) {
        return { valid: false, error: "Invalid signature" };
      }

      const event = typeof payload === "string" ? JSON.parse(payload) : payload;
      return { valid: true, event };
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : "Failed to verify webhook",
      };
    }
  }

  /**
   * Get webhook event mapping
   */
  getWebhookEventMapping(eventType: string): WebhookEventMapping | null {
    const mappings: Record<string, WebhookEventMapping> = {
      // Leads
      "lead.created": { entity: "leads", operation: "upsert" },
      "lead.updated": { entity: "leads", operation: "upsert" },
      "lead.deleted": { entity: "leads", operation: "delete" },
      "lead.merged": { entity: "leads", operation: "upsert" },

      // Contacts
      "contact.updated": { entity: "contacts", operation: "upsert" },

      // Opportunities
      "opportunity.created": { entity: "opportunities", operation: "upsert" },
      "opportunity.updated": { entity: "opportunities", operation: "upsert" },
      "opportunity.deleted": { entity: "opportunities", operation: "delete" },
    };

    if (mappings[eventType]) return mappings[eventType];

    // Activity sub-type events: "activity.note.created" → entity "activities:Note"
    const activityMatch = eventType.match(
      /^activity\.(\w+)\.(created|updated|sent|deleted|completed|scheduled|started|canceled)$/,
    );
    if (activityMatch) {
      const subTypeMap: Record<string, string> = {
        call: "Call",
        email: "Email",
        email_thread: "EmailThread",
        sms: "SMS",
        note: "Note",
        meeting: "Meeting",
        lead_status_change: "LeadStatusChange",
        opportunity_status_change: "OpportunityStatusChange",
        task_completed: "TaskCompleted",
        custom_activity: "CustomActivity",
      };
      const subType = subTypeMap[activityMatch[1]];
      if (subType) {
        const action = activityMatch[2];
        return {
          entity: `activities:${subType}`,
          operation: action === "deleted" ? "delete" : "upsert",
        };
      }
    }

    // Custom fields events: "custom_fields.lead.created" → entity "custom_fields"
    const cfMatch = eventType.match(
      /^custom_fields\.\w+\.(created|updated|deleted)$/,
    );
    if (cfMatch) {
      return {
        entity: "custom_fields",
        operation: cfMatch[1] === "deleted" ? "delete" : "upsert",
      };
    }

    // Status events: "status.lead.created" → entity "lead_statuses"
    const statusMatch = eventType.match(
      /^status\.(lead|opportunity)\.(created|updated|deleted)$/,
    );
    if (statusMatch) {
      return {
        entity: `${statusMatch[1]}_statuses`,
        operation: statusMatch[2] === "deleted" ? "delete" : "upsert",
      };
    }

    // Custom object/activity type events
    const typeMatch = eventType.match(
      /^(custom_activity_type|custom_object_type)\.(updated)$/,
    );
    if (typeMatch) {
      const entityMap: Record<string, string> = {
        custom_activity_type: "custom_activity_types",
        custom_object_type: "custom_object_types",
      };
      return {
        entity: entityMap[typeMatch[1]],
        operation: "upsert",
      };
    }

    // Custom object events
    const coMatch = eventType.match(
      /^custom_object\.(created|updated|deleted)$/,
    );
    if (coMatch) {
      return {
        entity: "custom_objects",
        operation: coMatch[1] === "deleted" ? "delete" : "upsert",
      };
    }

    return null;
  }

  /**
   * Get supported webhook event types
   */
  getSupportedWebhookEvents(): string[] {
    return CLOSE_SUPPORTED_WEBHOOK_SELECTORS.map(
      selector => `${selector.object_type}.${selector.action}`,
    );
  }

  /**
   * Extract entity data from webhook event
   */
  extractWebhookData(event: any): { id: string; data: any } | null {
    // Close webhook payload: {subscription_id, event: {object_type, action, data: {...}}}
    // Prefer object_id from wrapper, then fall back to nested payload ids.
    const innerEvent = event?.event;
    const data = innerEvent?.data || event?.data;
    const objectId =
      innerEvent?.object_id || event?.object_id || data?.id || event?.id;

    if (data && objectId) {
      return { id: String(objectId), data: { ...data, id: String(objectId) } };
    }

    // Delete/merge events can come without data payload.
    if (objectId) {
      return { id: String(objectId), data: { id: String(objectId) } };
    }

    return null;
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

    return records.map(record => {
      const payload =
        record.entity === "leads"
          ? this.normalizeLeadRecord(
              (record.payload || {}) as Record<string, unknown>,
            )
          : record.payload;
      return {
        ...record,
        payload,
        sourceTs,
        changeId:
          record.changeId ||
          event?.id ||
          event?.event?.id ||
          `${eventType || "close.event"}:${record.entity}:${record.recordId}`,
      };
    });
  }

  normalizeBackfillRecord(
    entity: string,
    record: Record<string, unknown>,
  ): NormalizedCdcRecord | null {
    const normalized = super.normalizeBackfillRecord(entity, record);
    if (!normalized) {
      return null;
    }

    const payload =
      entity === "leads"
        ? this.normalizeLeadRecord(
            (normalized.payload || {}) as Record<string, unknown>,
          )
        : normalized.payload;

    return {
      ...normalized,
      payload,
      sourceTs: this.resolveRecordTimestamp(record),
    };
  }
}
