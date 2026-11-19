/**
 * Claap webhook provisioning for boxed (`ws:`) flows: the `/v1/webhooks`
 * create-or-adopt call, run in the API process so the webhook secret never
 * reaches a box. Moved 1:1 from the built-in connector.
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

const logger = loggers.connector("claap");

const CLAAP_DEFAULT_BASE_URL = "https://api.claap.io";

const CLAAP_TRANSCRIPTS_ENTITY = "recording_transcripts";

/** What the provisioning call reads from the connection. */
export interface ClaapContext {
  api(): AxiosInstance;
  execute: RetryExecutor;
}

export const CLAAP_SUPPORTED_WEBHOOK_EVENTS = [
  "recording_added",
  "recording_updated",
] as const;

/** Claap wraps most bodies in `{ result }`. */
function extractClaapResult(data: unknown): unknown {
  if (data && typeof data === "object" && "result" in data) {
    return (data as { result: unknown }).result;
  }
  return data;
}

function describeClaapErrorBody(raw: unknown): string | undefined {
  const data = raw as
    { error?: { message?: string }; message?: string } | string | undefined;

  const directError =
    typeof data === "string"
      ? data
      : typeof data?.error?.message === "string"
        ? data.error.message
        : typeof data?.message === "string"
          ? data.message
          : undefined;

  const serialized =
    !directError && data && typeof data === "object"
      ? JSON.stringify(data)
      : undefined;

  return directError || serialized;
}

function formatClaapApiError(error: unknown): string {
  return formatHttpApiError(error, describeClaapErrorBody);
}

type ClaapWebhookRecord = {
  id: string;
  url: string;
  secret?: string;
};

/** The first non-blank string among `keys` of `record`, trimmed. */
function firstString(record: unknown, keys: string[]): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const candidate = record as Record<string, unknown>;
  for (const key of keys) {
    const value = candidate[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

const resolveClaapWebhookUrl = (record: unknown): string =>
  firstString(record, ["url", "endpoint", "callbackUrl", "targetUrl"]) ?? "";

const resolveClaapWebhookId = (record: unknown): string =>
  firstString(record, ["id", "_id", "webhookId"]) ?? "";

const resolveClaapSigningSecret = (record: unknown): string | undefined =>
  firstString(record, [
    "secret",
    "signingSecret",
    "signing_secret",
    "webhookSecret",
  ]);

function normalizeClaapWebhookList(data: unknown): ClaapWebhookRecord[] {
  const result = extractClaapResult(data);
  const rawList = Array.isArray(result)
    ? result
    : result && typeof result === "object"
      ? ((result as { webhooks?: unknown }).webhooks ??
        (result as { data?: unknown }).data ??
        [])
      : [];

  if (!Array.isArray(rawList)) return [];

  const normalized: ClaapWebhookRecord[] = [];
  for (const item of rawList) {
    const id = resolveClaapWebhookId(item);
    const url = resolveClaapWebhookUrl(item);
    if (!id || !url) continue;
    normalized.push({
      id,
      url,
      secret: resolveClaapSigningSecret(item),
    });
  }
  return normalized;
}

function normalizeClaapWebhookRecord(data: unknown): ClaapWebhookRecord | null {
  const result = extractClaapResult(data);
  const candidate =
    result && typeof result === "object"
      ? ((result as { webhook?: unknown }).webhook ?? result)
      : data;
  const id = resolveClaapWebhookId(candidate);
  const url = resolveClaapWebhookUrl(candidate);
  if (!id) return null;
  return {
    id,
    url,
    secret: resolveClaapSigningSecret(candidate),
  };
}

const isSupportedEvent = (event: string) =>
  CLAAP_SUPPORTED_WEBHOOK_EVENTS.includes(
    event as (typeof CLAAP_SUPPORTED_WEBHOOK_EVENTS)[number],
  );

export function claapSupportedWebhookEvents(): string[] {
  return [...CLAAP_SUPPORTED_WEBHOOK_EVENTS];
}

export function claapWebhookEventsForEntities(entities: string[]): string[] {
  if (entities.length === 0) return claapSupportedWebhookEvents();
  const normalized = new Set(entities.map(e => e.toLowerCase()));
  // Transcripts ride on the recording events (enrichWebhookCdcRecords).
  if (
    normalized.has("recordings") ||
    normalized.has(CLAAP_TRANSCRIPTS_ENTITY)
  ) {
    return claapSupportedWebhookEvents();
  }
  return [];
}

/**
 * Create the Claap webhook for the flow URL, or adopt (and retarget) the
 * one already posting there.
 */
export async function provisionClaapWebhook(
  ctx: ClaapContext,
  options: ProvisionWebhookOptions,
  eventsForEntities: (entities: string[]) => string[],
): Promise<ProvisionWebhookResult> {
  const api = ctx.api();

  const requestedEvents = Array.isArray(options.events)
    ? options.events
        .map(event => event.trim())
        .filter((event): event is string => event.length > 0)
    : [];

  const effectiveEvents =
    requestedEvents.length > 0
      ? requestedEvents
      : eventsForEntities(options.enabledEntities ?? []);

  const unsupported = effectiveEvents.filter(event => !isSupportedEvent(event));
  if (requestedEvents.length > 0 && unsupported.length > 0) {
    logger.warn("Ignoring unsupported Claap webhook events", {
      unsupportedEvents: unsupported,
    });
  }

  const events = effectiveEvents.filter(isSupportedEvent);

  if (events.length === 0) {
    throw new Error(
      requestedEvents.length > 0
        ? `No valid Claap webhook events configured. Unsupported events: ${unsupported.join(", ")}`
        : "No valid Claap webhook events configured",
    );
  }

  const payload = {
    url: options.endpointUrl,
    events,
  };

  try {
    const existingResponse = await ctx.execute(() => api.get("/v1/webhooks"));
    const existing = normalizeClaapWebhookList(existingResponse.data).find(
      webhook => webhook.url === options.endpointUrl,
    );

    if (existing) {
      try {
        await ctx.execute(() =>
          api.put(`/v1/webhooks/${existing.id}`, payload),
        );
        logger.info("Updated Claap webhook events for existing subscription", {
          webhookId: existing.id,
          eventCount: events.length,
        });
      } catch (updateError) {
        logger.warn("Could not update events on existing Claap webhook", {
          webhookId: existing.id,
          error: updateError,
        });
      }

      return {
        providerWebhookId: existing.id,
        endpointUrl: options.endpointUrl,
        signingSecret: existing.secret,
      };
    }

    const response = await ctx.execute(() => api.post("/v1/webhooks", payload));
    const created = normalizeClaapWebhookRecord(response.data);
    const providerWebhookId = created?.id;
    if (!providerWebhookId) {
      throw new Error(
        "Claap webhook created but no subscription id returned by API",
      );
    }

    return {
      providerWebhookId,
      endpointUrl: options.endpointUrl,
      signingSecret: created.secret,
    };
  } catch (error) {
    throw new Error(
      `Failed to create Claap webhook subscription: ${formatClaapApiError(error)}`,
      { cause: error },
    );
  }
}

/** A Claap client on the default base URL and the connection's key. */
export function createClaapContext(apiKey: string): ClaapContext {
  if (!apiKey) throw new Error("Claap API key not configured");
  const client = axios.create({
    baseURL: CLAAP_DEFAULT_BASE_URL,
    headers: {
      "X-Claap-Key": apiKey,
      "Content-Type": "application/json",
    },
  });
  /** Shared policy: backoff with jitter, Retry-After, 429/5xx/network. */
  const execute = createRetryExecutor({
    label: "Claap",
    logger,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  });
  return { api: () => client, execute };
}
