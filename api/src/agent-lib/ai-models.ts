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
 * Models available to the current deployment. When `enabledModelIds` is
 * provided (from workspace settings), the result is filtered to only those.
 */
export async function getAvailableModels(
  enabledModelIds?: string[],
): Promise<AIModel[]> {
  let models = (await getCatalogModels()).map(catalogToAIModel);

  if (enabledModelIds && enabledModelIds.length > 0) {
    const allowed = new Set(enabledModelIds);
    models = models.filter(m => allowed.has(m.id));
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
