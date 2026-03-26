/**
 * Centralized AI Gateway provider.
 *
 * All LLM calls route through Vercel AI Gateway for unified billing,
 * observability, and automatic provider failover.
 *
 * Authentication:
 *  - On Vercel: automatic OIDC (no key needed)
 *  - Locally / self-hosted: set AI_GATEWAY_API_KEY env var
 */

import { createGateway, type LanguageModel } from "ai";
import type { GatewayLanguageModelOptions } from "@ai-sdk/gateway";

const gateway = createGateway({
  apiKey: process.env.AI_GATEWAY_API_KEY ?? "",
});

export { gateway };
export type { GatewayLanguageModelOptions };

/**
 * Resolve a model by its gateway-format ID (e.g. "openai/gpt-5.2").
 * Returns a LanguageModel that can be passed to streamText / generateText.
 */
export function getModel(gatewayModelId: string): LanguageModel {
  return gateway(gatewayModelId) as unknown as LanguageModel;
}

/**
 * Build the `providerOptions.gateway` object for a request,
 * attaching user and tag metadata for Vercel-side spend tracking.
 */
export function buildGatewayProviderOptions(opts: {
  userId: string;
  workspaceId: string;
  agentId?: string;
  invocationType?: string;
}): { gateway: GatewayLanguageModelOptions } {
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
