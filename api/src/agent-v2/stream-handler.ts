/**
 * Agent V2 Stream Handler
 * Using Vercel AI SDK for streaming responses
 */

import {
  streamText,
  stepCountIs,
  type CoreMessage,
  type LanguageModel,
} from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import type {
  StreamAgentParams,
  AgentKindV2,
  ConsoleDataV2,
  ConversationMessage,
} from "./types";
import { createMongoToolsV2 } from "./tools/mongodb-tools";
import { createPostgresToolsV2 } from "./tools/postgres-tools";
import { createBigQueryToolsV2 } from "./tools/bigquery-tools";
import { createConsoleToolsV2 } from "./tools/console-tools";
import { MONGO_PROMPT_V2 } from "./prompts/mongodb";
import { POSTGRES_PROMPT_V2 } from "./prompts/postgres";
import { BIGQUERY_PROMPT_V2 } from "./prompts/bigquery";
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
 * Get the appropriate tools for the agent type
 * Returns tools compatible with streamText
 */
function getToolsForAgent(
  agentType: AgentKindV2,
  config: {
    workspaceId: string;
    consoles: ConsoleDataV2[];
    consoleId?: string;
  },
): SimpleToolSet {
  const { workspaceId, consoles, consoleId } = config;

  switch (agentType) {
    case "mongo":
      return createMongoToolsV2(
        workspaceId,
        consoles,
        consoleId,
      ) as SimpleToolSet;
    case "postgres":
      return createPostgresToolsV2(
        workspaceId,
        consoles,
        consoleId,
      ) as SimpleToolSet;
    case "bigquery":
      return createBigQueryToolsV2(
        workspaceId,
        consoles,
        consoleId,
      ) as SimpleToolSet;
    case "triage":
    default:
      // For triage, return just console tools - in a full implementation,
      // this would include handoff tools to specialized agents
      return createConsoleToolsV2(consoles, consoleId) as SimpleToolSet;
  }
}

/**
 * Get the appropriate system prompt for the agent type
 */
function getPromptForAgent(agentType: AgentKindV2): string {
  switch (agentType) {
    case "mongo":
      return MONGO_PROMPT_V2;
    case "postgres":
      return POSTGRES_PROMPT_V2;
    case "bigquery":
      return BIGQUERY_PROMPT_V2;
    case "triage":
    default:
      return `You are a helpful database assistant. Based on the user's question and the available consoles, help them write and execute database queries. If you're unsure which database type to use, examine the console's connection type.`;
  }
}

/**
 * Detect the agent type from consoles and message content
 */
export function detectAgentType(
  consoles: ConsoleDataV2[],
  message: string,
): AgentKindV2 {
  // Check message for explicit database mentions
  const messageLower = message.toLowerCase();
  if (
    messageLower.includes("mongodb") ||
    messageLower.includes("mongo") ||
    messageLower.includes("aggregate") ||
    messageLower.includes("collection")
  ) {
    return "mongo";
  }
  if (
    messageLower.includes("postgres") ||
    messageLower.includes("postgresql") ||
    messageLower.includes("pg_")
  ) {
    return "postgres";
  }
  if (
    messageLower.includes("bigquery") ||
    messageLower.includes("bq_") ||
    messageLower.includes("google cloud")
  ) {
    return "bigquery";
  }

  // Check active console's connection type
  if (consoles.length > 0) {
    const activeConsole = consoles[0];
    const connectionType = activeConsole.connectionType?.toLowerCase();

    if (connectionType === "mongodb") {
      return "mongo";
    }
    if (
      connectionType === "postgresql" ||
      connectionType === "cloudsql-postgres"
    ) {
      return "postgres";
    }
    if (connectionType === "bigquery") {
      return "bigquery";
    }
  }

  // Default to triage if we can't determine
  return "triage";
}

/**
 * Convert conversation history to AI SDK CoreMessage format
 */
function convertToAIMessages(
  history: ConversationMessage[],
  newMessage: string,
): CoreMessage[] {
  const messages: CoreMessage[] = [];

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
    agentType,
    modelId,
  } = params;

  const tools = getToolsForAgent(agentType, {
    workspaceId,
    consoles,
    consoleId,
  });
  const systemPrompt = getPromptForAgent(agentType);

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

  // Tools are structurally compatible at runtime - cast through unknown to bypass type checking
  const result = streamText({
    model,
    system: systemPrompt + consoleContext,
    messages,
    tools: tools as Parameters<typeof streamText>[0]["tools"],
    // AI SDK defaults to stopWhen: stepCountIs(1). We want high multi-step tool usage.
    stopWhen: stepCountIs(1024),
    onStepFinish: ({ toolCalls, toolResults }) => {
      // This fires reliably after each tool execution
      // eslint-disable-next-line no-console -- helpful for debugging tool usage in dev
      console.log("[Agent V2] Step finished:", {
        toolCallCount: toolCalls?.length,
        toolResultCount: toolResults?.length,
      });
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
      },
    };
  }

  return null;
}
