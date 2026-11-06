/**
 * Unified AI model resolver.
 *
 * All calls route through the Vercel AI Gateway for centralized billing,
 * observability, and automatic provider failover.
 * AI_GATEWAY_API_KEY is required.
 */

import { type EmbeddingModel, type LanguageModel } from "ai";
import {
  createGateway,
  type GatewayLanguageModelOptions,
} from "@ai-sdk/gateway";

export type { GatewayLanguageModelOptions };

// ---------------------------------------------------------------------------
// Lazy-initialized singleton
// ---------------------------------------------------------------------------

let _gateway: ReturnType<typeof createGateway> | null = null;

function getGateway() {
  if (!_gateway) {
    _gateway = createGateway({
      apiKey: process.env.AI_GATEWAY_API_KEY ?? "",
      // Optional override (testing / self-hosted gateway proxies). The
      // @ai-sdk/gateway package only reads the option, not an env var.
      ...(process.env.AI_GATEWAY_BASE_URL
        ? { baseURL: process.env.AI_GATEWAY_BASE_URL }
        : {}),
    });
  }
  return _gateway;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a model by its ID (e.g. "openai/gpt-5.2", "anthropic/claude-opus-4-6").
 * The ID is passed directly to the Vercel AI Gateway.
 */
export function getModel(modelId: string): LanguageModel {
  return getGateway()(modelId) as unknown as LanguageModel;
}

/**
 * Resolve a text-embedding model by its ID (e.g. "openai/text-embedding-3-small").
 * The ID is passed directly to the Vercel AI Gateway.
 */
export function getEmbeddingModel(modelId: string): EmbeddingModel {
  return getGateway().textEmbeddingModel(modelId) as unknown as EmbeddingModel;
}

// ---------------------------------------------------------------------------
// Spend attribution
// ---------------------------------------------------------------------------

/**
 * The `user` stamped on gateway calls that no person triggered — a model
 * probe at catalog refresh, an index rebuild. Vercel's report groups spend
 * by this value, so unattended traffic has one recognisable bucket rather
 * than an empty one.
 */
export const SYSTEM_ATTRIBUTION_USER = "system";

/**
 * Who and what a gateway request is for. Every call through the gateway
 * carries one of these: Vercel's Custom Reporting groups spend by `user`
 * and by `tag`, and the workspace connector `usage-by-tag` / `usage-by-user`
 * entities land those groupings in the warehouse. An unattributed request
 * is a row with an empty tag that nobody can explain, so the helpers below
 * always emit a `type:` tag and a user, falling back to `system`.
 *
 * Tags are `ws:<workspaceId>`, `agent:<agentId>`, `type:<invocationType>`.
 * Vercel accepts at most 10 tags of 1–64 chars and a user of ≤256 chars;
 * every value here is well inside that.
 */
export interface GatewayAttribution {
  userId?: string;
  workspaceId?: string;
  agentId?: string;
  /** What kind of call: `chat`, `embedding`, `compaction`, `model_probe`, … */
  invocationType: string;
}

/** The `gateway` provider-options block for an attribution. */
export function gatewayAttributionOptions(
  attribution: GatewayAttribution,
): GatewayLanguageModelOptions {
  const tags: string[] = [];
  if (attribution.workspaceId) tags.push(`ws:${attribution.workspaceId}`);
  if (attribution.agentId) tags.push(`agent:${attribution.agentId}`);
  tags.push(`type:${attribution.invocationType}`);
  return {
    user: attribution.userId || SYSTEM_ATTRIBUTION_USER,
    tags,
  };
}

/** Vercel's limits on a request's tags. */
const MAX_TAGS = 10;
const MAX_TAG_CHARS = 64;
/** Tags only Mako sets: a step cannot bill its calls to another workspace. */
const RESERVED_TAG = /^(ws|agent|type):/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Stamp an attribution on the JSON body of a request Mako forwards to the
 * gateway for someone else's code (a workflow step). Mako's user and tags win
 * over whatever the step sent. The step's other options and its own tags stay.
 * A body that is not a JSON object goes through as it came.
 */
export function withGatewayAttribution(
  body: string,
  attribution: GatewayAttribution,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isRecord(parsed)) return body;
  const providerOptions = isRecord(parsed.providerOptions)
    ? parsed.providerOptions
    : {};
  const gateway = isRecord(providerOptions.gateway)
    ? providerOptions.gateway
    : {};
  const stepTags = Array.isArray(gateway.tags)
    ? gateway.tags.filter(
        (tag): tag is string =>
          typeof tag === "string" &&
          tag.length >= 1 &&
          tag.length <= MAX_TAG_CHARS &&
          !RESERVED_TAG.test(tag),
      )
    : [];
  const { user, tags = [] } = gatewayAttributionOptions(attribution);
  return JSON.stringify({
    ...parsed,
    providerOptions: {
      ...providerOptions,
      gateway: {
        ...gateway,
        user,
        tags: [...tags, ...stepTags].slice(0, MAX_TAGS),
      },
    },
  });
}

/**
 * Gateway options, plus `caching` — a Gateway feature newer than the pinned
 * `@ai-sdk/gateway` types (it arrives with the package `ai` depends on). The
 * client posts `providerOptions` to the Gateway verbatim, so the field works
 * today; drop this extension once the bundled types carry it.
 */
type GatewayOptions = GatewayLanguageModelOptions & { caching?: "auto" };

/**
 * Build `providerOptions` for a request. Attaches user / tag metadata
 * for Vercel-side spend tracking.
 *
 * Pass `promptCacheSessionId` (a stable, opaque id such as the chat id) for
 * multi-step / multi-turn traffic that re-sends a growing prompt:
 * - `gateway.caching: "auto"` makes the Gateway add Anthropic `cache_control`
 *   breakpoints on the last message (and before the last user message), so
 *   each agent step reads the previous step's prompt from cache instead of
 *   paying full input price for the whole history again. Providers that cache
 *   implicitly (OpenAI, Google, DeepSeek) are left untouched.
 * - `openai.promptCacheKey` routes the session's requests to the same OpenAI
 *   cache shard, which raises implicit-cache hit rates.
 * Leave it unset for one-shot calls: an Anthropic cache write costs 1.25× and
 * pays off only when a later request reads it.
 */
export function buildProviderOptions(opts: {
  userId: string;
  workspaceId: string;
  agentId?: string;
  invocationType?: string;
  promptCacheSessionId?: string;
}): Record<string, any> {
  const cacheSession = opts.promptCacheSessionId;
  return {
    gateway: {
      ...gatewayAttributionOptions({
        userId: opts.userId,
        workspaceId: opts.workspaceId,
        agentId: opts.agentId,
        invocationType: opts.invocationType ?? "chat",
      }),
      ...(cacheSession ? { caching: "auto" as const } : {}),
    } satisfies GatewayOptions,
    ...(cacheSession ? { openai: { promptCacheKey: cacheSession } } : {}),
  };
}

/** `providerOptions` carrying only an attribution. */
export function attributionProviderOptions(
  attribution: GatewayAttribution,
): Record<string, any> {
  return { gateway: gatewayAttributionOptions(attribution) };
}

/** `providerOptions` for a call made on behalf of nobody in particular. */
export function systemProviderOptions(
  invocationType: string,
  workspaceId?: string,
): Record<string, any> {
  return attributionProviderOptions({ workspaceId, invocationType });
}

/**
 * Request headers that keep a session's requests on the same provider-side
 * prompt cache. The Gateway forwards `x-session-affinity` to providers that
 * support it; it never changes routing. The id must be opaque (no personal
 * data) and stable for the conversation.
 */
export function buildPromptCacheHeaders(
  sessionId: string,
): Record<string, string> {
  return { "x-session-affinity": sessionId };
}
