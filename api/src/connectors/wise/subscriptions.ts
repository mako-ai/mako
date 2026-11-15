/**
 * Wise profile-level webhook subscriptions (`/v3/profiles/{id}/subscriptions`):
 * reconcile each synced profile to exactly one subscription per needed event
 * on the flow's URL, with SCA answered and refusals explained.
 */
import axios, { type AxiosInstance } from "axios";
import type {
  ProvisionWebhookOptions,
  ProvisionWebhookResult,
} from "../base/BaseConnector";
import type { RetryExecutor } from "../base/http-client";
import { formatWiseApiError, sendWithSca } from "./client";

/**
 * Events a PROFILE-level subscription may carry, with the schema version
 * Mako asks for (the latest each event documents). `balances#account-state-
 * change` and `profiles#state-change` are application-level only, so a token
 * acting for a profile cannot subscribe to them.
 * https://docs.wise.com/api-reference/webhook-event
 */
const PROFILE_WEBHOOK_SCHEMA_VERSIONS: Record<string, string> = {
  "transfers#state-change": "4.0.0",
  "transfers#refund": "4.0.0",
  "transfers#payout-failure": "5.0.0",
  "transfers#active-cases": "4.0.0",
  "balances#update": "4.0.0",
  "recipients#state-change": "4.0.0",
};

/** Name Mako gives the subscriptions it creates, so they read as its own. */
const MAKO_SUBSCRIPTION_NAME_PREFIX = "Mako";

type WiseSubscription = {
  id: string;
  name?: string;
  trigger_on?: string;
  delivery?: { version?: string; url?: string };
};

type CallContext = { endpointUrl: string; events?: string[] };

export interface WiseSubscriptionContext {
  api(): AxiosInstance;
  execute: RetryExecutor;
  scaPrivateKey(): unknown;
  resolveProfileIds(): Promise<string[]>;
  /** The flow "secret": which Wise key set verifies deliveries. */
  webhookKeySet(): string;
  supportedEvents(): string[];
  eventsForEntities(entities: string[]): string[];
}

/**
 * Events a profile subscription should carry: the explicitly requested
 * ones, else those of the flow's enabled entities — restricted to the
 * events Wise offers at profile level. Throws when nothing remains, naming
 * the application-only events that were asked for.
 */
function resolveProfileWebhookEvents(
  ctx: WiseSubscriptionContext,
  options: ProvisionWebhookOptions,
): string[] {
  const requested = Array.isArray(options.events)
    ? options.events.map(event => event.trim()).filter(Boolean)
    : [];
  const wanted =
    requested.length > 0
      ? requested
      : ctx.eventsForEntities(options.enabledEntities ?? []);
  const supported = new Set(ctx.supportedEvents());
  const profileLevel = wanted.filter(
    event => supported.has(event) && event in PROFILE_WEBHOOK_SCHEMA_VERSIONS,
  );
  if (profileLevel.length === 0) {
    const applicationOnly = wanted.filter(
      event =>
        supported.has(event) && !(event in PROFILE_WEBHOOK_SCHEMA_VERSIONS),
    );
    throw new Error(
      applicationOnly.length > 0
        ? `Wise offers ${applicationOnly.join(", ")} to application-level subscriptions only, which a profile token cannot create. Enable an entity with a profile-level event (balance_updates, transfers or recipients), or keep the scheduled sync for these entities.`
        : requested.length > 0
          ? `No valid Wise webhook events requested. Unsupported events: ${requested.join(", ")}`
          : "No Wise webhook events resolved for the selected entities",
    );
  }
  return profileLevel;
}

/**
 * Turn a Wise refusal of a subscription call into what the user must do.
 * Wise documents profile subscriptions for user tokens; personal API tokens
 * are documented for quotes, recipients, transfers and transfer tracking
 * only, and a token with limited (read-only) permissions is refused.
 */
function subscriptionRefusal(
  ctx: WiseSubscriptionContext,
  status: number | undefined,
  detail: string,
  action: string,
  profileId: string,
  options: CallContext,
): Error {
  if (status !== 401 && status !== 403) {
    return new Error(
      `Failed to ${action} Wise webhook subscriptions on profile ${profileId}: ${detail}`,
    );
  }
  const events = options.events?.length
    ? options.events.join(", ")
    : "the events you need";
  return new Error(
    `Wise refused to ${action} webhook subscriptions on profile ${profileId} (${detail}). ` +
      "Wise lets only a token allowed to manage the profile's webhooks do this: an OAuth user access token, " +
      "or a personal API token with full access — a token with limited (read-only) permissions is refused. " +
      "Either replace this connection's API token with a full-access one (Wise → Your account → " +
      "Integrations and tools → API tokens) and try again, or create the subscription by hand in Wise " +
      "(Your account → Integrations and tools → Developer tools → Webhooks → Create a new webhook) " +
      `with URL ${options.endpointUrl} for ${events}, then set this flow's Webhook Secret to "${ctx.webhookKeySet()}".`,
  );
}

/** A Wise subscription call, with SCA answered and refusals explained. */
async function subscriptionCall<T>(
  ctx: WiseSubscriptionContext,
  action: string,
  profileId: string,
  options: CallContext,
  send: (headers?: Record<string, string>) => Promise<T>,
): Promise<T> {
  const noChallenge = "HTTP 403 without an SCA challenge";
  try {
    return await sendWithSca(ctx.execute, ctx.scaPrivateKey(), send, {
      noChallenge,
      noKey: `Wise requires strong customer authentication to ${action} webhook subscriptions: add an SCA private key to this connection and register its public key in Wise (Settings → API tokens → Manage public keys)`,
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw subscriptionRefusal(
        ctx,
        error.response?.status,
        formatWiseApiError(error),
        action,
        profileId,
        options,
      );
    }
    if (error instanceof Error && error.message === noChallenge) {
      throw subscriptionRefusal(
        ctx,
        403,
        noChallenge,
        action,
        profileId,
        options,
      );
    }
    throw error;
  }
}

async function listProfileSubscriptions(
  ctx: WiseSubscriptionContext,
  profileId: string,
  options: CallContext,
): Promise<WiseSubscription[]> {
  const api = ctx.api();
  const response = await subscriptionCall(
    ctx,
    "list",
    profileId,
    options,
    headers =>
      api.get(
        `/v3/profiles/${profileId}/subscriptions`,
        headers ? { headers } : undefined,
      ),
  );
  const data = response.data as unknown;
  return Array.isArray(data) ? (data as WiseSubscription[]) : [];
}

function deleteSubscription(
  ctx: WiseSubscriptionContext,
  profileId: string,
  options: CallContext,
  subscriptionId: string,
) {
  const api = ctx.api();
  return subscriptionCall(ctx, "delete", profileId, options, headers =>
    api.delete(
      `/v3/profiles/${profileId}/subscriptions/${subscriptionId}`,
      headers ? { headers } : undefined,
    ),
  );
}

/**
 * Make each synced profile carry exactly one subscription per needed event
 * on `endpointUrl`: reuse what exists (same URL + event), create what is
 * missing, delete duplicates and events the flow no longer needs. Only
 * subscriptions delivering to this flow's URL are ever touched.
 *
 * `createWhenAbsent: false` leaves profiles alone when none of them has a
 * subscription on the URL yet, and resolves to `null` (the
 * `updateWebhookSubscription` contract).
 */
export async function reconcileWiseProfileSubscriptions(
  ctx: WiseSubscriptionContext,
  options: ProvisionWebhookOptions,
  createWhenAbsent: boolean,
): Promise<ProvisionWebhookResult | null> {
  const events = resolveProfileWebhookEvents(ctx, options);
  const context = { endpointUrl: options.endpointUrl, events };
  const profileIds = await ctx.resolveProfileIds();
  if (profileIds.length === 0) {
    throw new Error(
      "The Wise API token sees no profile to subscribe: set Profile ID on the connection or check the token",
    );
  }

  const existingByProfile = new Map<string, WiseSubscription[]>();
  for (const profileId of profileIds) {
    const subscriptions = await listProfileSubscriptions(
      ctx,
      profileId,
      context,
    );
    existingByProfile.set(
      profileId,
      subscriptions.filter(
        subscription => subscription.delivery?.url === options.endpointUrl,
      ),
    );
  }
  const anyExisting = [...existingByProfile.values()].some(
    list => list.length > 0,
  );
  if (!createWhenAbsent && !anyExisting) {
    return null;
  }

  const api = ctx.api();
  const kept: string[] = [];
  for (const profileId of profileIds) {
    const ours = existingByProfile.get(profileId) ?? [];
    const keptHere = new Set<string>();
    for (const event of events) {
      const match = ours.find(
        subscription =>
          subscription.trigger_on === event && !keptHere.has(subscription.id),
      );
      if (match) {
        keptHere.add(match.id);
        kept.push(`${profileId}:${match.id}`);
        continue;
      }
      const body = {
        name: `${MAKO_SUBSCRIPTION_NAME_PREFIX} ${event}`,
        trigger_on: event,
        delivery: {
          version: PROFILE_WEBHOOK_SCHEMA_VERSIONS[event],
          url: options.endpointUrl,
        },
      };
      const created = await subscriptionCall(
        ctx,
        "create",
        profileId,
        context,
        headers =>
          api.post(
            `/v3/profiles/${profileId}/subscriptions`,
            body,
            headers ? { headers } : undefined,
          ),
      );
      const id = (created.data as WiseSubscription | undefined)?.id;
      if (!id) {
        throw new Error(
          `Wise created no subscription id for ${event} on profile ${profileId}`,
        );
      }
      keptHere.add(id);
      kept.push(`${profileId}:${id}`);
    }

    // Duplicates and events no longer needed: each would POST to the flow
    // for nothing (or twice).
    for (const subscription of ours) {
      if (keptHere.has(subscription.id)) continue;
      await deleteSubscription(ctx, profileId, context, subscription.id);
    }
  }

  return {
    // Every subscription, as `profileId:subscriptionId`, sorted so the flow
    // file only changes when the set does.
    providerWebhookId: kept.sort().join(","),
    endpointUrl: options.endpointUrl,
  };
}

/** Remove every subscription delivering to `endpointUrl`, on every profile. */
export async function deleteWiseProfileSubscriptions(
  ctx: WiseSubscriptionContext,
  endpointUrl: string,
): Promise<number> {
  const context = { endpointUrl };
  let removed = 0;
  for (const profileId of await ctx.resolveProfileIds()) {
    const subscriptions = await listProfileSubscriptions(
      ctx,
      profileId,
      context,
    );
    for (const subscription of subscriptions) {
      if (subscription.delivery?.url !== endpointUrl) continue;
      await deleteSubscription(ctx, profileId, context, subscription.id);
      removed++;
    }
  }
  return removed;
}
