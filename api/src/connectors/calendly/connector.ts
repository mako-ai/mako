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
  type ConnectorEntitySchema,
  type IncrementalCapabilities,
} from "../base/BaseConnector";
import { resolveCalendlyEntitySchema } from "./schema";
import { loggers } from "../../logging";

const logger = loggers.connector("calendly");

const DEFAULT_BASE_URL = "https://api.calendly.com";
const MAX_PAGE_LIMIT = 100;
const WEBHOOK_MAX_SKEW_SECONDS = 3 * 60;
// Number of scheduled_events whose invitees we fetch concurrently per wave.
// Kept small so executeWithRetry's 429 backoff stays effective.
const INVITEES_CONCURRENCY = 8;

const SUPPORTED_WEBHOOK_EVENTS = [
  "invitee.created",
  "invitee.canceled",
  "invitee_no_show.created",
  "event_type.created",
  "event_type.updated",
] as const;

type SupportedWebhookEvent = (typeof SUPPORTED_WEBHOOK_EVENTS)[number];

const SUPPORTED_ENTITIES = [
  "organizations",
  "users",
  "groups",
  "event_types",
  "scheduled_events",
  "invitees",
  "contacts",
] as const;

type CalendlyPagination = {
  next_page_token?: string | null;
  count?: number;
};

type CalendlyListResponse<T = Record<string, unknown>> = {
  collection: T[];
  pagination: CalendlyPagination;
};

type SimpleEntity =
  | "users"
  | "groups"
  | "event_types"
  | "scheduled_events"
  | "contacts";

const SIMPLE_ENTITY_PATH: Record<SimpleEntity, string> = {
  users: "/organization_memberships",
  groups: "/groups",
  event_types: "/event_types",
  scheduled_events: "/scheduled_events",
  contacts: "/contacts",
};

const SIMPLE_ENTITY_NEEDS_ORG: Record<SimpleEntity, boolean> = {
  users: true,
  groups: true,
  event_types: true,
  scheduled_events: true,
  contacts: false,
};

function uuidFromUri(uri: unknown): string {
  if (typeof uri !== "string" || uri.length === 0) return "";
  const trimmed = uri.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function withId(record: Record<string, unknown>): Record<string, unknown> {
  if (record == null) return record;
  if (typeof record.id === "string" && record.id.length > 0) return record;
  const id = uuidFromUri(record.uri);
  return id ? { ...record, id } : record;
}

function flattenMembership(
  membership: Record<string, unknown>,
): Record<string, unknown> {
  const user =
    membership.user && typeof membership.user === "object"
      ? (membership.user as Record<string, unknown>)
      : undefined;
  return withId({
    ...membership,
    user_uri: user?.uri ?? null,
    user_email: user?.email ?? null,
    user_name: user?.name ?? null,
    user_slug: user?.slug ?? null,
    user_timezone: user?.timezone ?? null,
    user_scheduling_url: user?.scheduling_url ?? null,
    user_avatar_url: user?.avatar_url ?? null,
    user_locale: user?.locale ?? null,
  });
}

function formatCalendlyApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data as
      | {
          message?: string;
          title?: string;
          details?: Array<{ message?: string; parameter?: string }>;
        }
      | string
      | undefined;

    const direct =
      typeof data === "string"
        ? data
        : typeof data?.message === "string"
          ? data.message
          : typeof data?.title === "string"
            ? data.title
            : undefined;

    const details = Array.isArray((data as { details?: unknown[] })?.details)
      ? (
          data as { details: Array<{ message?: string; parameter?: string }> }
        ).details
          .map(d => `${d.parameter ?? "?"}: ${d.message ?? "?"}`)
          .join("; ")
      : undefined;

    const detail = [direct, details].filter(Boolean).join(" — ");
    const fallback = error.message;
    return status
      ? `HTTP ${status}: ${detail || fallback}`
      : detail || fallback;
  }

  return error instanceof Error ? error.message : String(error);
}

export class CalendlyConnector extends BaseConnector {
  private calendlyApi: AxiosInstance | null = null;
  private cachedOrganizationUri: string | null = null;
  private cachedCurrentUserUri: string | null = null;

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
          default: DEFAULT_BASE_URL,
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

    if (!this.dataSource.config.access_token) {
      errors.push("Calendly access token is required");
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

  private toRelativePath(uri: string): string {
    const base = this.getBaseUrl();
    if (!uri.startsWith(`${base}/`)) {
      throw new Error(
        `Refusing to call non-Calendly URL returned by API (expected base ${base})`,
      );
    }
    return uri.slice(base.length);
  }

  private getClient(): AxiosInstance {
    if (!this.calendlyApi) {
      if (!this.dataSource.config.access_token) {
        throw new Error("Calendly access token not configured");
      }

      this.calendlyApi = axios.create({
        baseURL: this.getBaseUrl(),
        headers: {
          Authorization: `Bearer ${this.dataSource.config.access_token}`,
          "Content-Type": "application/json",
        },
      });
    }
    return this.calendlyApi;
  }

  private headerValue(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string | undefined {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== lower) continue;
      if (Array.isArray(value)) return value[0];
      return value;
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
          // Surface Calendly's actual error body (parameter + message) instead
          // of the opaque "Request failed with status code 400". Keep it an
          // axios error so callers can still inspect error.response.status.
          if (axios.isAxiosError(error)) {
            error.message = formatCalendlyApiError(error);
          }
          throw error;
        }

        const retryAfterHeader = axiosError.response?.headers?.["retry-after"];
        const retryAfterSeconds = parseInt(String(retryAfterHeader ?? "1"), 10);
        const delayMs = Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds * 1000
          : Math.min(1000 * 2 ** attempt, 60_000);

        logger.warn("Calendly API rate limited or server error, retrying", {
          status,
          attempt: attempt + 1,
          delayMs,
        });
        await this.sleep(delayMs);
        attempt++;
      }
    }
  }

  // Calendly requires count in [1, 100]. `batchSize ?? getBatchSize()` is not
  // enough because `??` lets a 0 through, which Calendly rejects with a 400.
  private resolvePageCount(batchSize?: number): number {
    const requested =
      typeof batchSize === "number" && batchSize > 0
        ? batchSize
        : this.getBatchSize();
    return Math.min(Math.max(requested, 1), MAX_PAGE_LIMIT);
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

  private async fetchPage<T = Record<string, unknown>>(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<CalendlyListResponse<T>> {
    const api = this.getClient();
    const cleaned: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value == null) continue;
      cleaned[key] = value;
    }
    const response = await this.executeWithRetry(() =>
      api.get(path, { params: cleaned }),
    );
    const data = response.data as Partial<CalendlyListResponse<T>>;
    return {
      collection: Array.isArray(data.collection) ? data.collection : [],
      pagination: data.pagination ?? {},
    };
  }

  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    const { entity } = options;

    if (entity === "organizations") {
      return this.fetchOrganizationsChunk(options);
    }

    if (entity === "invitees") {
      return this.fetchInviteesChunk(options);
    }

    if ((SUPPORTED_ENTITIES as readonly string[]).includes(entity)) {
      return this.fetchSimpleChunk(options, entity as SimpleEntity);
    }

    throw new Error(`Unsupported entity for Calendly connector: ${entity}`);
  }

  private async fetchOrganizationsChunk(
    options: ResumableFetchOptions,
  ): Promise<FetchState> {
    const { state } = options;
    if (state && state.totalProcessed > 0) {
      return {
        totalProcessed: state.totalProcessed,
        hasMore: false,
        iterationsInChunk: 0,
      };
    }

    const { organization_uri } = await this.getCurrentUser();
    const api = this.getClient();
    const response = await this.executeWithRetry(() =>
      api.get(this.toRelativePath(organization_uri)),
    );
    const resource = (response.data as { resource?: Record<string, unknown> })
      ?.resource;
    if (!resource) {
      return { totalProcessed: 0, hasMore: false, iterationsInChunk: 1 };
    }

    await options.onBatch([withId(resource)]);
    options.onProgress?.(1, 1);

    return { totalProcessed: 1, hasMore: false, iterationsInChunk: 1 };
  }

  private async fetchSimpleChunk(
    options: ResumableFetchOptions,
    entity: SimpleEntity,
  ): Promise<FetchState> {
    const { onBatch, onProgress, since, state, batchSize } = options;
    const maxIterations = options.maxIterations ?? 10;

    let cursor = (state?.metadata?.cursor as string | undefined) ?? undefined;
    let recordCount = state?.totalProcessed ?? 0;
    let iterations = 0;

    const path = SIMPLE_ENTITY_PATH[entity];
    const needsOrg = SIMPLE_ENTITY_NEEDS_ORG[entity];
    const organization = needsOrg
      ? (await this.getCurrentUser()).organization_uri
      : undefined;

    while (iterations < maxIterations) {
      const params: Record<string, string | number | undefined> = {
        count: this.resolvePageCount(batchSize),
        page_token: cursor,
        organization,
      };

      if (entity === "scheduled_events") {
        // Calendly only supports sorting scheduled_events by start_time.
        params.sort = "start_time:asc";
        if (since instanceof Date) {
          params.min_start_time = since.toISOString();
        }
      } else if (entity === "event_types") {
        // Calendly only reliably supports sorting event_types by name.
        params.sort = "name:asc";
      }

      const page = await this.fetchPage(path, params);

      let records = page.collection.map(item =>
        withId(item as Record<string, unknown>),
      );

      if (entity === "users") {
        records = records.map(item => flattenMembership(item));
      }

      if (
        since instanceof Date &&
        (entity === "groups" ||
          entity === "event_types" ||
          entity === "contacts" ||
          entity === "users")
      ) {
        const sinceMs = since.getTime();
        records = records.filter(item => {
          const updated =
            typeof item.updated_at === "string"
              ? new Date(item.updated_at).getTime()
              : NaN;
          return Number.isFinite(updated) ? updated >= sinceMs : true;
        });
      }

      if (records.length > 0) {
        await onBatch(records);
        recordCount += records.length;
        onProgress?.(recordCount, undefined);
      }

      cursor = page.pagination.next_page_token ?? undefined;
      iterations++;

      if (!cursor) {
        return {
          totalProcessed: recordCount,
          hasMore: false,
          iterationsInChunk: iterations,
          metadata: { cursor: null },
        };
      }

      await this.sleep(options.rateLimitDelay ?? this.getRateLimitDelay());
    }

    return {
      totalProcessed: recordCount,
      hasMore: true,
      iterationsInChunk: iterations,
      metadata: { cursor },
    };
  }

  private async fetchInviteesChunk(
    options: ResumableFetchOptions,
  ): Promise<FetchState> {
    const { onBatch, onProgress, since, state } = options;
    const maxIterations = options.maxIterations ?? 10;

    // Keyset pagination over /scheduled_events by start_time, instead of the
    // opaque page_token. Calendly re-anchors next_page_token on every call, so a
    // token parked while we drain a page's invitees becomes invalid by the time
    // we redeem it. min_start_time + sort=start_time:asc is stable and
    // resume-safe.
    let eventsMinStart =
      (state?.metadata?.eventsMinStart as string | undefined) ??
      (since instanceof Date ? since.toISOString() : undefined);
    // URIs of events at exactly eventsMinStart already queued. min_start_time is
    // inclusive, so these reappear on the next page and must be skipped.
    let eventsBoundaryUris =
      (state?.metadata?.eventsBoundaryUris as string[] | undefined) ?? [];
    let eventsDone =
      (state?.metadata?.eventsDone as boolean | undefined) ?? false;
    // Normalize pendingEvents: current shape is { uri, total, start_time }, but
    // legacy in-flight checkpoints stored a plain string[] or { uri, total }.
    // Accept all so a backfill mid-flight across a deploy doesn't break.
    let pendingEvents: {
      uri: string;
      total?: number;
      start_time?: string;
    }[] = (
      (state?.metadata?.pendingEvents as
        | (string | { uri: string; total?: number; start_time?: string })[]
        | undefined) ?? []
    ).map(ev => (typeof ev === "string" ? { uri: ev } : ev));
    // Legacy state may have an in-progress event; requeue it (full re-drain).
    const legacyEventUri = state?.metadata?.currentEventUri as
      | string
      | undefined;
    if (legacyEventUri) {
      pendingEvents = [{ uri: legacyEventUri }, ...pendingEvents];
    }
    let recordCount = state?.totalProcessed ?? 0;
    let iterations = 0;

    const { organization_uri } = await this.getCurrentUser();
    const api = this.getClient();

    const fetchInviteesPage = async (
      eventUri: string,
      cursor: string | undefined,
    ): Promise<CalendlyListResponse> => {
      const path = `${this.toRelativePath(eventUri)}/invitees`;
      const params: Record<string, string | number> = {
        count: this.resolvePageCount(options.batchSize),
      };
      if (cursor) params.page_token = cursor;
      const response = await this.executeWithRetry(() =>
        api.get(path, { params }),
      );
      const data = response.data as Partial<CalendlyListResponse>;
      return {
        collection: Array.isArray(data.collection) ? data.collection : [],
        pagination: data.pagination ?? {},
      };
    };

    const loadMoreEvents = async (): Promise<void> => {
      const params: Record<string, string | number | undefined> = {
        count: MAX_PAGE_LIMIT,
        organization: organization_uri,
        // Calendly only supports sorting scheduled_events by start_time.
        sort: "start_time:asc",
      };
      if (eventsMinStart) {
        params.min_start_time = eventsMinStart;
      }
      const page = await this.fetchPage("/scheduled_events", params);
      const base = this.getBaseUrl();
      const pageEvents: { uri: string; total?: number; start_time?: string }[] =
        [];
      for (const item of page.collection) {
        const uri =
          typeof (item as { uri?: unknown }).uri === "string"
            ? (item as { uri: string }).uri
            : "";
        if (!uri) continue;
        if (!uri.startsWith(`${base}/`)) {
          logger.warn("Dropping scheduled_event with foreign URI", {
            base,
          });
          continue;
        }
        const counter = (item as { invitees_counter?: { total?: unknown } })
          .invitees_counter;
        const total =
          typeof counter?.total === "number" ? counter.total : undefined;
        const startTime =
          typeof (item as { start_time?: unknown }).start_time === "string"
            ? (item as { start_time: string }).start_time
            : undefined;
        pageEvents.push({ uri, total, start_time: startTime });
      }

      // Skip boundary events already queued from the previous page (inclusive
      // min_start_time re-returns them).
      const boundary = new Set(eventsBoundaryUris);
      const fresh = pageEvents.filter(ev => !boundary.has(ev.uri));
      pendingEvents = [...pendingEvents, ...fresh];

      // Last page (short read) means the listing is exhausted.
      if (page.collection.length < MAX_PAGE_LIMIT) {
        eventsDone = true;
        return;
      }

      // Advance the keyset to the max start_time on this page.
      let maxStart: string | undefined;
      for (const ev of pageEvents) {
        if (ev.start_time && (!maxStart || ev.start_time > maxStart)) {
          maxStart = ev.start_time;
        }
      }
      if (!maxStart) {
        // Cannot key off start_time (shouldn't happen for real events). Stop
        // rather than risk an infinite loop.
        eventsDone = true;
        return;
      }
      if (maxStart !== eventsMinStart) {
        eventsMinStart = maxStart;
        eventsBoundaryUris = pageEvents
          .filter(ev => ev.start_time === maxStart)
          .map(ev => ev.uri);
      } else {
        // Whole page shares the boundary start_time (>100 events at the same
        // instant). Nudge +1ms to guarantee forward progress; same-ms overflow
        // beyond a page is negligible for real calendars.
        eventsMinStart = new Date(
          new Date(maxStart).getTime() + 1,
        ).toISOString();
        eventsBoundaryUris = [];
      }
    };

    // Fetch every invitee page for a single event (most events are 1 page).
    // A single event that Calendly rejects (e.g. deleted/canceled event ->
    // 400/404) must not kill the whole concurrent wave / backfill: skip it and
    // log. Anything else (auth, 429-exhausted, 5xx) still propagates.
    const drainInvitees = async (
      eventUri: string,
    ): Promise<Record<string, unknown>[]> => {
      const records: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      do {
        let page: CalendlyListResponse;
        try {
          page = await fetchInviteesPage(eventUri, cursor);
        } catch (error) {
          const status = axios.isAxiosError(error)
            ? error.response?.status
            : undefined;
          if (status === 400 || status === 404) {
            logger.warn("Skipping invitees for unreadable scheduled_event", {
              event: this.toRelativePath(eventUri),
              detail: formatCalendlyApiError(error),
            });
            return records;
          }
          throw error;
        }
        for (const item of page.collection) {
          records.push(withId(item as Record<string, unknown>));
        }
        cursor = page.pagination.next_page_token ?? undefined;
      } while (cursor);
      return records;
    };

    const finished = (): FetchState => ({
      totalProcessed: recordCount,
      hasMore: false,
      iterationsInChunk: iterations,
      metadata: {
        eventsMinStart: null,
        eventsBoundaryUris: [],
        eventsDone: true,
        pendingEvents: [],
      },
    });

    while (iterations < maxIterations) {
      if (pendingEvents.length === 0) {
        if (eventsDone) {
          return finished();
        }
        await loadMoreEvents();
        iterations++;
        if (pendingEvents.length === 0 && eventsDone) {
          return finished();
        }
        continue;
      }

      // Take a wave, skipping events known to have zero invitees (no API call).
      const wave: string[] = [];
      while (wave.length < INVITEES_CONCURRENCY && pendingEvents.length > 0) {
        const ev = pendingEvents.shift() as { uri: string; total?: number };
        if (ev.total === 0) continue;
        wave.push(ev.uri);
      }
      if (wave.length === 0) continue;

      const results = await Promise.all(wave.map(uri => drainInvitees(uri)));
      iterations += wave.length;

      const records = results.flat();
      if (records.length > 0) {
        await onBatch(records);
        recordCount += records.length;
        onProgress?.(recordCount, undefined);
      }
    }

    const exhausted = pendingEvents.length === 0 && eventsDone;

    return {
      totalProcessed: recordCount,
      hasMore: !exhausted,
      iterationsInChunk: iterations,
      metadata: exhausted
        ? {
            eventsMinStart: null,
            eventsBoundaryUris: [],
            eventsDone: true,
            pendingEvents: [],
          }
        : {
            eventsMinStart: eventsMinStart ?? null,
            eventsBoundaryUris,
            eventsDone,
            pendingEvents,
          },
    };
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
    const api = this.getClient();
    const { organization_uri } = await this.getCurrentUser();

    const requestedEvents = Array.isArray(options.events)
      ? options.events
          .map(event => event.trim())
          .filter(event => event.length > 0)
      : [];

    const effectiveEvents =
      requestedEvents.length > 0
        ? requestedEvents
        : this.getWebhookEventsForEntities(options.enabledEntities ?? []);

    const events = effectiveEvents.filter(event =>
      (SUPPORTED_WEBHOOK_EVENTS as readonly string[]).includes(event),
    );

    if (events.length === 0) {
      throw new Error(
        requestedEvents.length > 0
          ? `No valid Calendly webhook events configured. Calendly only emits: ${SUPPORTED_WEBHOOK_EVENTS.join(", ")}`
          : "No webhook events resolved for the selected entities",
      );
    }

    const payload = {
      url: options.endpointUrl,
      events,
      organization: organization_uri,
      scope: "organization",
    };

    try {
      const response = await this.executeWithRetry(() =>
        api.post("/webhook_subscriptions", payload),
      );
      const resource = (response.data as { resource?: Record<string, unknown> })
        ?.resource;
      const providerWebhookId =
        uuidFromUri(resource?.uri) || String(resource?.uri ?? "");
      if (!providerWebhookId) {
        throw new Error(
          "Calendly webhook created but no subscription URI returned by API",
        );
      }
      const signingSecret =
        typeof resource?.signing_key === "string"
          ? (resource.signing_key as string)
          : undefined;
      return {
        providerWebhookId,
        endpointUrl: options.endpointUrl,
        signingSecret,
      };
    } catch (error) {
      throw new Error(
        `Failed to create Calendly webhook subscription: ${formatCalendlyApiError(error)}`,
      );
    }
  }

  async verifyWebhook(
    options: WebhookHandlerOptions,
  ): Promise<WebhookVerificationResult> {
    const { payload, headers, secret } = options;

    if (!secret) {
      return { valid: false, error: "Missing webhook secret on flow" };
    }

    const sigHeader = this.headerValue(headers, "Calendly-Webhook-Signature");
    if (!sigHeader) {
      return {
        valid: false,
        error: "Missing Calendly-Webhook-Signature header",
      };
    }

    const parts = sigHeader
      .split(",")
      .reduce<Record<string, string>>((acc, part) => {
        const [k, v] = part.split("=");
        if (k && v) acc[k.trim()] = v.trim();
        return acc;
      }, {});

    const t = parts.t;
    const v1 = parts.v1;
    if (!t || !v1) {
      return {
        valid: false,
        error: "Malformed Calendly-Webhook-Signature header",
      };
    }

    const ts = Number.parseInt(t, 10);
    if (!Number.isFinite(ts)) {
      return {
        valid: false,
        error: "Malformed Calendly-Webhook-Signature header",
      };
    }
    const skewSeconds = Math.abs(Date.now() / 1000 - ts);
    if (skewSeconds > WEBHOOK_MAX_SKEW_SECONDS) {
      return { valid: false, error: "Stale webhook timestamp" };
    }

    try {
      const body =
        typeof payload === "string" ? payload : JSON.stringify(payload);
      const expected = crypto
        .createHmac("sha256", secret)
        .update(`${t}.${body}`, "utf8")
        .digest("hex");

      const expectedBuf = Buffer.from(expected, "hex");
      const providedBuf = Buffer.from(v1, "hex");
      if (
        expectedBuf.length !== providedBuf.length ||
        !crypto.timingSafeEqual(expectedBuf, providedBuf)
      ) {
        return { valid: false, error: "Invalid signature" };
      }

      const parsed =
        typeof payload === "string" ? JSON.parse(payload) : payload;

      const eventType =
        typeof parsed?.event === "string" ? parsed.event : undefined;
      const resourceUri =
        typeof parsed?.payload?.uri === "string"
          ? parsed.payload.uri
          : undefined;

      return {
        valid: true,
        event: {
          ...parsed,
          type: eventType,
          id: resourceUri
            ? `${parsed?.created_at ?? ""}:${resourceUri}`
            : undefined,
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
    const mappings: Record<string, WebhookEventMapping> = {
      "invitee.created": { entity: "invitees", operation: "upsert" },
      "invitee.canceled": { entity: "invitees", operation: "upsert" },
      "invitee_no_show.created": { entity: "invitees", operation: "upsert" },
      "event_type.created": { entity: "event_types", operation: "upsert" },
      "event_type.updated": { entity: "event_types", operation: "upsert" },
    };
    return mappings[eventType] ?? null;
  }

  getSupportedWebhookEvents(): string[] {
    return [...SUPPORTED_WEBHOOK_EVENTS];
  }

  getWebhookEventsForEntities(entities: string[]): string[] {
    if (entities.length === 0) return this.getSupportedWebhookEvents();
    const normalized = new Set(entities.map(e => e.toLowerCase()));
    const events = new Set<SupportedWebhookEvent>();

    if (normalized.has("invitees")) {
      events.add("invitee.created");
      events.add("invitee.canceled");
      events.add("invitee_no_show.created");
    }
    if (normalized.has("scheduled_events")) {
      events.add("invitee.created");
      events.add("invitee.canceled");
    }
    if (normalized.has("event_types")) {
      events.add("event_type.created");
      events.add("event_type.updated");
    }

    return Array.from(events);
  }

  extractWebhookData(
    event: unknown,
  ): { id: string; data: Record<string, unknown> } | null {
    const evt = event as { payload?: Record<string, unknown> } | undefined;
    const payload = evt?.payload;
    if (!payload || typeof payload !== "object") return null;
    const id = uuidFromUri(payload.uri);
    if (!id) return null;
    return { id, data: withId(payload) };
  }

  extractWebhookCdcRecords(
    event: unknown,
    eventType?: string,
  ): NormalizedCdcRecord[] {
    const resolvedType =
      eventType ||
      (typeof (event as { type?: string })?.type === "string"
        ? (event as { type: string }).type
        : typeof (event as { event?: string })?.event === "string"
          ? (event as { event: string }).event
          : undefined);

    if (!resolvedType) return [];

    const rootCreatedAt =
      typeof (event as { created_at?: string })?.created_at === "string"
        ? (event as { created_at: string }).created_at
        : undefined;

    const payload =
      (event as { payload?: Record<string, unknown> })?.payload ?? undefined;
    if (!payload || typeof payload !== "object") return [];

    const buildChangeId = (uri: string): string =>
      `${rootCreatedAt ?? resolvedType}:${uri}`;

    const records: NormalizedCdcRecord[] = [];

    if (
      resolvedType === "invitee.created" ||
      resolvedType === "invitee.canceled" ||
      resolvedType === "invitee_no_show.created"
    ) {
      const inviteeUri =
        typeof payload.uri === "string" ? payload.uri : undefined;
      if (inviteeUri) {
        records.push({
          entity: "invitees",
          recordId: uuidFromUri(inviteeUri),
          operation: "upsert",
          payload: withId(payload),
          sourceTs: this.resolveRecordTimestamp(payload),
          source: "webhook",
          changeId: buildChangeId(inviteeUri),
        });
      }

      const scheduledEvent =
        payload.scheduled_event && typeof payload.scheduled_event === "object"
          ? (payload.scheduled_event as Record<string, unknown>)
          : undefined;
      const scheduledEventUri =
        typeof scheduledEvent?.uri === "string"
          ? (scheduledEvent.uri as string)
          : undefined;
      if (scheduledEvent && scheduledEventUri) {
        records.push({
          entity: "scheduled_events",
          recordId: uuidFromUri(scheduledEventUri),
          operation: "upsert",
          payload: withId(scheduledEvent),
          sourceTs: this.resolveRecordTimestamp(scheduledEvent),
          source: "webhook",
          changeId: buildChangeId(scheduledEventUri),
        });
      }

      return records;
    }

    if (
      resolvedType === "event_type.created" ||
      resolvedType === "event_type.updated"
    ) {
      const uri = typeof payload.uri === "string" ? payload.uri : undefined;
      if (!uri) return [];
      records.push({
        entity: "event_types",
        recordId: uuidFromUri(uri),
        operation: "upsert",
        payload: withId(payload),
        sourceTs: this.resolveRecordTimestamp(payload),
        source: "webhook",
        changeId: buildChangeId(uri),
      });
      return records;
    }

    return [];
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
