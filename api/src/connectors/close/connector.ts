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
import {
  resolveCloseEntitySchema,
  closeCustomFieldSelectors,
  splitCloseSearchFieldSelection,
  type CloseCustomField,
  type CloseSearchFieldSelectionPlan,
} from "./schema";
import axios, { AxiosInstance } from "axios";
import * as crypto from "crypto";
import { loggers } from "../../logging";

const logger = loggers.connector("close");

const MAX_CLOSE_ERROR_RESPONSE_LENGTH = 2_000;

/**
 * How many `custom.cf_*` selectors one Search API request may name.
 *
 * Close returns HTTP 400 when `_fields` grows past an undocumented ceiling:
 * ~80 total selectors are known to work, ~140 are known to fail. 60 custom
 * selectors plus the ~30 base fields stays under the known-good mark; the
 * rest of the custom fields are fetched for the same page with follow-up
 * by-id requests. If Close still rejects a request the batch is halved
 * (down to the minimum) and the page is retried, so a tighter ceiling
 * degrades into more requests rather than a failed sync.
 */
export const CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH = 60;
const CLOSE_SEARCH_MIN_CUSTOM_SELECTOR_BATCH = 5;

function isCloseSearchCursorError(error: unknown): boolean {
  return (
    axios.isAxiosError(error) &&
    error.response?.status === 400 &&
    Boolean(error.response?.data?.["field-errors"]?.cursor)
  );
}

export function formatCloseApiErrorResponse(
  error: unknown,
): string | undefined {
  if (!axios.isAxiosError(error) || error.response?.data === undefined) {
    return undefined;
  }

  const responseData = error.response.data;
  const serialized =
    typeof responseData === "string"
      ? responseData
      : JSON.stringify(responseData);

  return serialized.length > MAX_CLOSE_ERROR_RESPONSE_LENGTH
    ? `${serialized.slice(0, MAX_CLOSE_ERROR_RESPONSE_LENGTH)}...`
    : serialized;
}

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

/** Close returns the HMAC key as `signature_key` on create/list/get. */
function extractCloseSigningSecret(
  webhook: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!webhook || typeof webhook !== "object") return undefined;
  const candidate =
    webhook.signature_key ?? webhook.signing_secret ?? webhook.secret;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

// Close webhook selectors from official event list.
const CLOSE_SUPPORTED_WEBHOOK_SELECTORS: CloseWebhookSelector[] = [
  { object_type: "lead", action: "created" },
  { object_type: "lead", action: "updated" },
  { object_type: "lead", action: "deleted" },
  { object_type: "lead", action: "merged" },
  { object_type: "contact", action: "created" },
  { object_type: "contact", action: "updated" },
  { object_type: "contact", action: "deleted" },
  // Close has no `user` webhook object_type — membership activated/deactivated
  // carries embedded user data (see Close "List of Event Types").
  { object_type: "membership", action: "activated" },
  { object_type: "membership", action: "deactivated" },
  { object_type: "opportunity", action: "created" },
  { object_type: "opportunity", action: "updated" },
  { object_type: "opportunity", action: "deleted" },
  { object_type: "activity.call", action: "created" },
  // `updated` is how manually-logged calls (source "External") get their real
  // duration (created with duration 0, then updated on save), and how native
  // calls get recording_url/has_recording after the recording lands. Without
  // this selector those fields freeze at their creation values.
  { object_type: "activity.call", action: "updated" },
  { object_type: "activity.call", action: "deleted" },
  { object_type: "activity.call", action: "answered" },
  { object_type: "activity.call", action: "completed" },
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
  { object_type: "activity.task_completed", action: "updated" },
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
  { object_type: "custom_fields.activity", action: "created" },
  { object_type: "custom_fields.activity", action: "updated" },
  { object_type: "custom_fields.activity", action: "deleted" },
  { object_type: "custom_fields.custom_object", action: "created" },
  { object_type: "custom_fields.custom_object", action: "updated" },
  { object_type: "custom_fields.custom_object", action: "deleted" },
  { object_type: "custom_fields.shared", action: "created" },
  { object_type: "custom_fields.shared", action: "updated" },
  { object_type: "custom_fields.shared", action: "deleted" },
  { object_type: "custom_activity_type", action: "created" },
  { object_type: "custom_activity_type", action: "updated" },
  { object_type: "custom_activity_type", action: "deleted" },
  { object_type: "custom_object_type", action: "created" },
  { object_type: "custom_object_type", action: "updated" },
  { object_type: "custom_object_type", action: "deleted" },
  { object_type: "custom_object", action: "created" },
  { object_type: "custom_object", action: "updated" },
  { object_type: "custom_object", action: "deleted" },
  { object_type: "status.lead", action: "created" },
  { object_type: "status.lead", action: "updated" },
  { object_type: "status.lead", action: "deleted" },
  { object_type: "status.opportunity", action: "created" },
  { object_type: "status.opportunity", action: "updated" },
  { object_type: "status.opportunity", action: "deleted" },
  { object_type: "group", action: "created" },
  { object_type: "group", action: "updated" },
  { object_type: "group", action: "deleted" },
];

const CLOSE_SUPPORTED_WEBHOOK_SELECTOR_KEYS = new Set(
  CLOSE_SUPPORTED_WEBHOOK_SELECTORS.map(
    selector => `${selector.object_type}:${selector.action}`,
  ),
);

/**
 * Per-API-key request gate shared across all CloseConnector instances.
 * Multiple flows may use the same Close API key concurrently; without
 * coordination they blast the shared rate-limit bucket and trigger 429s.
 * This gate serializes requests per key with a minimum inter-request delay.
 */
const apiKeyGates = new Map<
  string,
  { chain: Promise<void>; minDelayMs: number }
>();

function getApiKeyGate(apiKey: string, minDelayMs: number) {
  let gate = apiKeyGates.get(apiKey);
  if (!gate) {
    gate = { chain: Promise.resolve(), minDelayMs };
    apiKeyGates.set(apiKey, gate);
  }
  return gate;
}

function throttledRequest<T>(
  apiKey: string,
  fn: () => Promise<T>,
  minDelayMs: number,
): Promise<T> {
  const gate = getApiKeyGate(apiKey, minDelayMs);
  const result = gate.chain.then(async () => {
    try {
      return await fn();
    } finally {
      // Always wait minDelayMs AFTER each request completes before
      // releasing the gate for the next one.
      await new Promise(r => setTimeout(r, minDelayMs));
    }
  });
  gate.chain = result.then(
    () => {},
    () => {},
  );
  return result;
}

export class CloseConnector extends BaseConnector {
  private customFieldSchemaCache = new Map<string, CloseCustomField[]>();

  /**
   * Current per-request budget of `custom.cf_*` selectors for the Search
   * API. Starts at CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH and only ever shrinks,
   * when Close answers a field selection with HTTP 400.
   */
  private customSelectorBatchSize = CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH;

  private static readonly ENTITY_TO_CUSTOM_FIELD_OBJECT_TYPE: Record<
    string,
    string
  > = {
    leads: "lead",
    contacts: "contact",
    opportunities: "opportunity",
  };

  private async fetchCustomFieldsForEntity(
    entity: string,
  ): Promise<CloseCustomField[]> {
    if (entity === "activities:CustomActivity") {
      return this.fetchCustomFieldsViaList(
        "activity",
        "/custom_field/activity/",
      );
    }

    if (entity === "custom_objects") {
      return this.fetchCustomFieldsViaList(
        "custom_object",
        "/custom_field/custom_object_type/",
      );
    }

    const objectType =
      CloseConnector.ENTITY_TO_CUSTOM_FIELD_OBJECT_TYPE[entity];
    if (!objectType) return [];

    return this.fetchCustomFieldsViaSchema(objectType);
  }

  /**
   * Re-read the custom-field schema from Close, bypassing the per-instance
   * cache. Used when a Search request is rejected mid-run: a field deleted
   * in Close after the schema was cached leaves a dangling `custom.cf_*`
   * selector that Close refuses, and the fix is to re-plan with the current
   * schema — not to shrink the batch.
   */
  private async refreshCustomFieldsViaSchema(
    objectType: string,
  ): Promise<CloseCustomField[]> {
    this.customFieldSchemaCache.delete(objectType);
    return this.fetchCustomFieldsViaSchema(objectType);
  }

  private async fetchCustomFieldsViaSchema(
    objectType: string,
  ): Promise<CloseCustomField[]> {
    const cached = this.customFieldSchemaCache.get(objectType);
    if (cached) return cached;

    const api = this.getCloseClient();
    try {
      const response = await api.get(`/custom_field_schema/${objectType}/`);
      const fields: CloseCustomField[] = (response.data?.fields || []).map(
        (f: any) => ({
          id: String(f.id || ""),
          name: String(f.name || ""),
          type: String(f.type || "text"),
          appliesTo: objectType,
          acceptsMultipleValues: Boolean(f.accepts_multiple_values),
        }),
      );
      this.customFieldSchemaCache.set(objectType, fields);
      return fields;
    } catch {
      return [];
    }
  }

  private async fetchCustomFieldsViaList(
    cacheKey: string,
    endpoint: string,
  ): Promise<CloseCustomField[]> {
    const cached = this.customFieldSchemaCache.get(cacheKey);
    if (cached) return cached;

    const api = this.getCloseClient();
    try {
      const response = await api.get(endpoint);
      const fields: CloseCustomField[] = (response.data?.data || []).map(
        (f: any) => ({
          id: String(f.id || ""),
          name: String(f.name || ""),
          type: String(f.type || "text"),
          appliesTo: cacheKey,
          acceptsMultipleValues: Boolean(f.accepts_multiple_values),
        }),
      );
      this.customFieldSchemaCache.set(cacheKey, fields);
      return fields;
    } catch {
      return [];
    }
  }

  async resolveSchema(entity: string): Promise<ConnectorEntitySchema | null> {
    const customFields = await this.fetchCustomFieldsForEntity(entity);
    return resolveCloseEntitySchema(entity, customFields);
  }

  private static readonly LEAD_FIELDS = [
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
    "source",
    "addresses",
    "url",
    "html_url",
    "contact_ids",
    "contacts",
    "opportunities",
    "tasks",
    "integration_links",
    "custom",
    "primary_email",
    "primary_phone",
  ] as const;

  private static readonly LEAD_ALLOWED_NORMALIZED_FIELDS = new Set<string>(
    CloseConnector.LEAD_FIELDS,
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

  private getSearchObjectType(entity: string): string {
    const map: Record<string, string> = {
      leads: "lead",
      contacts: "contact",
      opportunities: "opportunity",
      "activities:Call": "activity.call",
      "activities:Email": "activity.email",
      "activities:EmailThread": "activity.email_thread",
      "activities:SMS": "activity.sms",
      "activities:Meeting": "activity.meeting",
      "activities:Note": "activity.note",
      "activities:LeadStatusChange": "activity.lead_status_change",
      "activities:OpportunityStatusChange":
        "activity.opportunity_status_change",
      "activities:TaskCompleted": "activity.task_completed",
      "activities:CustomActivity": "activity.custom_activity",
    };
    return map[entity] || entity;
  }

  private getEntityEndpoint(entity: string): string {
    const map: Record<string, string> = {
      leads: "/lead/",
      opportunities: "/opportunity/",
      contacts: "/contact/",
      users: "/user/",
    };
    const endpoint = map[entity];
    if (!endpoint) throw new Error(`No endpoint for entity: ${entity}`);
    return endpoint;
  }

  private async getLeadFieldSelection(): Promise<string> {
    if (this.cachedLeadFieldSelection) {
      return this.cachedLeadFieldSelection;
    }

    const fields = new Set<string>(CloseConnector.LEAD_FIELDS);
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

  /**
   * Flatten custom fields into `custom_<cfId>` columns so that webhook
   * payloads (nested `custom` object) and backfill payloads (flat dotted keys
   * via `_fields=custom.cf_xxx`) both land in the schema-declared columns.
   */
  private static flattenCustomFields(record: Record<string, unknown>): void {
    // Flat dotted keys from explicit `_fields` selectors: custom.cf_x → custom_cf_x
    for (const rawKey of Object.keys(record)) {
      if (!/^custom\.cf_[A-Za-z0-9]+$/.test(rawKey)) continue;
      const flatKey = rawKey.replace(/\./g, "_");
      if (!(flatKey in record)) {
        record[flatKey] = record[rawKey];
      }
      delete record[rawKey];
    }

    // Nested `custom` object (webhook payloads, Search API `custom` blob)
    if (
      record.custom &&
      typeof record.custom === "object" &&
      !Array.isArray(record.custom)
    ) {
      const customObj = record.custom as Record<string, unknown>;
      for (const [cfKey, cfValue] of Object.entries(customObj)) {
        if (!/^cf_[A-Za-z0-9]+$/.test(cfKey)) continue;
        const flatKey = `custom_${cfKey}`;
        if (!(flatKey in record)) {
          record[flatKey] = cfValue;
        }
      }
    }
  }

  /** Entities whose payloads carry Close custom fields that must be flattened. */
  private static readonly CUSTOM_FIELD_FLATTEN_ENTITIES = new Set([
    "opportunities",
    "contacts",
    "custom_objects",
  ]);

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

    CloseConnector.flattenCustomFields(normalized);

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

      const apiKey = this.dataSource.config.api_key;
      const minDelayMs = Math.max(500, this.getRateLimitDelay());

      const rawClient = axios.create({
        baseURL: "https://api.close.com/api/v1",
        auth: {
          username: apiKey,
          password: "",
        },
        headers: {
          "Content-Type": "application/json",
        },
      });

      // Wrap get/post/put/patch/delete through the per-API-key throttle
      // so concurrent flows sharing the same key don't blast the rate limit.
      const emitLog = this.emitSyncLog.bind(this);
      const seqRef = { seq: 0 };

      this.closeApi = new Proxy(rawClient, {
        get(target, prop, receiver) {
          const val = Reflect.get(target, prop, receiver);
          if (
            typeof val === "function" &&
            typeof prop === "string" &&
            ["get", "post", "put", "patch", "delete"].includes(prop)
          ) {
            return (...args: unknown[]) =>
              throttledRequest(
                apiKey,
                () => {
                  const requestId = `close_req_${Date.now()}_${++seqRef.seq}`;
                  emitLog("info", "Close API request sent", {
                    requestId,
                    method: prop.toUpperCase(),
                    endpoint: typeof args[0] === "string" ? args[0] : "",
                  });
                  const startedAt = Date.now();

                  return (val.apply(target, args) as Promise<any>).then(
                    (response: any) => {
                      emitLog("info", "Close API response received", {
                        requestId,
                        method: prop.toUpperCase(),
                        endpoint: typeof args[0] === "string" ? args[0] : "",
                        status: response.status,
                        durationMs: Date.now() - startedAt,
                      });
                      return response;
                    },
                    (error: any) => {
                      emitLog("warn", "Close API request failed", {
                        requestId,
                        method: prop.toUpperCase(),
                        endpoint: typeof args[0] === "string" ? args[0] : "",
                        status: error?.response?.status,
                        durationMs: Date.now() - startedAt,
                        error: axios.isAxiosError(error)
                          ? error.message
                          : String(error),
                        responseBody: formatCloseApiErrorResponse(error),
                      });
                      return Promise.reject(error);
                    },
                  );
                },
                minDelayMs,
              );
          }
          return val;
        },
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
    const baseEntities = [
      "leads",
      "opportunities",
      "contacts",
      "users",
      "custom_fields",
      "custom_activity_types",
      "custom_object_types",
      "custom_objects",
      "lead_statuses",
      "opportunity_statuses",
      "outcomes",
      "groups",
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
    // Default to `_syncedAt` as the partition field: it is stamped on every
    // destination write (insert/update), so partitions track last-sync time and
    // every entity has a guaranteed, always-populated timestamp to partition on.
    // Per-entity overrides (e.g. `date_created`) remain selectable in the flow UI.
    const defaultLayout = {
      partitionField: "_syncedAt",
      partitionGranularity: "day" as const,
      clusterFields: ["_dataSourceId", "id"],
    };
    // Lookup tables have no stable creation timestamp worth partitioning on.
    const lookupLayout = {
      partitionField: "_syncedAt",
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
          partitionField: "_syncedAt",
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
        layoutSuggestion: lookupLayout,
      },
      {
        name: "custom_activity_types",
        label: "Custom Activity Types",
        layoutSuggestion: lookupLayout,
      },
      {
        name: "custom_object_types",
        label: "Custom Object Types",
        layoutSuggestion: lookupLayout,
      },
      {
        name: "custom_objects",
        label: "Custom Objects",
        layoutSuggestion: defaultLayout,
      },
      {
        name: "lead_statuses",
        label: "Lead Statuses",
        layoutSuggestion: lookupLayout,
      },
      {
        name: "opportunity_statuses",
        label: "Opportunity Statuses",
        layoutSuggestion: lookupLayout,
      },
      {
        name: "outcomes",
        label: "Outcomes",
        layoutSuggestion: lookupLayout,
      },
      {
        name: "groups",
        label: "Groups",
        description: "User groups (functional teams, e.g. Sales / CSM)",
        layoutSuggestion: lookupLayout,
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

    if (entity === "groups") {
      return await this.fetchGroupsChunk(options);
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

    // Bare "activities" without a subtype can't map to a Search API object type.
    if (entity === "activities") {
      logger.warn(
        "Bare 'activities' entity not supported — use activities:Call etc.",
      );
      return { totalProcessed: 0, hasMore: false, iterationsInChunk: 0 };
    }

    // Leads, contacts, opportunities, and activities all use the Search API
    // with native cursor pagination (no _skip limits).
    if (
      entity === "leads" ||
      entity === "contacts" ||
      entity === "opportunities" ||
      entity.startsWith("activities:")
    ) {
      return await this.fetchViaSearchApi(options);
    }

    const api = this.getCloseClient();
    const batchSize = options.batchSize || this.getBatchSize();
    const rateLimitDelay = options.rateLimitDelay || this.getRateLimitDelay();

    // Offset-based pagination fallback for other entities
    let offset = state?.offset || 0;
    let recordCount = state?.totalProcessed || 0;
    let hasMore = true;
    let iterations = 0;

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
        _order_by: "id",
      };

      try {
        const endpoint = this.getEntityEndpoint(entity);

        if (since) {
          const dateFilter = since.toISOString().split("T")[0];
          params.date_updated__gte = dateFilter;
          params._order_by = "-date_updated";
        }
        response = await api.get(endpoint, { params });

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
        } else {
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

  private async fetchViaSearchApi(
    options: ResumableFetchOptions,
  ): Promise<FetchState> {
    const { entity, onBatch, onProgress, state, since } = options;
    const api = this.getCloseClient();
    const batchSize = 200;
    const rateLimitDelay = Math.max(
      500,
      options.rateLimitDelay || this.getRateLimitDelay(),
    );
    const maxIterations = options.maxIterations || 10;

    let recordCount = state?.totalProcessed || 0;
    let iterations = 0;

    // Incremental polls window on `date_updated` starting at `since`.
    // Full backfills keep the historical `date_created` walk (oldest → now).
    const windowField: "date_created" | "date_updated" = since
      ? "date_updated"
      : "date_created";

    // Date-window cursor: "before" boundary for descending pagination.
    // Close's Search API ignores _skip — we use native cursor tokens for
    // page-to-page navigation and date-based windowing to avoid the 10k limit.
    const dateWindowCursor: string | null = state?.metadata?.cursor ?? null;

    const objectType = this.getSearchObjectType(entity);

    const fieldsMap: Record<string, string[]> = {
      lead: [
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
        "source",
        "addresses",
        "url",
        "html_url",
        "contacts",
        "contact_ids",
        "opportunities",
        "tasks",
        "integration_links",
        "primary_email",
        "primary_phone",
      ],
      contact: [
        "id",
        "name",
        "display_name",
        "title",
        "emails",
        "phones",
        "urls",
        "lead_id",
        "organization_id",
        "date_created",
        "date_updated",
        "created_by",
        "updated_by",
        "integration_links",
        "timezone",
      ],
      opportunity: [
        "id",
        "lead_id",
        "lead_name",
        "contact_id",
        "contact_name",
        "status_id",
        "status_label",
        "status_type",
        "status_display_name",
        "pipeline_id",
        "pipeline_name",
        "user_id",
        "user_name",
        "value",
        "value_currency",
        "value_formatted",
        "value_period",
        "annualized_value",
        "expected_value",
        "annualized_expected_value",
        "confidence",
        "note",
        "date_created",
        "date_updated",
        "date_won",
        "date_lost",
        "created_by",
        "created_by_name",
        "updated_by",
        "updated_by_name",
        "organization_id",
        "integration_links",
        "attachments",
        "is_stalled",
        "stall_status",
      ],
    };

    // All activity types share common fields; the API ignores unknown fields per type.
    const activityFields = [
      "id",
      "_type",
      "lead_id",
      "contact_id",
      "user_id",
      "user_name",
      "created_by",
      "created_by_name",
      "updated_by",
      "updated_by_name",
      "organization_id",
      "date_created",
      "date_updated",
      "activity_at",
      // Call
      "direction",
      "duration",
      "phone",
      "local_phone",
      "remote_phone",
      "status",
      "disposition",
      "call_method",
      "cost",
      "note",
      "note_html",
      "recording_url",
      "voicemail_url",
      "voicemail_duration",
      "outcome_id",
      "outcome_reason",
      "outcome_autofill_confidence",
      "outcome_autofill_reasoning",
      "transferred_from",
      "transferred_to",
      "source",
      // Email
      "subject",
      "body_text",
      "sender",
      "to",
      "cc",
      "bcc",
      "envelope",
      "thread_id",
      "template_id",
      "opens",
      // SMS
      "text",
      "local_phone_formatted",
      "remote_phone_formatted",
      // Meeting
      "title",
      "starts_at",
      "ends_at",
      "location",
      "is_recurring",
      "attendees",
      "connected_account_id",
      // Status changes
      "old_status_id",
      "old_status_label",
      "old_status_type",
      "new_status_id",
      "new_status_label",
      "new_status_type",
      // Note (activity.note)
      "note_date_updated",
      "pinned",
      "pinned_at",
      "attachments",
      "note_mentions",
    ];

    if (objectType.startsWith("activity.")) {
      fieldsMap[objectType] = activityFields;
    }

    // Core objects: enumerate every custom field as an explicit
    // `custom.cf_<id>` selector so values come back as flat keys (matching the
    // schema's `custom_cf_*` columns and the shape webhooks deliver) instead
    // of the deprecated aggregate `custom` blob. The selection is split so no
    // single request exceeds the per-request selector budget; see
    // CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH. The custom-field schema lookup is
    // cached per connector instance.
    let coreCustomFields: CloseCustomField[] | null = null;
    if (
      objectType === "lead" ||
      objectType === "contact" ||
      objectType === "opportunity"
    ) {
      coreCustomFields = await this.fetchCustomFieldsViaSchema(objectType);
    }
    const planFieldSelection = (): CloseSearchFieldSelectionPlan | null =>
      coreCustomFields
        ? splitCloseSearchFieldSelection(
            fieldsMap[objectType] || [],
            coreCustomFields,
            this.customSelectorBatchSize,
          )
        : null;

    // Forward-scanning ASC date windows avoid the non-deterministic row drops
    // that occur with DESC sort + cursor resets.  Close's Search API cursor is
    // unstable under DESC sort: resetting the cursor mid-window can silently
    // skip records.  Small ASC windows (7 days) stay well under the ~10k cursor
    // limit and produce deterministic, gap-free results.
    const WINDOW_DAYS = 7;

    let windowStart: string | null =
      state?.metadata?.windowStart ?? dateWindowCursor ?? null;
    let windowEnd: string | null = state?.metadata?.windowEnd ?? null;
    let pageCursor: string | null = state?.metadata?.pageCursor ?? null;
    let lastSeenWindowValue: string | null =
      state?.metadata?.lastSeenWindowValue ??
      state?.metadata?.lastSeenDateCreated ??
      null;

    if (!state && onProgress) {
      try {
        const countQueries: any[] = [
          { negate: false, type: "object_type", object_type: objectType },
        ];
        if (since) {
          countQueries.push({
            type: "field_condition",
            field: {
              type: "regular_field",
              object_type: objectType,
              field_name: windowField,
            },
            condition: {
              type: "moment_range",
              on_or_after: {
                type: "fixed_utc",
                value: since.toISOString(),
              },
            },
          });
        } else {
          countQueries.push({ negate: false, type: "match_all" });
        }
        const countResp = await api.post("/data/search/", {
          query: {
            negate: false,
            type: "and",
            queries: countQueries,
          },
          include_counts: true,
          results_limit: 0,
        });
        const total = countResp.data?.count?.total;
        if (typeof total === "number") {
          onProgress(0, total);
        }
      } catch {
        onProgress(0, undefined);
      }
    }

    // Resolve the date range on first invocation
    if (!windowStart) {
      if (since) {
        windowStart = since.toISOString();
      } else {
        const oldestResp = await api.post("/data/search/", {
          query: {
            negate: false,
            type: "and",
            queries: [
              { negate: false, type: "object_type", object_type: objectType },
              { negate: false, type: "match_all" },
            ],
          },
          _limit: 1,
          sort: [
            {
              direction: "asc",
              field: {
                object_type: objectType,
                type: "regular_field",
                field_name: "date_created",
              },
            },
          ],
          _fields: { [objectType]: ["id", "date_created"] },
        });
        const oldestRow = oldestResp.data?.data?.[0];
        if (!oldestRow) {
          return {
            totalProcessed: recordCount,
            hasMore: false,
            iterationsInChunk: 0,
          };
        }
        windowStart = new Date(oldestRow.date_created).toISOString();
      }
    }

    // Upper bound: far-future sentinel so the last window captures everything
    const upperBound = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    if (!windowEnd) {
      windowEnd = new Date(
        new Date(windowStart).getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
    }

    // Invariant: windowStart and windowEnd are both set by this point.
    // Either we returned early in the oldestResp handler, or both have been
    // assigned above. Narrow for TypeScript to avoid non-null assertions below.
    if (windowStart === null || windowEnd === null) {
      return {
        totalProcessed: recordCount,
        hasMore: false,
        iterationsInChunk: 0,
      };
    }

    while (iterations < maxIterations) {
      if (new Date(windowStart).getTime() >= new Date(upperBound).getTime()) {
        return {
          totalProcessed: recordCount,
          hasMore: false,
          iterationsInChunk: iterations,
          metadata: {
            windowStart,
            windowEnd,
            pageCursor: null,
            lastSeenWindowValue,
            windowField,
          },
        };
      }

      try {
        const secondarySortField =
          windowField === "date_updated" ? "date_created" : "date_updated";
        const body: any = {
          query: {
            negate: false,
            type: "and",
            queries: [
              {
                negate: false,
                type: "object_type",
                object_type: objectType,
              },
              {
                type: "field_condition",
                field: {
                  type: "regular_field",
                  object_type: objectType,
                  field_name: windowField,
                },
                condition: {
                  type: "moment_range",
                  on_or_after: { type: "fixed_utc", value: windowStart },
                  before: { type: "fixed_utc", value: windowEnd },
                },
              },
            ],
          },
          _limit: batchSize,
          sort: [
            {
              direction: "asc",
              field: {
                object_type: objectType,
                type: "regular_field",
                field_name: windowField,
              },
            },
            {
              direction: "asc",
              field: {
                object_type: objectType,
                type: "regular_field",
                field_name: secondarySortField,
              },
            },
          ],
        };

        const fieldPlan = planFieldSelection();
        if (fieldPlan) {
          body._fields = { [objectType]: fieldPlan.primary };
        } else if (fieldsMap[objectType]) {
          body._fields = { [objectType]: fieldsMap[objectType] };
        }
        if (pageCursor) {
          body.cursor = pageCursor;
        }

        const response = await api.post("/data/search/", body);
        let data: any[] = response.data.data || [];
        pageCursor = response.data.cursor || null;

        if (fieldPlan && fieldPlan.supplemental.length > 0 && data.length > 0) {
          data = await this.fetchSupplementalCustomFields(
            api,
            objectType,
            data,
            fieldPlan.supplemental,
          );
        }

        if (data.length > 0) {
          const records =
            entity === "leads"
              ? this.normalizeLeadBatch(data)
              : CloseConnector.CUSTOM_FIELD_FLATTEN_ENTITIES.has(entity)
                ? data.map((record: any) => {
                    const normalized = {
                      ...(record || {}),
                    } as Record<string, unknown>;
                    CloseConnector.flattenCustomFields(normalized);
                    return normalized;
                  })
                : data;
          await onBatch(records);
          recordCount += records.length;
          if (onProgress) onProgress(recordCount, undefined);

          const lastRow = data[data.length - 1];
          const lastValue = lastRow?.[windowField];
          if (typeof lastValue === "string" && lastValue.length > 0) {
            lastSeenWindowValue = new Date(lastValue).toISOString();
          }
        }

        if (data.length === 0 || !pageCursor) {
          // Window exhausted — advance to the next window
          windowStart = windowEnd;
          windowEnd = new Date(
            new Date(windowStart).getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000,
          ).toISOString();
          pageCursor = null;

          if (data.length === 0) {
            // Empty window — binary-search forward to skip large gaps
            // efficiently instead of probing one 7-day window at a time.
            const nextStart = await this.findNextNonEmptyWindow(
              api,
              objectType,
              windowStart,
              upperBound,
              WINDOW_DAYS,
              windowField,
            );
            if (!nextStart) {
              // No more data until upperBound — done
              return {
                totalProcessed: recordCount,
                hasMore: false,
                iterationsInChunk: iterations,
                metadata: {
                  windowStart,
                  windowEnd,
                  pageCursor: null,
                  lastSeenWindowValue,
                  windowField,
                },
              };
            }
            windowStart = nextStart;
            windowEnd = new Date(
              new Date(windowStart).getTime() +
                WINDOW_DAYS * 24 * 60 * 60 * 1000,
            ).toISOString();
            continue;
          }
        }

        iterations++;
        await this.sleep(rateLimitDelay);
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          const retryAfter = parseInt(
            error.response.headers["retry-after"] || "60",
          );
          this.emitSyncLog("warn", "Close API rate limited, waiting", {
            retryAfterSeconds: retryAfter,
            entity,
            recordsFetched: recordCount,
            page: iterations,
          });
          logger.warn("Rate limited on search API, waiting", {
            retryAfterSeconds: retryAfter,
            entity,
            recordsFetched: recordCount,
          });
          await this.sleep(retryAfter * 1000);
        } else if (
          axios.isAxiosError(error) &&
          error.response?.status === 400 &&
          error.response?.data?.["field-errors"]?.cursor
        ) {
          // Cursor expired / limit reached inside a window.
          // Advance windowStart to the last successfully fetched window
          // value so we don't re-emit rows already sent via onBatch.
          // If we haven't fetched anything yet in this window, halve the span.
          if (lastSeenWindowValue) {
            const normalizedLastSeenWindowValue = new Date(
              lastSeenWindowValue,
            ).toISOString();
            this.emitSyncLog(
              "info",
              "Close cursor limit reached, advancing past fetched rows",
              {
                entity,
                recordsFetched: recordCount,
                windowStart,
                windowEnd,
                advancingTo: normalizedLastSeenWindowValue,
                windowField,
              },
            );
            windowStart = normalizedLastSeenWindowValue;
            lastSeenWindowValue = null;
          } else {
            this.emitSyncLog(
              "info",
              "Close cursor limit reached, halving date window",
              { entity, recordsFetched: recordCount, windowStart, windowEnd },
            );
            // Snapshot current window bounds: both are guaranteed non-null
            // by the invariant guard above the loop, but TS loses track
            // across reassignments inside the loop.
            const currentStart: string = windowStart ?? "";
            const currentEnd: string = windowEnd ?? "";
            const currentSpan =
              new Date(currentEnd).getTime() - new Date(currentStart).getTime();
            const halfSpan = Math.max(currentSpan / 2, 24 * 60 * 60 * 1000);
            windowEnd = new Date(
              new Date(currentStart).getTime() + halfSpan,
            ).toISOString();
          }
          pageCursor = null;
        } else if (
          coreCustomFields &&
          axios.isAxiosError(error) &&
          error.response?.status === 400
        ) {
          // Close rejected the field selection. Two causes, checked in order:
          // the custom-field schema changed under us (a selector now names a
          // deleted field) — re-plan with the fresh schema; or the list is
          // simply too long — retry with a smaller per-request budget. The
          // cursor is unchanged either way, so the same page is retried.
          const refreshed = await this.refreshCustomFieldsViaSchema(objectType);
          if (
            this.customFieldSelectionChanged(
              entity,
              coreCustomFields,
              refreshed,
              error,
            )
          ) {
            coreCustomFields = refreshed;
            continue;
          }
          if (this.shrinkCustomSelectorBatch(error, entity, coreCustomFields)) {
            continue;
          }
          throw error;
        } else {
          throw error;
        }
      }
    }

    return {
      totalProcessed: recordCount,
      hasMore: true,
      iterationsInChunk: iterations,
      metadata: {
        windowStart,
        windowEnd,
        pageCursor,
        lastSeenWindowValue,
        windowField,
      },
    };
  }

  /**
   * True when a re-read of the custom-field schema yields a different set of
   * selectors than the one a rejected request was built from — i.e. the
   * schema changed mid-run. Logs what changed so the sync log explains the
   * retry.
   */
  private customFieldSelectionChanged(
    entity: string,
    previous: readonly CloseCustomField[],
    refreshed: readonly CloseCustomField[],
    error: unknown,
  ): boolean {
    const before = closeCustomFieldSelectors(previous);
    const after = new Set(closeCustomFieldSelectors(refreshed));
    const beforeSet = new Set(before);
    const removed = before.filter(selector => !after.has(selector));
    const added = [...after].filter(selector => !beforeSet.has(selector));
    if (removed.length === 0 && added.length === 0) return false;

    const details = {
      entity,
      removed,
      added,
      responseBody: formatCloseApiErrorResponse(error),
    };
    this.emitSyncLog(
      "warn",
      "Close custom-field schema changed during the run, re-planning the field selection",
      details,
    );
    logger.warn("Close custom-field schema changed mid-run", details);
    return true;
  }

  /**
   * Decide whether an HTTP 400 from the Search API should be treated as
   * "too many `_fields` selectors" and, if so, halve the per-request budget.
   * Returns true when the caller should retry with the smaller budget.
   *
   * Close does not document the ceiling, and the error text is not stable
   * enough to match on, so any 400 that is not the known cursor error, on a
   * request that carried custom selectors, shrinks the budget — until the
   * minimum is reached, at which point the error propagates.
   */
  private shrinkCustomSelectorBatch(
    error: unknown,
    entity: string,
    customFields: readonly CloseCustomField[] | null,
  ): boolean {
    if (!axios.isAxiosError(error) || error.response?.status !== 400) {
      return false;
    }
    if (isCloseSearchCursorError(error)) return false;
    if (!customFields || closeCustomFieldSelectors(customFields).length === 0) {
      return false;
    }
    if (
      this.customSelectorBatchSize <= CLOSE_SEARCH_MIN_CUSTOM_SELECTOR_BATCH
    ) {
      return false;
    }

    const previous = this.customSelectorBatchSize;
    this.customSelectorBatchSize = Math.max(
      CLOSE_SEARCH_MIN_CUSTOM_SELECTOR_BATCH,
      Math.floor(previous / 2),
    );
    const details = {
      entity,
      previousBatchSize: previous,
      newBatchSize: this.customSelectorBatchSize,
      responseBody: formatCloseApiErrorResponse(error),
    };
    this.emitSyncLog(
      "warn",
      "Close rejected the field selection, retrying with fewer custom selectors per request",
      details,
    );
    logger.warn(
      "Close rejected Search API field selection, shrinking batch",
      details,
    );
    return true;
  }

  /**
   * Re-fetch one already-paged set of rows by id, one request per selector
   * batch, and merge the returned `custom.cf_*` keys into the rows.
   *
   * This is what lets every custom field be requested explicitly on orgs
   * with more fields than Close accepts in a single `_fields` list: the paged
   * request carries the base fields plus the first batch, and each remaining
   * batch is fetched here for exactly the ids of that page. Row order and
   * the page cursor are untouched.
   */
  private async fetchSupplementalCustomFields(
    api: AxiosInstance,
    objectType: string,
    rows: any[],
    supplemental: string[][],
  ): Promise<any[]> {
    const ids = rows
      .map(row => (typeof row?.id === "string" ? row.id : ""))
      .filter(id => id.length > 0);
    if (ids.length === 0) return rows;

    const byId = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      if (row && typeof row.id === "string") byId.set(row.id, row);
    }

    const idQuery = {
      negate: false,
      type: "and",
      queries: [
        { negate: false, type: "object_type", object_type: objectType },
        {
          negate: false,
          type: "or",
          queries: ids.map(id => ({ negate: false, type: "id", value: id })),
        },
      ],
    };

    // Work through the batches; a batch that Close rejects is re-split with
    // the (now smaller) budget instead of being dropped.
    let pending: string[][] = supplemental.map(batch => [...batch]);
    while (pending.length > 0) {
      const batch = pending[0];
      try {
        const response = await api.post("/data/search/", {
          query: idQuery,
          _limit: ids.length,
          _fields: { [objectType]: batch },
        });
        const extra: any[] = response.data?.data || [];
        for (const row of extra) {
          if (!row || typeof row.id !== "string") continue;
          const target = byId.get(row.id);
          if (!target) continue;
          for (const [key, value] of Object.entries(row)) {
            if (key === "id" || key === "__object_type") continue;
            target[key] = value;
          }
        }
        pending.shift();
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          const retryAfter = parseInt(
            error.response.headers["retry-after"] || "60",
          );
          this.emitSyncLog("warn", "Close API rate limited, waiting", {
            retryAfterSeconds: retryAfter,
            objectType,
          });
          await this.sleep(retryAfter * 1000);
          continue;
        }
        const remainingFields: CloseCustomField[] = pending
          .flatMap(b => b.filter(field => field !== "id"))
          .map(selector => ({
            id: selector.replace(/^custom\./, ""),
            name: selector,
            type: "text",
            appliesTo: objectType,
          }));
        const replan = (fields: readonly CloseCustomField[]) => {
          const plan = splitCloseSearchFieldSelection(
            [],
            fields,
            this.customSelectorBatchSize,
          );
          // `primary` is `id` + the first batch; the rest are already
          // shaped as supplemental batches.
          pending = plan.supplemental;
          if (plan.primary.length > 1) pending.unshift(plan.primary);
        };

        if (axios.isAxiosError(error) && error.response?.status === 400) {
          const refreshed = await this.refreshCustomFieldsViaSchema(objectType);
          const current = new Set(closeCustomFieldSelectors(refreshed));
          const stillValid = remainingFields.filter(field =>
            current.has(`custom.${field.id}`),
          );
          if (
            stillValid.length !== remainingFields.length &&
            this.customFieldSelectionChanged(
              objectType,
              remainingFields,
              stillValid,
              error,
            )
          ) {
            replan(stillValid);
            continue;
          }
          if (
            this.shrinkCustomSelectorBatch(error, objectType, remainingFields)
          ) {
            replan(remainingFields);
            continue;
          }
        }
        throw error;
      }
    }

    return rows;
  }

  /**
   * Binary-search forward to find the start of the next non-empty date region.
   * Instead of scanning hundreds of 7-day empty windows one-by-one (each
   * costing an API request), this narrows the gap in ~log2(gapDays/windowDays)
   * lightweight `_limit: 1` probes.
   *
   * Returns the ISO timestamp of the start of the first window-aligned region
   * that contains data, or `null` if the entire range up to `upperBound` is
   * empty.
   */
  private async findNextNonEmptyWindow(
    api: AxiosInstance,
    objectType: string,
    gapStart: string,
    upperBound: string,
    windowDays: number,
    windowField: "date_created" | "date_updated" = "date_created",
  ): Promise<string | null> {
    let lo = new Date(gapStart).getTime();
    let hi = new Date(upperBound).getTime();
    const windowMs = windowDays * 24 * 60 * 60 * 1000;

    if (lo >= hi) return null;

    // First check: is there ANY data in [lo, hi) at all?
    const anyData = await this.probeSearchRange(
      api,
      objectType,
      new Date(lo).toISOString(),
      new Date(hi).toISOString(),
      windowField,
    );
    if (!anyData) return null;

    // Binary search: invariant — data exists somewhere in [lo, hi)
    while (hi - lo > windowMs) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const hasDataInLeft = await this.probeSearchRange(
        api,
        objectType,
        new Date(lo).toISOString(),
        new Date(mid).toISOString(),
        windowField,
      );

      if (hasDataInLeft) {
        hi = mid;
      } else {
        lo = mid;
      }
    }

    return new Date(lo).toISOString();
  }

  /** Returns true if at least one record exists in [rangeStart, rangeEnd). */
  private async probeSearchRange(
    api: AxiosInstance,
    objectType: string,
    rangeStart: string,
    rangeEnd: string,
    windowField: "date_created" | "date_updated" = "date_created",
  ): Promise<boolean> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const resp = await api.post("/data/search/", {
          query: {
            negate: false,
            type: "and",
            queries: [
              { negate: false, type: "object_type", object_type: objectType },
              {
                type: "field_condition",
                field: {
                  type: "regular_field",
                  object_type: objectType,
                  field_name: windowField,
                },
                condition: {
                  type: "moment_range",
                  on_or_after: { type: "fixed_utc", value: rangeStart },
                  before: { type: "fixed_utc", value: rangeEnd },
                },
              },
            ],
          },
          _limit: 1,
          _fields: { [objectType]: ["id"] },
        });

        return (resp.data?.data?.length ?? 0) > 0;
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          const retryAfter = parseInt(
            error.response.headers["retry-after"] || "60",
          );
          await this.sleep(retryAfter * 1000);
          continue;
        }
        throw error;
      }
    }
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

    // Groups expose functional-team membership; backfill all pages.
    if (entity === "groups") {
      await this.fetchGroupsChunk({
        ...options,
        maxIterations: Number.MAX_SAFE_INTEGER,
      } as ResumableFetchOptions);
      return;
    }

    // Simple entities (statuses, types) — fetch all via pagination
    if (entity in CloseConnector.SIMPLE_ENTITY_ENDPOINTS) {
      await this.fetchSimpleEntityChunk(entity, options as any);
      return;
    }

    // Activities use the Search API (same as leads/contacts/opportunities)
    if (entity.startsWith("activities:")) {
      await this.fetchViaSearchApi({
        ...options,
        maxIterations: Number.MAX_SAFE_INTEGER,
      });
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
          const endpoint = this.getEntityEndpoint(entity);

          if (since) {
            const dateFilter = since.toISOString().split("T")[0];
            params.date_updated__gte = dateFilter;
            params._order_by = "-date_updated";
          }
          response = await api.get(endpoint, { params });
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

  private static readonly SIMPLE_ENTITY_ENDPOINTS: Record<string, string> = {
    lead_statuses: "/status/lead/",
    opportunity_statuses: "/status/opportunity/",
    custom_activity_types: "/custom_activity/",
    custom_object_types: "/custom_object_type/",
    outcomes: "/outcome/",
  };

  /**
   * Fetch user groups (functional teams). Unlike the SIMPLE_ENTITY_ENDPOINTS,
   * the `/group/` list endpoint only returns `name`/`members` when those
   * fields are explicitly requested via `_fields`, so groups get their own
   * fetcher that always sends the selector.
   */
  private async fetchGroupsChunk(
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
    const batchSize = options.batchSize || this.getBatchSize();
    const rateLimitDelay = options.rateLimitDelay || this.getRateLimitDelay();
    const maxIterations = options.maxIterations || 10;

    let offset = state?.offset || 0;
    let recordCount = state?.totalProcessed || 0;
    let hasMore = true;
    let iterations = 0;

    while (hasMore && iterations < maxIterations) {
      try {
        const response = await api.get("/group/", {
          params: {
            _limit: batchSize,
            _skip: offset,
            // `/group/` omits name/members unless explicitly requested.
            _fields: "id,name,members,organization_id",
          },
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
        case "contacts":
          endpoint = "/contact/";
          break;
        default:
          return undefined;
      }

      const params: any = {
        _limit: 0,
        _fields: "id",
      };
      if (since) {
        params.date_updated__gte = since.toISOString().split("T")[0];
      }
      const response = await api.get(endpoint, { params });

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
    return {
      supported: true,
      // Search-API entities (leads/contacts/opportunities/activities:*) window
      // on `date_updated` when `since` is set. Offset-fallback entities use
      // `date_updated__gte`. Groups / lookup tables without a time filter
      // stay on the connector fallback only when listed below as none.
      mode: "native",
      perEntity: {
        users: { mode: "native", anchorField: "date_updated__gte" },
        custom_fields: { mode: "native", anchorField: "date_updated__gte" },
        leads: { mode: "native", anchorField: "date_updated" },
        contacts: { mode: "native", anchorField: "date_updated" },
        opportunities: { mode: "native", anchorField: "date_updated" },
        groups: { mode: "none" },
        lead_statuses: { mode: "none" },
        opportunity_statuses: { mode: "none" },
        outcomes: { mode: "none" },
        custom_activity_types: { mode: "none" },
        custom_object_types: { mode: "none" },
        custom_objects: { mode: "none" },
      },
    };
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

    const effectiveEvents =
      requestedEvents.length > 0
        ? requestedEvents
        : this.getWebhookEventsForEntities(options.enabledEntities ?? []);

    const normalized = normalizeEventSelectors(effectiveEvents);
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
          try {
            await api.put(`/webhook/${existingId}/`, {
              events: normalized.selectors,
            });
            logger.info(
              "Updated Close webhook events for existing subscription",
              {
                webhookId: existingId,
                eventCount: normalized.selectors.length,
              },
            );
          } catch (updateError) {
            logger.warn("Could not update events on existing Close webhook", {
              webhookId: existingId,
              error: updateError,
            });
          }

          // Close includes `signature_key` on list/get responses. Re-use it so
          // re-provisioning (same URL) still fills Mako's Webhook Secret field —
          // the create-only path is the only place that previously returned it.
          let signingSecret = extractCloseSigningSecret(existing);
          if (!signingSecret) {
            try {
              const detailResponse = await api.get(`/webhook/${existingId}/`);
              signingSecret = extractCloseSigningSecret(detailResponse?.data);
            } catch (detailError) {
              logger.warn(
                "Could not fetch signature_key for existing Close webhook",
                {
                  webhookId: existingId,
                  error: detailError,
                },
              );
            }
          }

          return {
            providerWebhookId: String(existingId),
            endpointUrl: options.endpointUrl,
            signingSecret,
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

      return {
        providerWebhookId: String(providerWebhookId),
        endpointUrl: options.endpointUrl,
        signingSecret: extractCloseSigningSecret(data),
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
      "contact.created": { entity: "contacts", operation: "upsert" },
      "contact.updated": { entity: "contacts", operation: "upsert" },
      "contact.deleted": { entity: "contacts", operation: "delete" },

      // Users — Close emits membership events (not user.*). Keep legacy
      // user.* mappings so any older payloads still route to the users entity.
      "membership.activated": { entity: "users", operation: "upsert" },
      "membership.deactivated": { entity: "users", operation: "delete" },
      "user.created": { entity: "users", operation: "upsert" },
      "user.updated": { entity: "users", operation: "upsert" },
      "user.deleted": { entity: "users", operation: "delete" },

      // Opportunities
      "opportunity.created": { entity: "opportunities", operation: "upsert" },
      "opportunity.updated": { entity: "opportunities", operation: "upsert" },
      "opportunity.deleted": { entity: "opportunities", operation: "delete" },

      // Groups (functional teams). `group.updated` also fires on member add/remove.
      "group.created": { entity: "groups", operation: "upsert" },
      "group.updated": { entity: "groups", operation: "upsert" },
      "group.deleted": { entity: "groups", operation: "delete" },
    };

    if (mappings[eventType]) return mappings[eventType];

    // Activity sub-type events: "activity.note.created" → entity "activities:Note"
    const activityMatch = eventType.match(
      /^activity\.(\w+)\.(created|updated|sent|deleted|answered|completed|scheduled|started|canceled)$/,
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
      /^(custom_activity_type|custom_object_type)\.(created|updated|deleted)$/,
    );
    if (typeMatch) {
      const entityMap: Record<string, string> = {
        custom_activity_type: "custom_activity_types",
        custom_object_type: "custom_object_types",
      };
      return {
        entity: entityMap[typeMatch[1]],
        operation: typeMatch[2] === "deleted" ? "delete" : "upsert",
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
   * Return only the webhook event strings relevant to the given entities.
   * Falls back to all supported events when the entity list is empty
   * (i.e. no explicit selection — sync everything).
   */
  getWebhookEventsForEntities(entities: string[]): string[] {
    if (entities.length === 0) return this.getSupportedWebhookEvents();

    const entitySet = new Set(entities.map(e => e.toLowerCase()));

    const activitySubTypeToObjectType: Record<string, string> = {
      call: "activity.call",
      email: "activity.email",
      emailthread: "activity.email_thread",
      sms: "activity.sms",
      note: "activity.note",
      meeting: "activity.meeting",
      leadstatuschange: "activity.lead_status_change",
      opportunitystatuschange: "activity.opportunity_status_change",
      taskcompleted: "activity.task_completed",
      customactivity: "activity.custom_activity",
    };

    const entityToObjectTypes: Record<string, string[]> = {
      leads: ["lead"],
      contacts: ["contact"],
      users: ["membership"],
      opportunities: ["opportunity"],
      custom_fields: [
        "custom_fields.lead",
        "custom_fields.contact",
        "custom_fields.opportunity",
        "custom_fields.activity",
        "custom_fields.custom_object",
        "custom_fields.shared",
      ],
      custom_activity_types: ["custom_activity_type"],
      custom_object_types: ["custom_object_type"],
      custom_objects: ["custom_object"],
      lead_statuses: ["status.lead"],
      opportunity_statuses: ["status.opportunity"],
      groups: ["group"],
    };

    const relevantObjectTypes = new Set<string>();

    for (const entity of entitySet) {
      if (entity.startsWith("activities:")) {
        const subType = entity.slice("activities:".length).toLowerCase();
        const objType = activitySubTypeToObjectType[subType];
        if (objType) relevantObjectTypes.add(objType);
        continue;
      }

      const mapped = entityToObjectTypes[entity];
      if (mapped) {
        for (const ot of mapped) relevantObjectTypes.add(ot);
      }
    }

    return CLOSE_SUPPORTED_WEBHOOK_SELECTORS.filter(selector =>
      relevantObjectTypes.has(selector.object_type),
    ).map(selector => `${selector.object_type}.${selector.action}`);
  }

  /**
   * Extract entity data from webhook event
   */
  extractWebhookData(event: any): { id: string; data: any } | null {
    // Close webhook payload: {subscription_id, event: {object_type, action, data: {...}}}
    // Prefer object_id from wrapper, then fall back to nested payload ids.
    const innerEvent = event?.event;
    const objectType = innerEvent?.object_type || event?.object_type;
    const data = innerEvent?.data || event?.data;

    // Membership events embed the user record; CDC writes the users entity.
    if (objectType === "membership" && data && typeof data === "object") {
      const embeddedUser =
        data.user && typeof data.user === "object"
          ? data.user
          : data.user_id
            ? { id: data.user_id }
            : null;
      if (embeddedUser) {
        const userId =
          embeddedUser.id || data.user_id || innerEvent?.object_id || event?.id;
        if (userId) {
          return {
            id: String(userId),
            data: { ...embeddedUser, id: String(userId) },
          };
        }
      }
    }

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
      let payload = (record.payload || {}) as Record<string, unknown>;
      if (record.entity === "leads") {
        payload = this.normalizeLeadRecord(payload);
      } else if (
        CloseConnector.CUSTOM_FIELD_FLATTEN_ENTITIES.has(record.entity)
      ) {
        payload = { ...payload };
        CloseConnector.flattenCustomFields(payload);
      }
      return {
        ...record,
        payload,
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

    let payload = (normalized.payload || {}) as Record<string, unknown>;
    if (entity === "leads") {
      payload = this.normalizeLeadRecord(payload);
    } else if (CloseConnector.CUSTOM_FIELD_FLATTEN_ENTITIES.has(entity)) {
      payload = { ...payload };
      CloseConnector.flattenCustomFields(payload);
    }

    return {
      ...normalized,
      payload,
      sourceTs: this.resolveRecordTimestamp(record),
    };
  }
}
