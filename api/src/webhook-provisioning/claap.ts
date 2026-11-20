/**
 * Claap webhook provisioning for boxed (`ws:`) flows: the `/v1/webhooks`
 * create-or-adopt call, run in the API process so the webhook secret never
 * reaches a box. Moved 1:1 from the built-in connector.
 */
import { randomUUID } from "node:crypto";
import axios, { type AxiosInstance } from "axios";
import type {
  ProvisionWebhookOptions,
  ProvisionWebhookResult,
} from "../connectors/base/BaseConnector";
import type { RetryExecutor } from "../connectors/base/http-client";
import { getErrorStatus, withHttpRetry } from "../connectors/base/http-retry";
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

function provisioningStatus(error: unknown): number | undefined {
  const status = getErrorStatus(error);
  return status !== undefined &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? status
    : undefined;
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

  const events = effectiveEvents.filter(isSupportedEvent);
  if (events.length === 0) {
    throw new Error("No valid Claap webhook events configured");
  }

  const payload = {
    url: options.endpointUrl,
    events,
  };

  const execute = async <T>(request: () => Promise<T>): Promise<T> => {
    try {
      return await ctx.execute(request);
    } catch (error) {
      const status = provisioningStatus(error);
      // eslint-disable-next-line preserve-caught-error -- An Axios cause can expose credentials to callers and logs.
      throw new Error(
        `Failed to create Claap webhook subscription${status === undefined ? "" : `: HTTP ${status}`}`,
      );
    }
  };
  const existingResponse = await execute(() => api.get("/v1/webhooks"));
  const existing = normalizeClaapWebhookList(existingResponse.data).find(
    webhook => webhook.url === options.endpointUrl,
  );

  if (existing) {
    try {
      await ctx.execute(() => api.put(`/v1/webhooks/${existing.id}`, payload));
    } catch {
      // Adoption still succeeds if Claap refuses the event update. The adapter logs the failure.
    }

    return {
      providerWebhookId: existing.id,
      endpointUrl: options.endpointUrl,
      signingSecret: existing.secret,
    };
  }

  const response = await execute(() => api.post("/v1/webhooks", payload));
  const created = normalizeClaapWebhookRecord(response.data);
  if (!created) {
    throw new Error(
      "Claap webhook created but no subscription id returned by API",
    );
  }

  return {
    providerWebhookId: created.id,
    endpointUrl: options.endpointUrl,
    signingSecret: created.secret,
  };
}

function provisioningOperation(method: string | undefined) {
  switch (method) {
    case "get":
      return "list";
    case "post":
      return "create";
    case "put":
      return "update";
    default:
      return undefined;
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
  const adapter = client.defaults.adapter;
  // Axios has merged defaults and run request transforms at this boundary.
  client.defaults.adapter = async config => {
    const dispatch = axios.getAdapter(adapter, config);
    const operation = provisioningOperation(config.method);
    if (!operation) return dispatch(config);
    const authHeader = config.headers.get("X-Claap-Key");
    const fields = {
      provisionRequestId: randomUUID(),
      operation,
      authHeaderPresent:
        typeof authHeader === "string" && authHeader.trim() !== "",
    };
    logger.info("Dispatching Claap webhook provisioning request", fields);
    try {
      return await dispatch(config);
    } catch (error) {
      const status = provisioningStatus(error);
      logger.warn("Claap webhook provisioning request failed", {
        ...fields,
        ...(status === undefined ? {} : { status }),
      });
      throw error;
    }
  };
  // The shared policy still retries 429, 5xx and network failures. The adapter logs each attempt.
  return {
    api: () => client,
    execute: (fn, maxRetries) => withHttpRetry(fn, { maxRetries }),
  };
}
