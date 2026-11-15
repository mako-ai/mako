/**
 * Claap webhooks: provisioning (`/v1/webhooks`), shared-secret verification
 * and the recording events.
 */
import type {
  ProvisionWebhookOptions,
  ProvisionWebhookResult,
  WebhookHandlerOptions,
  WebhookVerificationResult,
} from "../base/BaseConnector";
import { headerValue } from "../base/http-client";
import { loggers } from "../../logging";
import {
  extractClaapResult,
  formatClaapApiError,
  type ClaapContext,
} from "./client";

const logger = loggers.connector("claap");

export const CLAAP_SUPPORTED_WEBHOOK_EVENTS = [
  "recording_added",
  "recording_updated",
] as const;

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

/**
 * Claap does not sign deliveries: it echoes the webhook's secret in
 * `X-Claap-Webhook-Secret`, compared with the flow's stored secret.
 */
export function verifyClaapWebhook(
  options: WebhookHandlerOptions,
): WebhookVerificationResult {
  const { payload, headers, secret } = options;

  const webhookSecret = headerValue(headers, "X-Claap-Webhook-Secret");

  if (!secret) {
    return { valid: false, error: "Missing webhook secret on flow" };
  }

  if (!webhookSecret) {
    return {
      valid: false,
      error: "Missing X-Claap-Webhook-Secret header",
    };
  }

  if (webhookSecret !== secret) {
    return { valid: false, error: "Invalid webhook secret" };
  }

  try {
    const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;

    const eventType =
      typeof parsed?.event?.type === "string"
        ? parsed.event.type
        : typeof parsed?.type === "string"
          ? parsed.type
          : undefined;

    return {
      valid: true,
      event: {
        ...parsed,
        type: eventType,
        id:
          typeof parsed?.eventId === "string"
            ? parsed.eventId
            : typeof parsed?.id === "string"
              ? parsed.id
              : undefined,
      },
    };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "Failed to parse webhook",
    };
  }
}

/** The recording a webhook event carries, keyed by its id. */
export function extractClaapWebhookData(
  event: unknown,
): { id: string; data: Record<string, unknown> } | null {
  const payload = event as {
    event?: { recording?: Record<string, unknown> };
    recording?: Record<string, unknown>;
  };

  const recording = payload?.event?.recording ?? payload?.recording;
  const id =
    typeof recording?.id === "string"
      ? recording.id
      : typeof (recording as { _id?: string })?._id === "string"
        ? (recording as { _id: string })._id
        : undefined;

  if (!recording || !id) {
    return null;
  }

  return {
    id: String(id),
    data: { ...recording, id: String(id) },
  };
}
