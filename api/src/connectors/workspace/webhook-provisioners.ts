/**
 * Provider-side webhook subscriptions for boxed (`ws:`) connectors.
 *
 * A box never sees a webhook signing secret (webhook-batch.ts), so it cannot
 * create the subscription that returns one. The API does it here, with the
 * connection's own key, through the same vendor code as the built-in
 * connector. The secret goes straight onto `flow.webhookConfig.secret`
 * (flow-webhook-subscription.service.ts) and nowhere else.
 *
 * Keyed by the folder's slug. A folder of that name gets the vendor's
 * provisioning only if it also declares a verification scheme Mako can run
 * (SandboxedConnector checks). The client is the vendor's default base URL,
 * never one from the connection's config, so a key goes only to its vendor.
 */
import type {
  DeleteWebhookSubscriptionOptions,
  ProvisionWebhookOptions,
  ProvisionWebhookResult,
} from "../base/BaseConnector";

export interface WebhookProvisioner {
  /** Create the subscription (or adopt one already on the URL). */
  create(options: ProvisionWebhookOptions): Promise<ProvisionWebhookResult>;
  /**
   * Adopt the subscription on the URL and set its events; null when none.
   * Absent when the built-in connector cannot update one either.
   */
  update?(
    options: ProvisionWebhookOptions,
  ): Promise<ProvisionWebhookResult | null>;
  /** Remove every subscription on the URL; absent when the vendor's built-in cannot. */
  delete?(options: DeleteWebhookSubscriptionOptions): Promise<number>;
}

/** Which slugs can update or delete, known without building a client. */
const CAPABILITIES: Record<string, { update: boolean; delete: boolean }> = {
  close: { update: true, delete: false },
  wise: { update: true, delete: true },
  calendly: { update: false, delete: false },
};

/** Wise's production and sandbox API hosts, as the folder allows them. */
const WISE_HOSTS = new Set([
  "api.wise.com",
  "api.transferwise.com",
  "api.sandbox.transferwise.tech",
  "sandbox.transferwise.tech",
  "api.sandbox.wise.com",
  "sandbox.wise.com",
]);

/** `value` when it is an https URL on a Wise host (no path tricks), else undefined. */
function wiseHostUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !WISE_HOSTS.has(url.hostname)) {
      return undefined;
    }
    if (url.username || url.password || url.port) return undefined;
    return `https://${url.hostname}`;
  } catch {
    return undefined;
  }
}

const credential = (config: Record<string, unknown>, key: string) =>
  typeof config[key] === "string" ? (config[key] as string) : "";

/**
 * The config a built-in connector provisions with: the credential (and
 * Wise's profile), and `api_base_url` only when it is one of Wise's own
 * HTTPS hosts, so the key goes only to the vendor. Throws when the
 * credential is missing.
 */
export function builtInProvisioningConfig(
  slug: "wise" | "calendly",
  config: Record<string, unknown>,
): Record<string, string> {
  if (slug === "wise") {
    const apiKey = credential(config, "api_key");
    if (!apiKey.trim()) throw new Error("Wise API token not configured");
    const profileId = credential(config, "profile_id");
    const baseUrl = wiseHostUrl(config.api_base_url);
    return {
      api_key: apiKey,
      ...(profileId ? { profile_id: profileId } : {}),
      // A sandbox connection provisions in the sandbox, as in-process.
      ...(baseUrl ? { api_base_url: baseUrl } : {}),
    };
  }
  const token = credential(config, "access_token");
  if (!token.trim()) throw new Error("Calendly access token not configured");
  return { access_token: token };
}

type ProvisionerFactory = (
  config: Record<string, unknown>,
) => Promise<WebhookProvisioner>;

const PROVISIONERS: Record<string, ProvisionerFactory> = {
  close: async config => {
    const apiKey = typeof config.api_key === "string" ? config.api_key : "";
    if (!apiKey.trim()) throw new Error("Close API key not configured");
    const { createCloseClient } = await import("../close/client");
    const {
      adoptCloseWebhook,
      closeWebhookEventsForEntities,
      provisionCloseWebhook,
    } = await import("../close/webhooks");
    const api = createCloseClient({
      apiKey,
      minDelayMs: 500,
      emitLog: () => {},
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    });
    return {
      create: options =>
        provisionCloseWebhook(api, options, closeWebhookEventsForEntities),
      update: options =>
        adoptCloseWebhook(api, options, closeWebhookEventsForEntities),
    };
  },
  // The built-in connectors themselves, on the credential alone: no
  // `api_base_url` reaches them, so they call the vendor's own host.
  wise: async config => {
    const { WiseConnector } = await import("../wise/connector");
    const wise = new WiseConnector({
      name: "Wise webhook provisioning",
      type: "wise",
      config: builtInProvisioningConfig("wise", config),
    } as never);
    return {
      create: options => wise.createWebhookSubscription(options),
      update: options => wise.updateWebhookSubscription(options),
      delete: options => wise.deleteWebhookSubscription(options),
    };
  },
  calendly: async config => {
    const { CalendlyConnector } = await import("../calendly/connector");
    const calendly = new CalendlyConnector({
      name: "Calendly webhook provisioning",
      type: "calendly",
      config: builtInProvisioningConfig("calendly", config),
    } as never);
    return {
      create: options => calendly.createWebhookSubscription(options),
    };
  },
};

export function hasWebhookProvisioner(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVISIONERS, slug);
}

/** Whether the slug's provisioner can update, or delete, a subscription. */
export function webhookProvisionerCan(
  slug: string,
  action: "update" | "delete",
): boolean {
  return hasWebhookProvisioner(slug) && CAPABILITIES[slug]?.[action] === true;
}

export async function webhookProvisionerFor(
  slug: string,
  config: Record<string, unknown>,
): Promise<WebhookProvisioner> {
  if (!hasWebhookProvisioner(slug)) {
    throw new Error(
      `The connector "${slug}" has no webhook provisioning in Mako.`,
    );
  }
  return PROVISIONERS[slug](config);
}
