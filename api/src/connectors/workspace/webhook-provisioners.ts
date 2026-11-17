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
  ProvisionWebhookOptions,
  ProvisionWebhookResult,
} from "../base/BaseConnector";

export interface WebhookProvisioner {
  /** Create the subscription (or adopt one already on the URL). */
  create(options: ProvisionWebhookOptions): Promise<ProvisionWebhookResult>;
  /** Adopt the subscription on the URL and set its events; null when none. */
  update(
    options: ProvisionWebhookOptions,
  ): Promise<ProvisionWebhookResult | null>;
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
};

export function hasWebhookProvisioner(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVISIONERS, slug);
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
