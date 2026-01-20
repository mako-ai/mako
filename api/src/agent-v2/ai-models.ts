/**
 * AI Model Definitions
 * Defines available models across providers and checks availability based on API keys
 */

export type AIProvider = "openai" | "anthropic" | "google";

export interface AIModel {
  id: string;
  provider: AIProvider;
  name: string;
  description?: string;
}

/**
 * All supported AI models across providers
 * Updated December 2025 with latest models
 */
export const ALL_MODELS: AIModel[] = [
  // OpenAI - GPT-5.2 series (released Dec 11, 2025)
  {
    id: "gpt-5.2",
    provider: "openai",
    name: "GPT-5.2",
    description: "Latest flagship model with enhanced intelligence",
  },
  {
    id: "gpt-4o",
    provider: "openai",
    name: "GPT-4o",
    description: "Previous generation, reliable and capable",
  },
  // Anthropic - Claude 4.5 series (latest)
  {
    id: "claude-opus-4-5",
    provider: "anthropic",
    name: "Claude Opus 4.5",
    description: "Most capable, autonomous coding for 30+ hours",
  },
  {
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    name: "Claude Sonnet 4.5",
    description: "Best balance of speed and intelligence",
  },
  {
    id: "claude-3-5-haiku-latest",
    provider: "anthropic",
    name: "Claude Haiku 4",
    description: "Fastest Claude model",
  },
  // Google - Gemini 3 series (released Nov 18, 2025)
  {
    id: "gemini-3-pro-preview",
    provider: "google",
    name: "Gemini 3 Pro",
    description: "Flagship multimodal reasoning across text, code, images",
  },
  {
    id: "gemini-2.5-pro",
    provider: "google",
    name: "Gemini 3 Pro DeepThink",
    description: "Previous generation, reliable performance",
  },
  {
    id: "gemini-2.5-flash",
    provider: "google",
    name: "Gemini 2.5 Flash",
    description: "Fast and efficient for quick tasks",
  },
];

/**
 * Check which providers have API keys configured
 */
export function getConfiguredProviders(): Set<AIProvider> {
  const providers = new Set<AIProvider>();

  if (process.env.OPENAI_API_KEY) {
    providers.add("openai");
  }
  if (process.env.ANTHROPIC_API_KEY) {
    providers.add("anthropic");
  }
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    providers.add("google");
  }

  return providers;
}

/**
 * Get list of available models based on configured API keys
 */
export function getAvailableModels(): AIModel[] {
  const configuredProviders = getConfiguredProviders();

  return ALL_MODELS.filter(model => configuredProviders.has(model.provider));
}

/**
 * Get a specific model by ID
 */
export function getModelById(modelId: string): AIModel | undefined {
  return ALL_MODELS.find(model => model.id === modelId);
}

/**
 * Get the default model (Claude Opus 4.5 if available, otherwise first available)
 */
export function getDefaultModel(): AIModel {
  const available = getAvailableModels();
  const opus = available.find(m => m.id === "claude-opus-4-5");
  return opus || available[0] || ALL_MODELS[0];
}
