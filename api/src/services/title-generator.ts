// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – module will be provided via dependency at runtime
import { Agent, run as runAgent } from "@openai/agents";

// ------------------------------------------------------------------------------------
// Title Generation Service
// ------------------------------------------------------------------------------------

// Simple title generation agent for creating concise chat titles
const titleAgent = new Agent({
  name: "Title Generator",
  instructions: `You are a title generator. Your job is to create short, descriptive titles for chat conversations.

Rules:
- Generate titles that are 3-8 words long
- Use noun phrases that capture the main topic or task
- Be specific and descriptive
- Avoid generic phrases like "Conversation", "Chat", "Question", etc.
- Focus on the core subject matter or goal
- Examples of good titles: "Sales Revenue Analysis", "Customer Churn Prediction", "MongoDB Query Optimization", "Product Performance Dashboard"

Return only the title, nothing else.`,
  model: "gpt-4o-mini", // Use a lighter model for title generation
});

/**
 * Extract text content from a message (handles both v2 .content and v6 .parts formats)
 */
const getMessageContent = (message: any): string => {
  // V2 format: message.content is a string
  if (typeof message.content === "string") {
    return message.content;
  }

  // V6 format: message.parts is an array with { type: "text", text: string }
  if (Array.isArray(message.parts)) {
    return message.parts
      .filter((p: any) => p.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("");
  }

  return "";
};

/**
 * Count approximate tokens in a string (rough estimation)
 */
const estimateTokens = (text: string): number => {
  // Rough approximation: ~4 characters per token
  return Math.ceil(text.length / 4);
};

/**
 * Check if we have enough context to generate a meaningful title
 */
export const shouldGenerateTitle = (messages: any[]): boolean => {
  // Need at least one complete exchange: user message + assistant response
  if (messages.length < 2) return false;

  // Check that we have at least one user message and one assistant message
  const userMessages = messages.filter(m => m.role === "user");
  const assistantMessages = messages.filter(m => m.role === "assistant");

  if (userMessages.length < 1 || assistantMessages.length < 1) return false;

  // Check token count of the first user message to ensure it's substantial
  const firstUserMessage = userMessages[0];
  const userTokens = estimateTokens(getMessageContent(firstUserMessage));

  // Generate title from the very first exchange (user + assistant)
  // A minimum of 3 tokens ensures it's not just "hi" or similar trivial inputs
  const hasSubstantialContent = userTokens >= 3;
  const hasMultipleExchanges = userMessages.length >= 2;

  // Always generate on first complete exchange (1 user + 1 assistant message)
  const hasFirstExchange =
    userMessages.length >= 1 && assistantMessages.length >= 1;

  const shouldGenerate =
    hasFirstExchange && (hasSubstantialContent || hasMultipleExchanges);

  console.log("Title generation check:", {
    messageCount: messages.length,
    userMessages: userMessages.length,
    assistantMessages: assistantMessages.length,
    firstUserTokens: userTokens,
    hasSubstantialContent,
    hasFirstExchange,
    hasMultipleExchanges,
    shouldGenerate,
  });

  return shouldGenerate;
};

/**
 * Generate a descriptive title for the conversation
 */
export const generateChatTitle = async (messages: any[]): Promise<string> => {
  try {
    console.log("Starting title generation with", messages.length, "messages");

    // Take the first few exchanges for context (up to 6 messages or first 3 user turns)
    const contextMessages = [];
    let userTurnCount = 0;

    for (const msg of messages) {
      contextMessages.push(msg);
      if (msg.role === "user") {
        userTurnCount++;
        if (userTurnCount >= 3) break;
      }
      if (contextMessages.length >= 6) break;
    }

    console.log("Using", contextMessages.length, "messages for context");

    // Build context string for title generation
    const conversationContext = contextMessages
      .map(
        m =>
          `${m.role === "user" ? "User" : "Assistant"}: ${getMessageContent(m)}`,
      )
      .join("\n\n");

    const titlePrompt = `Based on this conversation, generate a concise title (3-8 words) that captures the main topic or task:\n\n${conversationContext}`;

    console.log("Calling title agent with prompt length:", titlePrompt.length);

    const titleResult = await runAgent(titleAgent, titlePrompt);

    console.log("Title agent result:", {
      type: typeof titleResult,
      result: titleResult,
      finalOutput: (titleResult as any)?.finalOutput,
      output: (titleResult as any)?.output,
    });

    // Extract the text from the RunResult - check for different possible properties
    let title = "";
    if (typeof titleResult === "string") {
      title = titleResult;
    } else if (titleResult && typeof titleResult === "object") {
      // Try different possible properties where the text might be stored
      title =
        (titleResult as any).finalOutput ||
        (titleResult as any).output ||
        (titleResult as any).text ||
        (titleResult as any).content ||
        String(titleResult);
    } else {
      title = String(titleResult);
    }

    console.log("Extracted title before processing:", title);

    title = title.trim();

    // Quality checks
    title = title.replace(/^["']|["']$/g, ""); // Remove quotes
    title = title.substring(0, 80); // Character limit

    // Check for generic phrases and replace if needed
    const genericPhrases = [
      "conversation",
      "chat",
      "question",
      "help",
      "assistance",
      "discussion",
      "inquiry",
      "request",
      "general",
    ];

    const isGeneric = genericPhrases.some(phrase =>
      title.toLowerCase().includes(phrase),
    );

    if (isGeneric || title.length < 10) {
      console.log(
        "Title failed quality check, using fallback. isGeneric:",
        isGeneric,
        "length:",
        title.length,
      );

      // Fallback: try to extract key terms from user messages
      const userContent = contextMessages
        .filter(m => m.role === "user")
        .map(m => getMessageContent(m))
        .join(" ");

      // Simple keyword extraction for fallback
      const words = userContent
        .toLowerCase()
        .split(/\s+/)
        .filter(word => word.length > 3)
        .slice(0, 3);

      if (words.length >= 2) {
        title =
          words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") +
          " Discussion";
      } else {
        title = "Database Query Session";
      }

      console.log("Fallback title:", title);
    }

    console.log("Final generated title:", title);
    return title;
  } catch (error) {
    console.error("Title generation failed:", error);
    return "Database Query Session";
  }
};
