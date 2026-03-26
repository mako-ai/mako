/**
 * AI Model Definitions
 *
 * All model IDs use the "provider/model-name" format. When the Vercel AI
 * Gateway is configured (AI_GATEWAY_API_KEY), IDs are passed directly to
 * the gateway. In direct mode, the provider prefix is parsed and the
 * corresponding @ai-sdk/* package is used.
 */

export type AIProvider = "openai" | "anthropic" | "google";

export type ModelTier = "free" | "pro";

export interface AIModel {
  id: string; // "provider/model-name"
  provider: AIProvider;
  name: string;
  description?: string;
  tier: ModelTier;
  supportsThinking?: boolean;
  /**
   * Token budget for extended thinking (when supportsThinking is true).
   * Must be less than the model's max output tokens as known by @ai-sdk/anthropic,
   * because the SDK computes max_tokens = maxOutputTokens + budgetTokens and then
   * clamps to the model's known limit. If budget >= modelCap the API rejects it.
   *
   * Known SDK caps (v3.0.0-beta.96):
   *   claude-opus-4-5, claude-sonnet-4-5: 64 000
   *   claude-opus-4-*  (fallback):        32 000
   */
  thinkingBudgetTokens?: number;
}

export const ALL_MODELS: AIModel[] = [
  // OpenAI
  {
    id: "openai/gpt-5.2-codex",
    provider: "openai",
    name: "GPT-5.2 Codex",
    description: "Previous flagship model with enhanced intelligence",
    tier: "pro",
  },
  {
    id: "openai/gpt-5.2",
    provider: "openai",
    name: "GPT-5.2",
    description: "Previous flagship model with enhanced intelligence",
    tier: "pro",
  },
  {
    id: "openai/gpt-4o",
    provider: "openai",
    name: "GPT-4o",
    description: "Previous generation, reliable and capable",
    tier: "pro",
  },
  {
    id: "openai/gpt-4o-mini",
    provider: "openai",
    name: "GPT-4o Mini",
    description: "Fast and affordable for lightweight tasks",
    tier: "free",
  },
  // Anthropic
  {
    id: "anthropic/claude-opus-4-6",
    provider: "anthropic",
    name: "Claude Opus 4.6",
    description: "Most capable, latest flagship with enhanced reasoning",
    tier: "pro",
    supportsThinking: true,
    thinkingBudgetTokens: 30000,
  },
  {
    id: "anthropic/claude-opus-4-5",
    provider: "anthropic",
    name: "Claude Opus 4.5",
    description: "Previous flagship, autonomous coding for 30+ hours",
    tier: "pro",
    supportsThinking: true,
    thinkingBudgetTokens: 60000,
  },
  {
    id: "anthropic/claude-sonnet-4-5",
    provider: "anthropic",
    name: "Claude Sonnet 4.5",
    description: "Best balance of speed and intelligence",
    tier: "pro",
    supportsThinking: true,
    thinkingBudgetTokens: 60000,
  },
  {
    id: "anthropic/claude-3-5-haiku-latest",
    provider: "anthropic",
    name: "Claude Haiku 4",
    description: "Fastest Claude model",
    tier: "free",
  },
  // Google
  {
    id: "google/gemini-3-pro-preview",
    provider: "google",
    name: "Gemini 3 Pro",
    description: "Flagship multimodal reasoning across text, code, images",
    tier: "pro",
  },
  {
    id: "google/gemini-2.5-pro",
    provider: "google",
    name: "Gemini 3 Pro DeepThink",
    description: "Previous generation, reliable performance",
    tier: "pro",
  },
  {
    id: "google/gemini-2.5-flash",
    provider: "google",
    name: "Gemini 2.5 Flash",
    description: "Fast and efficient for quick tasks",
    tier: "free",
  },
  {
    id: "google/gemma-4-26b-a4b-it",
    provider: "google",
    name: "Gemma 4 26B",
    description:
      "Open model, fast inference with MoE architecture (3.8B active params)",
  },
];

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

export const PROVIDER_ENV_KEYS: Record<AIProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

/**
 * Default model for free-plan users who don't specify a model.
 */
export const DEFAULT_FREE_MODEL_ID = "anthropic/claude-3-5-haiku-latest";

export function isGatewayMode(): boolean {
  return !!process.env.AI_GATEWAY_API_KEY;
}

export function getConfiguredProviders(): AIProvider[] {
  return (Object.entries(PROVIDER_ENV_KEYS) as [AIProvider, string][])
    .filter(([, envKey]) => !!process.env[envKey])
    .map(([provider]) => provider);
}

/**
 * Returns the IDs from the static ALL_MODELS list.
 * Used as the default when a workspace has no enabledModelIds set.
 */
export function getDefaultModelIds(): string[] {
  return ALL_MODELS.map(m => m.id);
}

/**
 * Models available to the current deployment. In gateway mode every model
 * is accessible because the gateway manages provider keys. In direct mode
 * only models whose provider API key is present are returned.
 *
 * When `enabledModelIds` is provided (from workspace settings), the result
 * is filtered to only include those IDs. The returned objects come from
 * ALL_MODELS for backward compatibility with features like `supportsThinking`.
 */
export function getAvailableModels(enabledModelIds?: string[]): AIModel[] {
  let models: AIModel[];

  if (isGatewayMode()) {
    models = ALL_MODELS;
  } else {
    const configured = new Set(getConfiguredProviders());
    models = ALL_MODELS.filter(m => configured.has(m.provider));
  }

  if (enabledModelIds && enabledModelIds.length > 0) {
    const allowed = new Set(enabledModelIds);
    models = models.filter(m => allowed.has(m.id));
  }

  return models;
}

// ---------------------------------------------------------------------------
// Dynamic defaults (pick best available)
// ---------------------------------------------------------------------------

const DEFAULT_PREFERENCE: string[] = [
  "anthropic/claude-opus-4-6",
  "openai/gpt-5.2",
  "google/gemini-3-pro-preview",
  "anthropic/claude-sonnet-4-5",
  "openai/gpt-4o",
  "google/gemini-2.5-pro",
];

const FREE_PREFERENCE: string[] = [
  "anthropic/claude-3-5-haiku-latest",
  "openai/gpt-4o-mini",
  "google/gemini-2.5-flash",
];

const UTILITY_PREFERENCE: string[] = [
  "openai/gpt-4o-mini",
  "anthropic/claude-3-5-haiku-latest",
  "google/gemini-2.5-flash",
  "openai/gpt-4o",
  "anthropic/claude-sonnet-4-5",
  "google/gemini-2.5-pro",
];

function pickFirstAvailable(
  preference: string[],
  available: AIModel[],
): string | undefined {
  const ids = new Set(available.map(m => m.id));
  for (const id of preference) {
    if (ids.has(id)) return id;
  }
  return available[0]?.id;
}

/**
 * Best chat-quality model available in this deployment.
 * Returns undefined when no providers are configured.
 */
export function getDefaultModelId(): string | undefined {
  return pickFirstAvailable(DEFAULT_PREFERENCE, getAvailableModels());
}

/**
 * Best free-tier model available in this deployment.
 * Returns undefined when no providers are configured.
 */
export function getDefaultFreeModelId(): string | undefined {
  return pickFirstAvailable(FREE_PREFERENCE, getAvailableModels());
}

/**
 * Cheapest / fastest model available — used for background tasks like
 * title generation and console descriptions.
 * Returns undefined when no providers are configured.
 */
export function getUtilityModelId(): string | undefined {
  return pickFirstAvailable(UTILITY_PREFERENCE, getAvailableModels());
}

/**
 * Returns the ordered utility model preference list.
 * Useful for building gateway failover lists that stay in sync.
 */
export function getUtilityModelPreference(): readonly string[] {
  return UTILITY_PREFERENCE;
}

/**
 * Get a specific model by its ID.
 */
export function getModelById(modelId: string): AIModel | undefined {
  return ALL_MODELS.find(model => model.id === modelId);
}
