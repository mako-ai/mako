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
    id: "gpt-5.2-thinking",
    provider: "openai",
    name: "GPT-5.2 Thinking",
    description: "Optimized for complex reasoning and coding",
  },
  {
    id: "gpt-5.2-instant",
    provider: "openai",
    name: "GPT-5.2 Instant",
    description: "Fast responses for writing and research",
  },
  {
    id: "gpt-4.5",
    provider: "openai",
    name: "GPT-4.5",
    description: "Real-time web analysis capabilities",
  },
  {
    id: "gpt-4o",
    provider: "openai",
    name: "GPT-4o",
    description: "Previous generation, reliable and capable",
  },
  // Anthropic - Claude 4.5 series (latest)
  {
    id: "claude-opus-4.5",
    provider: "anthropic",
    name: "Claude Opus 4.5",
    description: "Most capable, autonomous coding for 30+ hours",
  },
  {
    id: "claude-sonnet-4.5",
    provider: "anthropic",
    name: "Claude Sonnet 4.5",
    description: "Best balance of speed and intelligence",
  },
  {
    id: "claude-sonnet-4-20250514",
    provider: "anthropic",
    name: "Claude Sonnet 4",
    description: "Previous generation Sonnet",
  },
  {
    id: "claude-haiku-4",
    provider: "anthropic",
    name: "Claude Haiku 4",
    description: "Fastest Claude model",
  },
  // Google - Gemini 3 series (released Nov 18, 2025)
  {
    id: "gemini-3-pro",
    provider: "google",
    name: "Gemini 3 Pro",
    description: "Flagship multimodal reasoning across text, code, images",
  },
  {
    id: "gemini-3-pro-deepthink",
    provider: "google",
    name: "Gemini 3 Pro DeepThink",
    description: "Advanced reasoning for complex problem-solving",
  },
  {
    id: "gemini-2.5-flash",
    provider: "google",
    name: "Gemini 2.5 Flash",
    description: "Fast and efficient for quick tasks",
  },
  {
    id: "gemini-2.5-pro",
    provider: "google",
    name: "Gemini 2.5 Pro",
    description: "Previous generation, reliable performance",
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
 * Get the default model (first available, or gpt-5.2 as fallback)
 */
export function getDefaultModel(): AIModel {
  const available = getAvailableModels();
  return available[0] || ALL_MODELS[0];
}
