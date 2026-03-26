/**
 * AI Model Definitions
 *
 * All model IDs use the gateway format ("provider/model-name") so they can
 * be passed directly to the Vercel AI Gateway via getModel().
 */

export type AIProvider = "openai" | "anthropic" | "google";

export interface AIModel {
  id: string; // Gateway-format: "provider/model-name"
  provider: AIProvider;
  name: string;
  description?: string;
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

/**
 * All supported AI models across providers.
 * IDs are in gateway format so they route through Vercel AI Gateway.
 */
export const ALL_MODELS: AIModel[] = [
  // OpenAI
  {
    id: "openai/gpt-5.2-codex",
    provider: "openai",
    name: "GPT-5.2 Codex",
    description: "Previous flagship model with enhanced intelligence",
  },
  {
    id: "openai/gpt-5.2",
    provider: "openai",
    name: "GPT-5.2",
    description: "Previous flagship model with enhanced intelligence",
  },
  {
    id: "openai/gpt-4o",
    provider: "openai",
    name: "GPT-4o",
    description: "Previous generation, reliable and capable",
  },
  // Anthropic
  {
    id: "anthropic/claude-opus-4-6",
    provider: "anthropic",
    name: "Claude Opus 4.6",
    description: "Most capable, latest flagship with enhanced reasoning",
    supportsThinking: true,
    thinkingBudgetTokens: 30000,
  },
  {
    id: "anthropic/claude-opus-4-5",
    provider: "anthropic",
    name: "Claude Opus 4.5",
    description: "Previous flagship, autonomous coding for 30+ hours",
    supportsThinking: true,
    thinkingBudgetTokens: 60000,
  },
  {
    id: "anthropic/claude-sonnet-4-5",
    provider: "anthropic",
    name: "Claude Sonnet 4.5",
    description: "Best balance of speed and intelligence",
    supportsThinking: true,
    thinkingBudgetTokens: 60000,
  },
  {
    id: "anthropic/claude-3-5-haiku-latest",
    provider: "anthropic",
    name: "Claude Haiku 4",
    description: "Fastest Claude model",
  },
  // Google
  {
    id: "google/gemini-3-pro-preview",
    provider: "google",
    name: "Gemini 3 Pro",
    description: "Flagship multimodal reasoning across text, code, images",
  },
  {
    id: "google/gemini-2.5-pro",
    provider: "google",
    name: "Gemini 3 Pro DeepThink",
    description: "Previous generation, reliable performance",
  },
  {
    id: "google/gemini-2.5-flash",
    provider: "google",
    name: "Gemini 2.5 Flash",
    description: "Fast and efficient for quick tasks",
  },
];

/**
 * Default model ID (gateway format) used when no model is specified.
 */
export const DEFAULT_MODEL_ID = "openai/gpt-5.2";

/**
 * Lightweight models used for background tasks (title gen, descriptions).
 */
export const UTILITY_MODEL_ID = "openai/gpt-4o-mini";

/**
 * Get list of all available models.
 * With the AI Gateway, provider API keys are managed centrally --
 * all models are available regardless of local env vars.
 */
export function getAvailableModels(): AIModel[] {
  return ALL_MODELS;
}

/**
 * Get a specific model by its gateway ID.
 */
export function getModelById(modelId: string): AIModel | undefined {
  return ALL_MODELS.find(model => model.id === modelId);
}

/**
 * Get the default model.
 */
export function getDefaultModel(): AIModel {
  return (
    ALL_MODELS.find(m => m.id === "anthropic/claude-opus-4-6") || ALL_MODELS[0]
  );
}
