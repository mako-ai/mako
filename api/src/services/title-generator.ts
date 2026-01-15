/**
 * Title Generation Service
 * Uses AI SDK generateText for simple, fast title generation
 */

import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { loggers } from "../logging";

const logger = loggers.agent();

const TITLE_SYSTEM_PROMPT = `You are a title generator. Generate a concise 3-8 word title for a chat conversation.

Rules:
- Be specific and descriptive
- Use noun phrases that capture the main topic or task
- Avoid generic phrases like "Conversation", "Chat", "Question", "Help", "Assistance"
- Focus on the core subject matter or goal
- Examples: "Sales Revenue Analysis", "Customer Churn Prediction", "MongoDB Query Optimization"

Return only the title, nothing else.`;

/**
 * Extract text content from a message (handles both v2 .content and v6 .parts formats)
 */
const getMessageContent = (message: any): string => {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (Array.isArray(message.parts)) {
    return message.parts
      .filter((p: any) => p.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("");
  }

  return "";
};

/**
 * Generate a title from the first user message content
 * Simple and fast - just needs the user's initial message
 */
export const generateChatTitle = async (
  userMessageContent: string,
): Promise<string> => {
  try {
    const { text } = await generateText({
      model: openai("gpt-4o-mini") as any,
      system: TITLE_SYSTEM_PROMPT,
      prompt: userMessageContent.substring(0, 2000), // Limit input length
    });

    let title = text.trim();
    title = title.replace(/^["']|["']$/g, ""); // Remove quotes
    title = title.substring(0, 80); // Character limit

    // Fallback if title is too short or empty
    if (title.length < 3) {
      return "New Conversation";
    }

    return title;
  } catch (error) {
    logger.error("Title generation failed", { error });
    return "New Conversation";
  }
};

/**
 * Legacy function for backward compatibility with existing code
 * Extracts first user message and generates title
 */
export const generateChatTitleFromMessages = async (
  messages: any[],
): Promise<string> => {
  const firstUserMessage = messages.find(m => m.role === "user");
  if (!firstUserMessage) {
    return "New Conversation";
  }

  const content = getMessageContent(firstUserMessage);
  if (!content || content.trim().length < 3) {
    return "New Conversation";
  }

  return generateChatTitle(content);
};

/**
 * Check if we should generate a title (for backward compatibility)
 * Now simplified: generate if there's at least one user message with content
 */
export const shouldGenerateTitle = (messages: any[]): boolean => {
  const firstUserMessage = messages.find(m => m.role === "user");
  if (!firstUserMessage) return false;

  const content = getMessageContent(firstUserMessage);
  return content.trim().length >= 3;
};
