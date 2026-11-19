/**
 * Calendly webhook provisioning for boxed (`ws:`) flows: the
 * organization-scoped `/webhook_subscriptions` create call, run in the API
 * process so the signing key never reaches a box. Moved 1:1 from the
 * built-in connector.
 */
import axios, { AxiosInstance } from "axios";
import type {
  ProvisionWebhookOptions,
  ProvisionWebhookResult,
} from "../connectors/base/BaseConnector";
import {
  createRetryExecutor,
  formatHttpApiError,
  type RetryExecutor,
} from "../connectors/base/http-client";
import { loggers } from "../logging";

const logger = loggers.connector("calendly");

const CALENDLY_DEFAULT_BASE_URL = "https://api.calendly.com";

/** What the create call reads from the connection. */
export interface CalendlyContext {
  api(): AxiosInstance;
  execute: RetryExecutor;
  /** The token's user and organization URIs (cached). */
  currentUser(): Promise<{ user_uri: string; organization_uri: string }>;
}

export const CALENDLY_SUPPORTED_WEBHOOK_EVENTS = [
  "invitee.created",
  "invitee.canceled",
  "invitee_no_show.created",
  "event_type.created",
  "event_type.updated",
] as const;

type SupportedWebhookEvent = (typeof CALENDLY_SUPPORTED_WEBHOOK_EVENTS)[number];

export function calendlyWebhookEventsForEntities(entities: string[]): string[] {
  if (entities.length === 0) return [...CALENDLY_SUPPORTED_WEBHOOK_EVENTS];
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

function uuidFromUri(uri: unknown): string {
  if (typeof uri !== "string" || uri.length === 0) return "";
  const trimmed = uri.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

type CalendlyErrorBody = {
  message?: string;
  title?: string;
  details?: Array<{ message?: string; parameter?: string }>;
};

function describeCalendlyErrorBody(raw: unknown): string | undefined {
  const data = raw as CalendlyErrorBody | string | undefined;

  const direct =
    typeof data === "string"
      ? data
      : typeof data?.message === "string"
        ? data.message
        : typeof data?.title === "string"
          ? data.title
          : undefined;

  const details = Array.isArray((data as { details?: unknown[] })?.details)
    ? (data as Required<Pick<CalendlyErrorBody, "details">>).details
        .map(d => `${d.parameter ?? "?"}: ${d.message ?? "?"}`)
        .join("; ")
    : undefined;

  return [direct, details].filter(Boolean).join(" — ");
}

function formatCalendlyApiError(error: unknown): string {
  return formatHttpApiError(error, describeCalendlyErrorBody);
}

/** Create the organization-scoped subscription for the flow URL. */
export async function provisionCalendlyWebhook(
  ctx: CalendlyContext,
  options: ProvisionWebhookOptions,
  eventsForEntities: (entities: string[]) => string[],
): Promise<ProvisionWebhookResult> {
  const api = ctx.api();
  const { organization_uri } = await ctx.currentUser();

  const requestedEvents = Array.isArray(options.events)
    ? options.events
        .map(event => event.trim())
        .filter(event => event.length > 0)
    : [];

  const effectiveEvents =
    requestedEvents.length > 0
      ? requestedEvents
      : eventsForEntities(options.enabledEntities ?? []);

  const events = effectiveEvents.filter(event =>
    (CALENDLY_SUPPORTED_WEBHOOK_EVENTS as readonly string[]).includes(event),
  );

  if (events.length === 0) {
    throw new Error(
      requestedEvents.length > 0
        ? `No valid Calendly webhook events configured. Calendly only emits: ${CALENDLY_SUPPORTED_WEBHOOK_EVENTS.join(", ")}`
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
    const response = await ctx.execute(() =>
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
      { cause: error },
    );
  }
}

/** A Calendly client on the default base URL and the connection's token. */
export function createCalendlyContext(token: string): CalendlyContext {
  if (!token) throw new Error("Calendly access token not configured");
  const client = axios.create({
    baseURL: CALENDLY_DEFAULT_BASE_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  /** Shared policy: backoff with jitter, Retry-After, 429/5xx/network. */
  const execute = createRetryExecutor({
    label: "Calendly",
    logger,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    formatError: formatCalendlyApiError,
  });
  let cachedOrganizationUri: string | null = null;
  let cachedCurrentUserUri: string | null = null;

  const currentUser = async (): Promise<{
    user_uri: string;
    organization_uri: string;
  }> => {
    if (cachedOrganizationUri && cachedCurrentUserUri) {
      return {
        user_uri: cachedCurrentUserUri,
        organization_uri: cachedOrganizationUri,
      };
    }
    const response = await execute(() => client.get("/users/me"));
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
    cachedCurrentUserUri = userUri;
    cachedOrganizationUri = orgUri;
    return { user_uri: userUri, organization_uri: orgUri };
  };

  return { api: () => client, execute, currentUser };
}
