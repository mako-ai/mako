/**
 * Wise profile-level webhook subscriptions, as Mako provisions them for a
 * boxed Wise connector (workspace/webhook-provisioners.ts):
 * `/v3/profiles/{id}/subscriptions` reconciled on every profile the
 * connection syncs, strong customer authentication (SCA) answered with the
 * connection's private key, and refusals explained. Wise signs deliveries
 * with its RSA keys, so the "secret" provisioning returns names the key set
 * (production or sandbox).
 */
import crypto from "node:crypto";
import axios, { AxiosInstance } from "axios";
import type {
  DeleteWebhookSubscriptionOptions,
  ProvisionWebhookOptions,
  ProvisionWebhookResult,
  UpdateWebhookSubscriptionOptions,
} from "../base/BaseConnector";
import {
  createRetryExecutor,
  formatHttpApiError,
  headerValue,
  resolveConfiguredBaseUrl,
  type HeaderBag,
  type RetryExecutor,
} from "../base/http-client";
import { loggers } from "../../logging";

const logger = loggers.connector("wise");

export const WISE_DEFAULT_BASE_URL = "https://api.wise.com";

const SANDBOX_HOST_MARKERS = [
  "sandbox.transferwise.tech",
  "api.sandbox.transferwise",
  "sandbox.wise.com",
];

type WiseErrorBody = {
  error?: string;
  error_description?: string;
  message?: string;
  errors?: Array<{ code?: string; message?: string }>;
};

function describeWiseErrorBody(raw: unknown): string | undefined {
  const data = raw as WiseErrorBody | string | undefined;
  const direct =
    typeof data === "string"
      ? data
      : typeof data?.error_description === "string"
        ? data.error_description
        : typeof data?.message === "string"
          ? data.message
          : typeof data?.error === "string"
            ? data.error
            : undefined;

  const nested = Array.isArray((data as { errors?: unknown[] })?.errors)
    ? (data as Required<Pick<WiseErrorBody, "errors">>).errors
        .map(e => `${e.code ?? "?"}: ${e.message ?? "?"}`)
        .join("; ")
    : undefined;

  return [direct, nested].filter(Boolean).join(" — ");
}

export function formatWiseApiError(error: unknown): string {
  return formatHttpApiError(error, describeWiseErrorBody);
}

export function resolveWiseBaseUrl(configured: unknown): string {
  return resolveConfiguredBaseUrl(configured, WISE_DEFAULT_BASE_URL);
}

export function isWiseSandboxBaseUrl(baseUrl: string): boolean {
  const base = baseUrl.toLowerCase();
  return SANDBOX_HOST_MARKERS.some(marker => base.includes(marker));
}

export function createWiseClient(
  baseURL: string,
  token: string,
): AxiosInstance {
  return axios.create({
    baseURL,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

/**
 * A PEM key as pasted into a single-line secret field: line breaks become
 * spaces, vanish, or arrive as literal "\n". Rebuild the PEM (header, base64
 * body in 64-character lines, footer) so node's crypto can read it.
 */
export function normalizePemKey(raw: string): string {
  const text = raw.replace(/\\n/g, "\n").trim();
  const match = text.match(
    /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/,
  );
  if (!match) return text;
  const body = match[2].replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return (
    [`-----BEGIN ${match[1]}-----`, ...lines, `-----END ${match[1]}-----`].join(
      "\n",
    ) + "\n"
  );
}

/** SHA-256 of a private key's public half (DER), hex: identifies the key, reveals nothing. */
export function publicKeyFingerprint(privatePem: string): string {
  const der = crypto
    .createPublicKey(privatePem)
    .export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
}

export interface ScaMessages {
  /** A 403 that carries no challenge: nothing Mako can sign. */
  noChallenge: string;
  /** A challenge, but no private key on the connection to sign it with. */
  noKey: string;
}

/**
 * Send a request, answering Wise's strong customer authentication: a 403
 * carrying `x-2fa-approval` is retried once with that one-time token signed
 * (SHA256withRSA) by `privateKey`. `messages` explain the two refusals Mako
 * cannot answer itself (no challenge to sign, no key to sign with).
 */
export async function sendWithSca<T>(
  execute: RetryExecutor,
  privateKey: unknown,
  send: (headers?: Record<string, string>) => Promise<T>,
  messages: ScaMessages,
): Promise<T> {
  try {
    return await execute(() => send());
  } catch (error) {
    const response = axios.isAxiosError(error) ? error.response : undefined;
    const approval =
      response?.status === 403
        ? headerValue((response.headers ?? {}) as HeaderBag, "x-2fa-approval")
        : undefined;
    if (!approval) {
      if (response?.status === 403) {
        throw new Error(messages.noChallenge, { cause: error });
      }
      throw error;
    }

    if (typeof privateKey !== "string" || privateKey.trim().length === 0) {
      throw new Error(messages.noKey, { cause: error });
    }
    const pem = normalizePemKey(privateKey);
    const signature = crypto
      .createSign("SHA256")
      .update(approval)
      .sign(pem, "base64");
    try {
      return await execute(() =>
        send({ "x-2fa-approval": approval, "X-Signature": signature }),
      );
    } catch (signedError) {
      // Wise says why it refused a signed request in x-2fa-approval-result;
      // the key's fingerprint (SHA-256 of its public key, never the key)
      // tells which key signed, to compare with the one registered in Wise
      const signedResponse = axios.isAxiosError(signedError)
        ? signedError.response
        : undefined;
      const result = headerValue(
        (signedResponse?.headers ?? {}) as HeaderBag,
        "x-2fa-approval-result",
      );
      const body =
        typeof signedResponse?.data === "string"
          ? signedResponse.data
          : JSON.stringify(signedResponse?.data ?? "");
      throw new Error(
        `Wise refused the signed (SCA) request: HTTP ${signedResponse?.status ?? "?"}` +
          `, x-2fa-approval-result: ${result ?? "none"}` +
          `, signed with key ${publicKeyFingerprint(pem)}` +
          (body && body !== '""' ? `, body: ${body.slice(0, 300)}` : ""),
        { cause: signedError },
      );
    }
  }
}

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

/** The entity each supported event writes. */
const EVENT_ENTITIES: Record<string, string> = {
  "transfers#state-change": "transfers",
  "transfers#refund": "transfers",
  "transfers#payout-failure": "transfers",
  "transfers#active-cases": "transfers",
  "balances#update": "balance_updates",
  "balances#account-state-change": "balances",
  "profiles#state-change": "profiles",
  "recipients#state-change": "recipients",
};

export function wiseWebhookEventsForEntities(entities: string[]): string[] {
  if (entities.length === 0) {
    return [...WISE_SUPPORTED_WEBHOOK_EVENTS];
  }

  const entitySet = new Set(entities.map(e => e.toLowerCase()));
  return WISE_SUPPORTED_WEBHOOK_EVENTS.filter(eventType => {
    const entity = EVENT_ENTITIES[eventType];
    return entity ? entitySet.has(entity.toLowerCase()) : false;
  });
}

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

type WiseProfile = { id?: unknown };

/**
 * Wise provisioning on a connection's `api_key`, `profile_id`,
 * `api_base_url` and `sca_private_key`: subscriptions on every profile the
 * connection syncs (`profile_id`, or every profile the token sees). `api`
 * replaces the client in tests.
 */
export function wiseWebhookProvisioning(
  config: Record<string, unknown>,
  api?: AxiosInstance,
) {
  const baseUrl = resolveWiseBaseUrl(config.api_base_url);
  let client: AxiosInstance | null = api ?? null;
  const getClient = (): AxiosInstance => {
    if (!client) {
      if (!config.api_key) {
        throw new Error("Wise API token not configured");
      }
      client = createWiseClient(baseUrl, String(config.api_key));
    }
    return client;
  };
  // Shared policy: backoff with jitter, Retry-After, 429/5xx/network.
  const execute = createRetryExecutor({
    label: "Wise",
    logger,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    formatError: formatWiseApiError,
  });

  let cachedProfiles: WiseProfile[] | null = null;
  const listProfiles = async (): Promise<WiseProfile[]> => {
    if (cachedProfiles) return cachedProfiles;
    const response = await execute(() => getClient().get("/v2/profiles"));
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

  // The value stored as the flow's webhook "secret": which Wise public key
  // set verifies deliveries.
  const webhookKeySet = () =>
    isWiseSandboxBaseUrl(baseUrl) ? "sandbox" : "production";

  const ctx: WiseSubscriptionContext = {
    api: getClient,
    execute,
    scaPrivateKey: () => config.sca_private_key,
    resolveProfileIds,
    webhookKeySet,
    supportedEvents: () => [...WISE_SUPPORTED_WEBHOOK_EVENTS],
    eventsForEntities: wiseWebhookEventsForEntities,
  };

  return {
    /**
     * Subscribe `endpointUrl` to the flow's events on every profile.
     * Idempotent: an existing subscription with the same URL and event is
     * reused, so creating twice creates nothing new.
     */
    async create(
      options: ProvisionWebhookOptions,
    ): Promise<ProvisionWebhookResult> {
      const result = await reconcileWiseProfileSubscriptions(
        ctx,
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
    async update(
      options: UpdateWebhookSubscriptionOptions,
    ): Promise<ProvisionWebhookResult | null> {
      const result = await reconcileWiseProfileSubscriptions(
        ctx,
        options,
        false,
      );
      // Wise signs with its public keys: the "secret" is only the key set,
      // the same whether the subscription is new or adopted.
      return result ? { ...result, signingSecret: webhookKeySet() } : null;
    },
    /** Remove every subscription delivering to `endpointUrl`, on every profile. */
    delete(options: DeleteWebhookSubscriptionOptions): Promise<number> {
      return deleteWiseProfileSubscriptions(ctx, options.endpointUrl);
    },
  };
}
