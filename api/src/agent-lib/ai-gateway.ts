/**
 * Unified AI model resolver.
 *
 * All calls route through the Vercel AI Gateway for centralized billing,
 * observability, and automatic provider failover.
 * AI_GATEWAY_API_KEY is required.
 */

import { type LanguageModel } from "ai";
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
 * Build `providerOptions` for a request. Attaches user / tag metadata
 * for Vercel-side spend tracking.
 */
export function buildProviderOptions(opts: {
  userId: string;
  workspaceId: string;
  agentId?: string;
  invocationType?: string;
}): Record<string, any> {
  const tags: string[] = [`ws:${opts.workspaceId}`];
  if (opts.agentId) tags.push(`agent:${opts.agentId}`);
  if (opts.invocationType) tags.push(`type:${opts.invocationType}`);

  return {
    gateway: {
      user: opts.userId,
      tags,
    } satisfies GatewayLanguageModelOptions,
  };
}
