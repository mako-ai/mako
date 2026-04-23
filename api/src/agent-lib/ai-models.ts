/**
 * AI Model Definitions
 *
 * Thin delegation layer over model-catalog.service.ts. All model IDs use
 * the "provider/model-name" format and route through the Vercel AI Gateway.
 */

import {
  getCatalogModels,
  getCatalogModel,
  getDefaultChatModelId,
  getDefaultFreeChatModelId,
  getUtilityChatModelId,
  type CatalogModel,
} from "../services/model-catalog.service";

export type AIProvider = string;

export type ModelTier = "free" | "pro";

export interface AIModel {
  id: string;
  provider: string;
  name: string;
  description?: string;
  tier?: ModelTier;
  supportsThinking?: boolean;
  thinkingBudgetTokens?: number;
}

function catalogToAIModel(cm: CatalogModel): AIModel {
  return {
    id: cm.id,
    provider: cm.provider,
    name: cm.name,
    description: cm.description,
    tier: cm.tier,
    supportsThinking: cm.supportsThinking,
    thinkingBudgetTokens: cm.thinkingBudgetTokens,
  };
}

/**
 * Models available to the current deployment. When `disabledModelIds` is
 * provided (from workspace settings), those models are filtered out of the
 * super-admin-curated catalog. An empty or missing blocklist means every
 * curated model is available — the desired default so that new models the
 * super admin makes visible propagate to every workspace automatically.
 */
export async function getAvailableModels(
  disabledModelIds?: string[],
): Promise<AIModel[]> {
  let models = (await getCatalogModels()).map(catalogToAIModel);

  if (disabledModelIds && disabledModelIds.length > 0) {
    const blocked = new Set(disabledModelIds);
    models = models.filter(m => !blocked.has(m.id));
  }

  return models;
}

export async function getDefaultModelId(): Promise<string> {
  return getDefaultChatModelId();
}

export async function getDefaultFreeModelId(): Promise<string> {
  return getDefaultFreeChatModelId();
}

export async function getUtilityModelId(): Promise<string> {
  return getUtilityChatModelId();
}

export async function getModelById(
  modelId: string,
): Promise<AIModel | undefined> {
  const cm = await getCatalogModel(modelId);
  return cm ? catalogToAIModel(cm) : undefined;
}
