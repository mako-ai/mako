/**
 * Title Generation Service
 * Uses AI Gateway + generateText for simple, fast title generation.
 */

import { generateText } from "ai";
import { getModel, buildProviderOptions } from "../agent-lib/ai-gateway";
import { getUtilityModelId } from "../agent-lib/ai-models";
import { trackUsage } from "./llm-usage.service";
import { loggers } from "../logging";
import { toNum } from "../utils/safe-num";

const logger = loggers.agent();

const TITLE_SYSTEM_PROMPT = `You are a title generator. Generate a concise 3-8 word title for a chat conversation.

Rules:
- Be specific and descriptive
- Use noun phrases that capture the main topic or task
- Avoid generic phrases like "Conversation", "Chat", "Question", "Help", "Assistance"
- Focus on the core subject matter or goal
- Examples: "Sales Revenue Analysis", "Customer Churn Prediction", "MongoDB Query Optimization"

Return only the title, nothing else.`;

export interface TitleGenerationContext {
  workspaceId: string;
  userId: string;
}

/**
 * Generate a title from the first user message content.
 */
export const generateChatTitle = async (
  userMessageContent: string,
  ctx?: TitleGenerationContext,
): Promise<string> => {
  try {
    const modelId = getUtilityModelId();
    if (!modelId) {
      logger.warn("No AI provider configured, skipping title generation");
      return "New Conversation";
    }
    const { text, usage } = await generateText({
      model: getModel(modelId),
      system: TITLE_SYSTEM_PROMPT,
      prompt: userMessageContent.substring(0, 2000),
      providerOptions: {
        ...buildProviderOptions({
          userId: ctx?.userId ?? "unknown",
          workspaceId: ctx?.workspaceId ?? "unknown",
          invocationType: "title_generation",
        }),
      },
    });

    if (ctx) {
      const u = usage as Record<string, unknown>;
      const inputTokens =
        u.promptTokens !== undefined
          ? toNum(u.promptTokens)
          : toNum(u.inputTokens);
      const outputTokens =
        u.completionTokens !== undefined
          ? toNum(u.completionTokens)
          : toNum(u.outputTokens);
      void trackUsage({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        invocationType: "title_generation",
        modelId,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      }).catch(err =>
        logger.warn("Failed to track title generation usage", { error: err }),
      );
    }

    let title = text.trim();
    title = title.replace(/^["']|["']$/g, "");
    title = title.substring(0, 80);

    if (title.length < 3) {
      return "New Conversation";
    }

    return title;
  } catch (error) {
    logger.error("Title generation failed", { error });
    return "New Conversation";
  }
};
