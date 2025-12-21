/**
 * Agent V2 Stream Handler
 * Using Vercel AI SDK for streaming responses
 */

import { streamText, stepCountIs, type LanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import type {
  StreamAgentParams,
  ConsoleDataV2,
  ConversationMessage,
} from "./types";
import { createUniversalToolsV2 } from "./tools/universal-tools";
import { UNIVERSAL_PROMPT_V2 } from "./prompts/universal";
import { getModelById } from "./ai-models";

/**
 * Get the AI SDK model instance based on the model ID
 * Falls back to gpt-5.2 if the model is not found
 */
function getModelInstance(modelId?: string): LanguageModel {
  if (!modelId) {
    return openai("gpt-5.2");
  }

  const model = getModelById(modelId);
  if (!model) {
    console.warn(
      `[Agent V2] Model "${modelId}" not found, falling back to gpt-5.2`,
    );
    return openai("gpt-5.2");
  }

  switch (model.provider) {
    case "openai":
      return openai(modelId);
    case "anthropic":
      return anthropic(modelId);
    case "google":
      return google(modelId);
    default:
      console.warn(
        `[Agent V2] Unknown provider for model "${modelId}", falling back to gpt-5.2`,
      );
      return openai("gpt-5.2");
  }
}

// Simple tool type to avoid complex AI SDK type inference
type SimpleTool = {
  description: string;
  inputSchema: unknown;
  execute: (input: unknown) => Promise<unknown>;
};
type SimpleToolSet = Record<string, SimpleTool>;

/**
 * Get the universal tools for the agent
 * Always returns the full universal toolset (MongoDB + SQL)
 */
function getToolsForAgent(config: {
  workspaceId: string;
  consoles: ConsoleDataV2[];
  consoleId?: string;
}): SimpleToolSet {
  const { workspaceId, consoles, consoleId } = config;
  return createUniversalToolsV2(
    workspaceId,
    consoles,
    consoleId,
  ) as SimpleToolSet;
}

/**
 * Convert conversation history to AI SDK CoreMessage format
 */
function convertToAIMessages(
  history: ConversationMessage[],
  newMessage: string,
): any[] {
  const messages: any[] = [];

  for (const msg of history) {
    messages.push({
      role: msg.role,
      content: msg.content,
    });
  }

  // Add the new user message
  messages.push({ role: "user", content: newMessage });

  return messages;
}

/**
 * Stream an agent response using Vercel AI SDK
 */
export async function streamAgentResponse(params: StreamAgentParams) {
  const {
    conversationHistory,
    newMessage,
    workspaceId,
    consoles,
    consoleId,
    modelId,
    workspaceCustomPrompt,
  } = params;

  const tools = getToolsForAgent({
    workspaceId,
    consoles,
    consoleId,
  });
  const systemPrompt = UNIVERSAL_PROMPT_V2;
  const customPromptContext =
    typeof workspaceCustomPrompt === "string" &&
    workspaceCustomPrompt.trim().length > 0
      ? `\n\n---\n\n### Workspace Context\n${workspaceCustomPrompt.trim()}`
      : "";

  // Get the model instance based on the provided modelId
  const model = getModelInstance(modelId);
  // eslint-disable-next-line no-console -- helpful for debugging model selection in dev
  console.log(`[Agent V2] Using model: ${modelId || "gpt-5.2 (default)"}`);

  // Build context about available consoles
  const consoleContext =
    consoles.length > 0
      ? `\n\nAvailable consoles:\n${consoles
          .map(
            (c, i) =>
              `${i + 1}. "${c.title}" (ID: ${c.id}, Type: ${c.connectionType || "unknown"}${c.databaseName ? `, DB: ${c.databaseName}` : ""})`,
          )
          .join("\n")}`
      : "";

  // Convert conversation history to proper AI SDK message format
  const messages = convertToAIMessages(conversationHistory, newMessage);

  // Guardrail: prevent runaway multi-step tool loops in production.
  // The AI SDK defaults to stopWhen: stepCountIs(1). We intentionally allow multi-step,
  // but keep a firm upper bound.
  const MAX_STEPS = 256;
  let stepsCompleted = 0;

  // Tools are structurally compatible at runtime - cast through unknown to bypass type checking
  const result = streamText({
    model,
    system: systemPrompt + customPromptContext + consoleContext,
    messages,
    tools: tools as Parameters<typeof streamText>[0]["tools"],
    stopWhen: stepCountIs(MAX_STEPS),
    onStepFinish: ({ toolCalls, toolResults }) => {
      stepsCompleted += 1;
      // This fires reliably after each tool execution
      // eslint-disable-next-line no-console -- helpful for debugging tool usage in dev
      console.log("[Agent V2] Step finished:", {
        step: stepsCompleted,
        maxSteps: MAX_STEPS,
        toolCallCount: toolCalls?.length,
        toolResultCount: toolResults?.length,
      });

      if (stepsCompleted >= MAX_STEPS) {
        console.warn(
          `[Agent V2] Step limit reached (${MAX_STEPS}). Terminating tool loop to prevent runaway execution.`,
        );
      }
    },
  });

  return result;
}

/**
 * Process tool results and extract special events (console modifications, etc.)
 */
export function processToolResult(result: unknown): {
  type: string;
  data: unknown;
} | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const resultObj = result as Record<string, unknown>;

  if (resultObj._eventType === "console_modification" && resultObj.success) {
    return {
      type: "console_modification",
      data: {
        modification: resultObj.modification,
        consoleId: resultObj.consoleId,
      },
    };
  }

  if (resultObj._eventType === "console_creation" && resultObj.success) {
    return {
      type: "console_creation",
      data: {
        consoleId: resultObj.consoleId,
        title: resultObj.title,
        content: resultObj.content,
        connectionId: resultObj.connectionId,
        databaseId: resultObj.databaseId,
        databaseName: resultObj.databaseName,
      },
    };
  }

  return null;
}
