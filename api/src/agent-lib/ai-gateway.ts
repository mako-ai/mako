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

/**
 * Build `providerOptions` for a request. Attaches user / tag metadata
 * for Vercel-side spend tracking.
 */
export function buildProviderOptions(opts: {
  userId: string;
  workspaceId: string;
  agentId?: string;
  invocationType?: string;
}): Record<string, any> {
  return {
    gateway: gatewayAttributionOptions({
      userId: opts.userId,
      workspaceId: opts.workspaceId,
      agentId: opts.agentId,
      invocationType: opts.invocationType ?? "chat",
    }),
  };
}

/** `providerOptions` for a call made on behalf of nobody in particular. */
export function systemProviderOptions(
  invocationType: string,
  workspaceId?: string,
): Record<string, any> {
  return {
    gateway: gatewayAttributionOptions({ workspaceId, invocationType }),
  };
}
