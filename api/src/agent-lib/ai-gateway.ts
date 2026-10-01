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
  const tags: string[] = [`ws:${opts.workspaceId}`];
  if (opts.agentId) tags.push(`agent:${opts.agentId}`);
  if (opts.invocationType) tags.push(`type:${opts.invocationType}`);

  const cacheSession = opts.promptCacheSessionId;
  return {
    gateway: {
      user: opts.userId,
      tags,
      ...(cacheSession ? { caching: "auto" as const } : {}),
    } satisfies GatewayOptions,
    ...(cacheSession ? { openai: { promptCacheKey: cacheSession } } : {}),
  };
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
