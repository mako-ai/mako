/**
 * Provider-side webhook subscriptions for boxed (`ws:`) connectors.
 *
 * A box never sees a webhook signing secret (webhook-batch.ts), so it cannot
 * create the subscription that returns one. The API does it here, with the
 * connection's own key, through the vendor code in ../vendor-webhooks/ (one
 * module per vendor). The secret goes straight onto
 * `flow.webhookConfig.secret` (flow-webhook-subscription.service.ts) and
 * nowhere else.
 *
 * Close, PandaDoc, Claap, Stripe, Wise and Calendly, keyed by the folder's slug. A folder of that name
 * gets the vendor's provisioning only if it also declares a verification
 * scheme Mako can run
 * (SandboxedConnector checks). The client is the vendor's default base URL,
 * never one from the connection's config, so a key goes only to its vendor.
 */
import type Stripe from "stripe";
import type {
  DeleteWebhookSubscriptionOptions,
  ProvisionWebhookOptions,
  ProvisionWebhookResult,
  UpdateWebhookSubscriptionOptions,
} from "../base/BaseConnector";
import {
  STRIPE_API_VERSION,
  createStripeWebhookEndpoint,
  resolveStripeProvisionEvents,
  stripeSupportedWebhookEvents,
  stripeWebhookEventsForEntities,
  updateStripeWebhookEndpoints,
} from "../vendor-webhooks/stripe";

export interface WebhookProvisioner {
  /** Create the subscription (or adopt one already on the URL). */
  create(options: ProvisionWebhookOptions): Promise<ProvisionWebhookResult>;
  /** Adopt the subscription on the URL and set its events; null when none. */
  update(
    options: UpdateWebhookSubscriptionOptions,
  ): Promise<ProvisionWebhookResult | null>;
  /** Remove every subscription on the URL; only where `canDelete`. */
  delete?(options: DeleteWebhookSubscriptionOptions): Promise<number>;
}

type ProvisionerFactory = (
  config: Record<string, unknown>,
) => Promise<WebhookProvisioner>;

interface ProvisionerEntry {
  factory: ProvisionerFactory;
  /**
   * Whether `update` retargets the subscription in place (the boxed
   * connector's `supportsWebhookSubscriptionUpdate`). False: Mako creates.
   */
  canUpdate: boolean;
  /** Whether `delete` removes the subscriptions of a deleted flow. */
  canDelete?: boolean;
  /** What the boxed connector's `getWebhookCapabilities()` reports. */
  storesSecretAutomatically: boolean;
  secretHelpText?: string;
  actionHint?: string;
}

const apiKeyOf = (config: Record<string, unknown>, vendor: string): string => {
  const apiKey = typeof config.api_key === "string" ? config.api_key : "";
  if (!apiKey.trim()) throw new Error(`${vendor} API key not configured`);
  return apiKey;
};

const credential = (config: Record<string, unknown>, key: string) =>
  typeof config[key] === "string" ? (config[key] as string) : "";

/** Wise's production and sandbox API hosts, as the folder allows them. */
const WISE_HOSTS = new Set([
  "api.wise.com",
  "api.transferwise.com",
  "api.sandbox.transferwise.tech",
  "sandbox.transferwise.tech",
  "api.sandbox.wise.com",
  "sandbox.wise.com",
]);

/** `https://<host>` when `value` is an https URL on a Wise host, else undefined. */
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

/**
 * The config Wise and Calendly provision with: the credential (and Wise's
 * profile), and `api_base_url` only when it is one of Wise's own HTTPS
 * hosts, so the key goes only to the vendor. Throws when the credential is
 * missing.
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
      ...(baseUrl ? { api_base_url: baseUrl } : {}),
    };
  }
  const token = credential(config, "access_token");
  if (!token.trim()) throw new Error("Calendly access token not configured");
  return { access_token: token };
}

const PROVISIONERS: Record<string, ProvisionerEntry> = {
  close: {
    canUpdate: true,
    storesSecretAutomatically: true,
    factory: async config => {
      const apiKey = apiKeyOf(config, "Close");
      const { closeWebhookProvisioning } =
        await import("../vendor-webhooks/close");
      return closeWebhookProvisioning(apiKey);
    },
  },
  // PandaDoc's subscription create on the key alone: PandaDoc's default
  // base URL, the flow's triggers with the rich payload sections, and the
  // `shared_key` it returns.
  pandadoc: {
    canUpdate: false,
    storesSecretAutomatically: true,
    secretHelpText:
      "Enter the webhook subscription Shared Key from the PandaDoc Developer Dashboard (used to verify the HMAC signature).",
    factory: async config => {
      const apiKey = apiKeyOf(config, "PandaDoc");
      const { pandaDocWebhookProvisioning } =
        await import("../vendor-webhooks/pandadoc");
      return pandaDocWebhookProvisioning(apiKey);
    },
  },
  // Claap's `provisionClaapWebhook`, which adopts (and retargets) the
  // webhook already on the URL. Claap may not return the secret.
  claap: {
    canUpdate: false,
    storesSecretAutomatically: false,
    secretHelpText:
      "Enter the X-Claap-Webhook-Secret from your Claap webhook settings",
    actionHint: "(copy the secret into this form if Claap shows it once)",
    factory: async config => {
      const apiKey = apiKeyOf(config, "Claap");
      const { claapWebhookProvisioning } =
        await import("../vendor-webhooks/claap");
      return claapWebhookProvisioning(apiKey);
    },
  },
  // Wise's profile subscriptions on the token and profile, plus
  // `api_base_url` only when it is Wise's own host (a sandbox connection
  // provisions in the sandbox). Profile subscriptions on every profile it
  // syncs; Wise signs with its RSA keys, so the "secret" names the key set.
  wise: {
    canUpdate: true,
    canDelete: true,
    storesSecretAutomatically: true,
    actionHint:
      "on every profile this connection syncs and records which Wise signing key verifies it",
    secretHelpText:
      'Wise signs webhooks with its RSA public keys, not a shared secret: this field only names the key set — "production" (or blank) or "sandbox". Creating the webhook in Wise fills it in.',
    factory: async config => {
      const provisioningConfig = builtInProvisioningConfig("wise", config);
      const { wiseWebhookProvisioning } =
        await import("../vendor-webhooks/wise");
      return wiseWebhookProvisioning(provisioningConfig);
    },
  },
  // Calendly's organization-scoped subscription create on the token alone
  // (api.calendly.com). Calendly returns the signing key.
  calendly: {
    canUpdate: false,
    storesSecretAutomatically: true,
    factory: async config => {
      const provisioningConfig = builtInProvisioningConfig("calendly", config);
      const { calendlyWebhookProvisioning } =
        await import("../vendor-webhooks/calendly");
      return calendlyWebhookProvisioning(provisioningConfig);
    },
  },
  stripe: {
    canUpdate: true,
    storesSecretAutomatically: true,
    factory: async config => {
      const apiKey = apiKeyOf(config, "Stripe");
      const { default: Stripe } = await import("stripe");
      // api.stripe.com, whatever `api_base_url` the connection holds.
      return stripeWebhookProvisioner(
        new Stripe(apiKey, { apiVersion: STRIPE_API_VERSION }),
      );
    },
  },
};

/**
 * Stripe's provisioning on a given client: create an endpoint for the flow's events, or retarget the one already
 * on the URL. The endpoint is pinned to the API version the folder reads,
 * so a delivery's object has a list row's shape. Stripe returns the signing
 * secret on create only.
 */
export function stripeWebhookProvisioner(stripe: Stripe): WebhookProvisioner {
  const eventsFor = (options: ProvisionWebhookOptions) =>
    resolveStripeProvisionEvents(
      options,
      stripeSupportedWebhookEvents(),
      stripeWebhookEventsForEntities,
    );
  return {
    create: options =>
      createStripeWebhookEndpoint(
        stripe,
        options.endpointUrl,
        eventsFor(options),
        STRIPE_API_VERSION,
      ),
    update: options =>
      updateStripeWebhookEndpoints(stripe, options, eventsFor(options)),
  };
}

export function hasWebhookProvisioner(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVISIONERS, slug);
}

/** How the vendor's provisioning behaves, for the flow form. */
export function webhookProvisionerTraits(
  slug: string,
): Omit<ProvisionerEntry, "factory"> | null {
  if (!hasWebhookProvisioner(slug)) return null;
  const { factory: _factory, ...traits } = PROVISIONERS[slug];
  return traits;
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
  return PROVISIONERS[slug].factory(config);
}
