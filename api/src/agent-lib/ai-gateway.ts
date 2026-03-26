/**
 * Unified AI model resolver.
 *
 * Two modes of operation:
 *
 * 1. **Gateway mode** (AI_GATEWAY_API_KEY is set):
 *    All calls route through Vercel AI Gateway for centralized billing,
 *    observability, and automatic provider failover.
 *
 * 2. **Direct mode** (no gateway key):
 *    Calls go directly to individual providers using their respective
 *    @ai-sdk/* packages. Only providers with configured API keys work.
 *    This is the default for self-hosted / open-source deployments.
 */

import { type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  createGateway,
  type GatewayLanguageModelOptions,
} from "@ai-sdk/gateway";
import { isGatewayMode } from "./ai-models";

export type { GatewayLanguageModelOptions };

// ---------------------------------------------------------------------------
// Lazy-initialized singletons
// ---------------------------------------------------------------------------

let _gateway: ReturnType<typeof createGateway> | null = null;

function getGateway() {
  if (!_gateway) {
    _gateway = createGateway({
      apiKey: process.env.AI_GATEWAY_API_KEY!,
    });
  }
  return _gateway;
}

type DirectProviderFn = (modelName: string) => LanguageModel;
const _directProviders = new Map<string, DirectProviderFn>();

function getDirectProvider(provider: string): DirectProviderFn | undefined {
  if (_directProviders.has(provider)) {
    return _directProviders.get(provider);
  }

  let factory: DirectProviderFn | undefined;

  switch (provider) {
    case "openai": {
      if (!process.env.OPENAI_API_KEY) break;
      const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
      factory = (model: string) => openai(model) as unknown as LanguageModel;
      break;
    }
    case "anthropic": {
      if (!process.env.ANTHROPIC_API_KEY) break;
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
      factory = (model: string) => anthropic(model) as unknown as LanguageModel;
      break;
    }
    case "google": {
      if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) break;
      const google = createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      });
      factory = (model: string) => google(model) as unknown as LanguageModel;
      break;
    }
  }

  if (factory) {
    _directProviders.set(provider, factory);
  }
  return factory;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a model by its ID (e.g. "openai/gpt-5.2", "anthropic/claude-opus-4-6").
 *
 * In gateway mode the ID is passed directly to the Vercel AI Gateway.
 * In direct mode the provider prefix is parsed and the matching @ai-sdk/*
 * package is used.
 */
export function getModel(modelId: string): LanguageModel {
  if (isGatewayMode()) {
    return getGateway()(modelId) as unknown as LanguageModel;
  }

  const slashIdx = modelId.indexOf("/");
  if (slashIdx === -1) {
    throw new Error(
      `Invalid model ID "${modelId}" — expected "provider/model-name" format`,
    );
  }

  const provider = modelId.slice(0, slashIdx);
  const modelName = modelId.slice(slashIdx + 1);
  const factory = getDirectProvider(provider);

  if (!factory) {
    throw new Error(
      `No API key configured for provider "${provider}". ` +
        `Set the appropriate environment variable to use ${modelId}.`,
    );
  }

  return factory(modelName);
}

/**
 * Build `providerOptions` for a request. In gateway mode this attaches
 * user / tag metadata for Vercel-side spend tracking. In direct mode
 * returns an empty object (no gateway-specific options).
 */
export function buildProviderOptions(opts: {
  userId: string;
  workspaceId: string;
  agentId?: string;
  invocationType?: string;
}): Record<string, unknown> {
  if (!isGatewayMode()) return {};

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
