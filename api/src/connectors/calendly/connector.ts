/**
 * The Calendly connector. The class is the public entry point; the work
 * lives in sibling modules:
 *
 * - client.ts   bearer client, API errors, list pages, URI helpers
 * - fetchers.ts organizations, token-paginated lists, invitees walk
 * - webhooks.ts subscriptions, signature verification, CDC records
 */
import type { AxiosInstance } from "axios";
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
import { resolveCalendlyEntitySchema } from "./schema";
import { loggers } from "../../logging";
import { createRetryExecutor } from "../base/http-client";
import {
  CALENDLY_DEFAULT_BASE_URL,
  calendlyRelativePath,
  createCalendlyClient,
  formatCalendlyApiError,
  resolveCalendlyBaseUrl,
  withId,
  type CalendlyContext,
} from "./client";
import {
  fetchCalendlyInviteesChunk,
  fetchCalendlyOrganizationsChunk,
  fetchCalendlySimpleChunk,
  type CalendlySimpleEntity,
} from "./fetchers";
import {
  CALENDLY_SUPPORTED_WEBHOOK_EVENTS,
  calendlyWebhookCdcRecords,
  calendlyWebhookEventMapping,
  calendlyWebhookEventsForEntities,
  extractCalendlyWebhookData,
  provisionCalendlyWebhook,
  verifyCalendlyWebhook,
} from "./webhooks";

const logger = loggers.connector("calendly");

const SUPPORTED_ENTITIES = [
  "organizations",
  "users",
  "groups",
  "event_types",
  "scheduled_events",
  "invitees",
  "contacts",
] as const;

export class CalendlyConnector extends BaseConnector {
  private calendlyApi: AxiosInstance | null = null;
  private cachedOrganizationUri: string | null = null;
  private cachedCurrentUserUri: string | null = null;

  /** Shared policy: backoff with jitter, Retry-After, 429/5xx/network. */
  private readonly executeWithRetry = createRetryExecutor({
    label: "Calendly",
    logger,
    sleep: ms => this.sleep(ms),
    formatError: formatCalendlyApiError,
  });

  static getConfigSchema() {
    return {
      fields: [
        {
          name: "access_token",
          label: "Personal Access Token",
          type: "password",
          required: true,
          helperText:
            "Calendly PAT or OAuth bearer token. Required scopes: organizations:read, users:read, groups:read, event_types:read, scheduled_events:read, contacts:read. For auto-provisioned webhooks also: webhooks:read and webhooks:write.",
        },
        {
          name: "api_base_url",
          label: "API Base URL",
          type: "string",
          required: false,
          default: CALENDLY_DEFAULT_BASE_URL,
        },
      ],
    };
  }

  getMetadata() {
    return {
      name: "Calendly",
      version: "1.0.0",
      description:
        "Connector for Calendly scheduling: organizations, users, groups, event_types, scheduled_events, invitees, contacts. Real-time invitee + event_type webhooks; scheduled backfill picks up everything else.",
      supportedEntities: [...SUPPORTED_ENTITIES],
    };
  }

  validateConfig() {
    const base = super.validateConfig();
    const errors = [...base.errors];

    if (!this.sourceConnection.config.access_token) {
      errors.push("Calendly access token is required");
    }

    return { valid: errors.length === 0, errors };
  }

  private getBaseUrl(): string {
    return resolveCalendlyBaseUrl(this.sourceConnection.config.api_base_url);
  }

  private toRelativePath(uri: string): string {
    return calendlyRelativePath(this.context(), uri);
  }

  private getClient(): AxiosInstance {
    if (!this.calendlyApi) {
      if (!this.sourceConnection.config.access_token) {
        throw new Error("Calendly access token not configured");
      }
      this.calendlyApi = createCalendlyClient(
        this.getBaseUrl(),
        this.sourceConnection.config.access_token,
      );
    }
    return this.calendlyApi;
  }

  private async getCurrentUser(): Promise<{
    user_uri: string;
    organization_uri: string;
  }> {
    if (this.cachedOrganizationUri && this.cachedCurrentUserUri) {
      return {
        user_uri: this.cachedCurrentUserUri,
        organization_uri: this.cachedOrganizationUri,
      };
    }
    const api = this.getClient();
    const response = await this.executeWithRetry(() => api.get("/users/me"));
    const resource = (response.data as { resource?: Record<string, unknown> })
      ?.resource;
    const userUri =
      typeof resource?.uri === "string" ? (resource.uri as string) : "";
    const orgUri =
      typeof resource?.current_organization === "string"
        ? (resource.current_organization as string)
        : "";
    if (!userUri || !orgUri) {
      throw new Error(
        "Could not resolve current user/organization from /users/me",
      );
    }
    this.cachedCurrentUserUri = userUri;
    this.cachedOrganizationUri = orgUri;
    return { user_uri: userUri, organization_uri: orgUri };
  }

  /** What the fetch and webhook modules read, always late-bound. */
  private context(): CalendlyContext {
    return {
      api: () => this.getClient(),
      execute: (fn, maxRetries) => this.executeWithRetry(fn, maxRetries),
      sleep: ms => this.sleep(ms),
      batchSize: () => this.getBatchSize(),
      rateLimitDelay: () => this.getRateLimitDelay(),
      baseUrl: () => this.getBaseUrl(),
      currentUser: () => this.getCurrentUser(),
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

      const { organization_uri } = await this.getCurrentUser();

      return {
        success: true,
        message: "Successfully connected to Calendly API",
        details: { organization: organization_uri },
      };
    } catch (error) {
      return {
        success: false,
        message: "Failed to connect to Calendly API",
        details: formatCalendlyApiError(error),
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
        name: "organizations",
        label: "Organizations",
        description: "Calendly organization(s) the token has access to",
        layoutSuggestion: layout("created_at"),
      },
      {
        name: "users",
        label: "Users (org memberships)",
        description:
          "Members of the organization with embedded user information",
        layoutSuggestion: layout("created_at"),
      },
      {
        name: "groups",
        label: "Groups",
        description: "Calendly groups within the organization",
        layoutSuggestion: layout("created_at"),
      },
      {
        name: "event_types",
        label: "Event Types",
        description: "Bookable event types",
        layoutSuggestion: layout("created_at"),
      },
      {
        name: "scheduled_events",
        label: "Scheduled Events",
        description: "Booked meetings on the organization calendar",
        layoutSuggestion: layout("start_time"),
      },
      {
        name: "invitees",
        label: "Invitees",
        description: "People booked on scheduled events (nested fetch)",
        layoutSuggestion: layout("created_at"),
      },
      {
        name: "contacts",
        label: "Contacts",
        description: "Calendly contacts directory",
        layoutSuggestion: layout("created_at"),
      },
    ];
  }

  async resolveSchema(entity: string): Promise<ConnectorEntitySchema | null> {
    return resolveCalendlyEntitySchema(entity);
  }

  supportsResumableFetching(): boolean {
    return true;
  }

  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    const { entity } = options;
    const ctx = this.context();

    if (entity === "organizations") {
      return fetchCalendlyOrganizationsChunk(ctx, options);
    }

    if (entity === "invitees") {
      return fetchCalendlyInviteesChunk(ctx, options);
    }

    if ((SUPPORTED_ENTITIES as readonly string[]).includes(entity)) {
      return fetchCalendlySimpleChunk(
        ctx,
        options,
        entity as CalendlySimpleEntity,
      );
    }

    throw new Error(`Unsupported entity for Calendly connector: ${entity}`);
  }

  async fetchEntity(options: FetchOptions): Promise<void> {
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
        providerLabel: "Calendly",
        storesSecretAutomatically: true,
      },
      secretHelpText: "Enter the webhook signing secret from your provider",
    };
  }

  getIncrementalCapabilities(): IncrementalCapabilities {
    return {
      supported: true,
      // `organizations` is a single fixed-shape fetch with no time filter.
      mode: "none",
      perEntity: {
        // `min_start_time` filters on the event's start time, not on when
        // it was last modified — an event edited after being scheduled in
        // the past is never re-fetched by a poll.
        scheduled_events: {
          mode: "created-anchor",
          anchorField: "min_start_time",
        },
        groups: { mode: "client-filter", anchorField: "updated_at" },
        event_types: { mode: "client-filter", anchorField: "updated_at" },
        contacts: { mode: "client-filter", anchorField: "updated_at" },
        users: { mode: "client-filter", anchorField: "updated_at" },
      },
      warning:
        "Calendly events are matched by scheduled start time, not last edit; changes to already-scheduled events require the webhook trigger.",
    };
  }

  async createWebhookSubscription(
    options: ProvisionWebhookOptions,
  ): Promise<ProvisionWebhookResult> {
    return provisionCalendlyWebhook(this.context(), options, entities =>
      this.getWebhookEventsForEntities(entities),
    );
  }

  async verifyWebhook(
    options: WebhookHandlerOptions,
  ): Promise<WebhookVerificationResult> {
    return verifyCalendlyWebhook(options);
  }

  getWebhookEventMapping(eventType: string): WebhookEventMapping | null {
    return calendlyWebhookEventMapping(eventType);
  }

  getSupportedWebhookEvents(): string[] {
    return [...CALENDLY_SUPPORTED_WEBHOOK_EVENTS];
  }

  getWebhookEventsForEntities(entities: string[]): string[] {
    return calendlyWebhookEventsForEntities(entities);
  }

  extractWebhookData(
    event: unknown,
  ): { id: string; data: Record<string, unknown> } | null {
    return extractCalendlyWebhookData(event);
  }

  extractWebhookCdcRecords(
    event: unknown,
    eventType?: string,
  ): NormalizedCdcRecord[] {
    return calendlyWebhookCdcRecords(event, eventType, payload =>
      this.resolveRecordTimestamp(payload),
    );
  }

  normalizeBackfillRecord(
    entity: string,
    record: Record<string, unknown>,
  ): NormalizedCdcRecord | null {
    const enriched = withId(record);
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
