/**
 * PandaDoc webhook provisioning for boxed (`ws:`) flows: the triggers and the
 * `/public/v1/webhook-subscriptions` create call, run in the API process so
 * the shared key never reaches a box. Moved 1:1 from the built-in connector.
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

const logger = loggers.connector("pandadoc");

const DEFAULT_BASE_URL = "https://api.pandadoc.com";

/** What the create call reads from the connection: its client and retry. */
export interface PandaDocContext {
  api(): AxiosInstance;
  execute: RetryExecutor;
}

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

function describePandaDocErrorBody(raw: unknown): string | undefined {
  const data = raw as
    | {
        detail?: unknown;
        message?: string;
        type?: string;
      }
    | string
    | undefined;

  return typeof data === "string"
    ? data
    : typeof data?.message === "string"
      ? data.message
      : typeof data?.detail === "string"
        ? data.detail
        : data?.detail && typeof data.detail === "object"
          ? JSON.stringify(data.detail)
          : undefined;
}

function formatPandaDocApiError(error: unknown): string {
  return formatHttpApiError(error, describePandaDocErrorBody);
}

export function pandaDocSupportedWebhookEvents(): string[] {
  return [...SUPPORTED_WEBHOOK_EVENTS];
}

export function pandaDocWebhookEventsForEntities(entities: string[]): string[] {
  if (entities.length === 0) return pandaDocSupportedWebhookEvents();
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

export async function createPandaDocWebhookSubscription(
  ctx: PandaDocContext,
  options: ProvisionWebhookOptions,
): Promise<ProvisionWebhookResult> {
  const api = ctx.api();

  const requestedEvents = Array.isArray(options.events)
    ? options.events.map(event => event.trim()).filter(Boolean)
    : [];

  const effectiveEvents =
    requestedEvents.length > 0
      ? requestedEvents
      : pandaDocWebhookEventsForEntities(options.enabledEntities ?? []);

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
    const response = await ctx.execute(() =>
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
      { cause: error },
    );
  }
}

/** A PandaDoc client on the default base URL and the connection's key. */
export function createPandaDocContext(apiKey: string): PandaDocContext {
  if (!apiKey) throw new Error("PandaDoc API key not configured");
  const client = axios.create({
    baseURL: DEFAULT_BASE_URL,
    headers: {
      Authorization: `API-Key ${apiKey}`,
      "Content-Type": "application/json",
    },
  });
  /** Shared policy: backoff with jitter, Retry-After, 429/5xx/network. */
  const execute = createRetryExecutor({
    label: "PandaDoc",
    logger,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    formatError: formatPandaDocApiError,
  });
  return { api: () => client, execute };
}
