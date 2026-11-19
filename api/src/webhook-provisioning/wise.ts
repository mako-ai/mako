/**
 * Wise webhook provisioning for boxed (`ws:`) flows: the supported events and
 * the profile-level subscription create, update and delete calls, run in the
 * API process. Moved 1:1 from the built-in connector. Wise signs with its RSA
 * keys, so the flow's "secret" only names the key set.
 */
import type { AxiosInstance } from "axios";
import type {
  DeleteWebhookSubscriptionOptions,
  ProvisionWebhookOptions,
  ProvisionWebhookResult,
  UpdateWebhookSubscriptionOptions,
  WebhookEventMapping,
} from "../connectors/base/BaseConnector";
import { createRetryExecutor } from "../connectors/base/http-client";
import { loggers } from "../logging";
import {
  createWiseClient,
  formatWiseApiError,
  isWiseSandboxBaseUrl,
  resolveWiseBaseUrl,
} from "./wise-client";
import {
  deleteWiseProfileSubscriptions,
  reconcileWiseProfileSubscriptions,
  type WiseSubscriptionContext,
} from "./wise-subscriptions";

const logger = loggers.connector("wise");

type WiseProfile = {
  id: number | string;
  [key: string]: unknown;
};

export const WISE_SUPPORTED_WEBHOOK_EVENTS = [
  "transfers#state-change",
  "transfers#refund",
  "transfers#payout-failure",
  "transfers#active-cases",
  "balances#update",
  "balances#account-state-change",
  "profiles#state-change",
  "recipients#state-change",
] as const;

const EVENT_MAPPINGS: Record<string, WebhookEventMapping> = {
  "transfers#state-change": { entity: "transfers", operation: "upsert" },
  "transfers#refund": { entity: "transfers", operation: "upsert" },
  "transfers#payout-failure": { entity: "transfers", operation: "upsert" },
  "transfers#active-cases": { entity: "transfers", operation: "upsert" },
  "balances#update": { entity: "balance_updates", operation: "upsert" },
  // Wise's own webhook screen offers "Account deposit events" but not
  // balances#update, so a hand-made subscription lands here
  "balances#credit": { entity: "balance_updates", operation: "upsert" },
  "balances#account-state-change": {
    entity: "balances",
    operation: "upsert",
  },
  "profiles#state-change": { entity: "profiles", operation: "upsert" },
  "recipients#state-change": { entity: "recipients", operation: "upsert" },
};

export function wiseSupportedWebhookEvents(): string[] {
  return [...WISE_SUPPORTED_WEBHOOK_EVENTS];
}

export function wiseWebhookEventsForEntities(entities: string[]): string[] {
  if (entities.length === 0) {
    return wiseSupportedWebhookEvents();
  }

  const entitySet = new Set(entities.map(e => e.toLowerCase()));
  return wiseSupportedWebhookEvents().filter(eventType => {
    const mapping = EVENT_MAPPINGS[eventType] ?? null;
    return mapping ? entitySet.has(mapping.entity.toLowerCase()) : false;
  });
}

/** The provisioning calls of one Wise connection (token, profile, base URL). */
export interface WiseProvisioning {
  create(options: ProvisionWebhookOptions): Promise<ProvisionWebhookResult>;
  update(
    options: UpdateWebhookSubscriptionOptions,
  ): Promise<ProvisionWebhookResult | null>;
  delete(options: DeleteWebhookSubscriptionOptions): Promise<number>;
}

/**
 * Wise provisioning on `config`: `api_key`, optional `profile_id`, optional
 * `api_base_url` (the caller allows only Wise's own hosts) and optional
 * `sca_private_key`.
 */
export function createWiseProvisioning(
  config: Record<string, unknown>,
  overrides: { api?: () => AxiosInstance } = {},
): WiseProvisioning {
  const baseUrl = resolveWiseBaseUrl(config.api_base_url);
  let wiseApi: AxiosInstance | null = null;
  let cachedProfiles: WiseProfile[] | null = null;

  /** Shared policy: backoff with jitter, Retry-After, 429/5xx/network. */
  const executeWithRetry = createRetryExecutor({
    label: "Wise",
    logger,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    formatError: formatWiseApiError,
  });

  const getClient = (): AxiosInstance => {
    if (overrides.api) return overrides.api();
    if (!wiseApi) {
      if (!config.api_key) {
        throw new Error("Wise API token not configured");
      }
      wiseApi = createWiseClient(baseUrl, String(config.api_key));
    }
    return wiseApi;
  };

  const listProfiles = async (): Promise<WiseProfile[]> => {
    if (cachedProfiles) {
      return cachedProfiles;
    }

    const api = getClient();
    const response = await executeWithRetry(() => api.get("/v2/profiles"));
    const profiles = Array.isArray(response.data)
      ? (response.data as WiseProfile[])
      : [];
    cachedProfiles = profiles;
    return profiles;
  };

  const resolveProfileIds = async (): Promise<string[]> => {
    const configured = config.profile_id;
    if (configured != null && String(configured).trim().length > 0) {
      return [String(configured).trim()];
    }

    const profiles = await listProfiles();
    return profiles
      .map(profile => String(profile.id))
      .filter(id => id.length > 0);
  };

  /**
   * The value stored as the flow's webhook "secret": which Wise public key
   * set verifies deliveries.
   */
  const webhookKeySet = (): string =>
    isWiseSandboxBaseUrl(baseUrl) ? "sandbox" : "production";

  const context = (): WiseSubscriptionContext => ({
    api: () => getClient(),
    execute: (fn, maxRetries) => executeWithRetry(fn, maxRetries),
    scaPrivateKey: () => config.sca_private_key,
    resolveProfileIds: () => resolveProfileIds(),
    webhookKeySet: () => webhookKeySet(),
    supportedEvents: () => wiseSupportedWebhookEvents(),
    eventsForEntities: entities => wiseWebhookEventsForEntities(entities),
  });

  return {
    /**
     * Subscribe `endpointUrl` to the flow's events on every profile the
     * connection syncs (`profile_id`, or every profile the token sees).
     * Idempotent: an existing subscription with the same URL and event is
     * reused, so clicking "Create in Wise" twice creates nothing new.
     */
    async create(options) {
      const result = await reconcileWiseProfileSubscriptions(
        context(),
        options,
        true,
      );
      if (!result) {
        throw new Error("Wise webhook subscriptions could not be created");
      }
      return { ...result, signingSecret: webhookKeySet() };
    },
    /**
     * Retarget the subscriptions on `endpointUrl` to the flow's current
     * events. `null` when no profile has one yet (the caller creates them).
     */
    async update(options) {
      const result = await reconcileWiseProfileSubscriptions(
        context(),
        options,
        false,
      );
      // Wise signs with its public keys: the "secret" is only the key set, the
      // same whether the subscription is new or adopted.
      return result ? { ...result, signingSecret: webhookKeySet() } : null;
    },
    /** Remove every subscription delivering to `endpointUrl`, on every profile. */
    async delete(options) {
      return deleteWiseProfileSubscriptions(context(), options.endpointUrl);
    },
  };
}
