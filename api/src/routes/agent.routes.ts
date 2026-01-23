/**
 * Agent Routes
 * Native Vercel AI SDK streaming protocol for useChat compatibility
 */

import { Hono } from "hono";
import { ObjectId } from "mongodb";
import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
  type LanguageModel,
} from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { workspaceService } from "../services/workspace.service";
import type { ConsoleDataV2 } from "../agent-v2/types";
import { createUniversalTools } from "../agent-v2/tools/universal-tools";
import { UNIVERSAL_PROMPT_V2 } from "../agent-v2/prompts/universal";
import { getModelById, getAvailableModels } from "../agent-v2/ai-models";
import {
  Workspace,
  DatabaseConnection,
  Chat,
} from "../database/workspace-schema";
import { saveChat } from "../services/agent-thread.service";
import { generateChatTitle } from "../services/title-generator";
import { sanitizeMessagesForModel } from "../utils/message-sanitizer";
import { loggers, enrichContextWithWorkspace } from "../logging";

const logger = loggers.agent();

export const agentRoutes = new Hono();

// Apply unified auth middleware to all routes
agentRoutes.use("*", unifiedAuthMiddleware);

/**
 * GET /models - List available AI models based on configured API keys
 */
agentRoutes.get("/models", async (c: AuthenticatedContext) => {
  const models = getAvailableModels();
  return c.json({ models });
});

/**
 * Get the AI SDK model instance based on the model ID
 * Note: Type assertion needed due to AI SDK beta version conflicts with @ai-sdk/provider
 */
function getModelInstance(modelId?: string): LanguageModel {
  if (!modelId) {
    return openai("gpt-5.2") as unknown as LanguageModel;
  }

  const model = getModelById(modelId);
  if (!model) {
    logger.warn("Model not found, falling back to gpt-5.2", { modelId });
    return openai("gpt-5.2") as unknown as LanguageModel;
  }

  switch (model.provider) {
    case "openai":
      return openai(modelId) as unknown as LanguageModel;
    case "anthropic":
      return anthropic(modelId) as unknown as LanguageModel;
    case "google":
      return google(modelId) as unknown as LanguageModel;
    default:
      logger.warn("Unknown provider for model, falling back to gpt-5.2", {
        modelId,
      });
      return openai("gpt-5.2") as unknown as LanguageModel;
  }
}

/**
 * POST /api/agent/chat
 * useChat-compatible endpoint using native AI SDK streaming
 */
agentRoutes.post("/chat", async (c: AuthenticatedContext) => {
  const user = c.get("user");
  const userId = user?.id;

  if (!userId) {
    return c.json({ error: "User not authenticated" }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch (e) {
    logger.error("Error parsing request body", { error: e });
    return c.json({ error: "Invalid request body" }, 400);
  }

  // OpenConsoleContext matches frontend's smart truncation format
  // Note: isActive is computed on backend using consoleId param to avoid frontend re-render loops
  interface OpenConsoleContext {
    id: string;
    title: string;
    connectionId?: string;
    connectionName?: string;
    connectionType?: string;
    databaseId?: string;
    databaseName?: string;
    content: string;
    contentTruncated: boolean;
    lineCount: number;
  }

  const { messages, chatId, workspaceId, openConsoles, consoleId, modelId } =
    body as {
      messages?: UIMessage[];
      chatId?: string; // Frontend-owned chat ID (AI SDK best practice)
      workspaceId?: string;
      openConsoles?: OpenConsoleContext[];
      consoleId?: string;
      modelId?: string;
    };

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return c.json({ error: "'messages' array is required" }, 400);
  }

  if (!workspaceId || !ObjectId.isValid(workspaceId)) {
    return c.json(
      { error: "'workspaceId' is required and must be valid" },
      400,
    );
  }

  // Verify workspace access
  const workspace = c.get("workspace");
  if (workspace) {
    // For API key auth, verify the body workspace matches the API key's workspace
    if (workspace._id.toString() !== workspaceId) {
      return c.json(
        { error: "API key not authorized for this workspace" },
        403,
      );
    }
  } else if (userId) {
    // For session auth, verify user has access to this workspace
    const hasAccess = await workspaceService.hasAccess(workspaceId, userId);
    if (!hasAccess) {
      return c.json({ error: "Access denied to workspace" }, 403);
    }
  } else {
    // Neither API key nor session auth succeeded - reject request
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Only enrich logging context after authorization succeeds
  enrichContextWithWorkspace(workspaceId);

  if (!chatId || !ObjectId.isValid(chatId)) {
    return c.json(
      { error: "'chatId' is required and must be a valid ObjectId" },
      400,
    );
  }

  // Check if this is a new chat (first message)
  const existingChat = await Chat.findById(chatId);
  const isNewChat = !existingChat;

  // For new chats: create chat document immediately, then fire-and-forget title generation
  // IMPORTANT: Title generation uses generateText() which would interfere with the main
  // streamText() response if awaited. We fire-and-forget to keep streams separate.
  if (isNewChat && messages.length > 0) {
    // Create chat document immediately (await this to ensure persistence)
    await Chat.create({
      _id: new ObjectId(chatId),
      workspaceId: new ObjectId(workspaceId),
      createdBy: userId.toString(),
      title: "New Chat",
      titleGenerated: false,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Extract text content for title generation
    const firstUserMessage = messages.find(m => m.role === "user");
    const userContent = firstUserMessage?.parts
      ? firstUserMessage.parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map(p => p.text)
          .join("")
      : "";

    // Fire-and-forget: generate title in background (don't await - separate from main stream)
    if (userContent.length >= 3) {
      void (async () => {
        try {
          const title = await generateChatTitle(userContent);
          await Chat.updateOne(
            { _id: new ObjectId(chatId), titleGenerated: false },
            { title, titleGenerated: true },
          );
        } catch (err) {
          logger.error("Background title generation failed", { error: err });
        }
      })();
    }
  }

  // Load workspace for custom prompt
  let workspaceCustomPrompt = "";
  try {
    const workspace = await Workspace.findById(workspaceId).select({
      settings: 1,
    });
    workspaceCustomPrompt = workspace?.settings?.customPrompt || "";
  } catch (err) {
    logger.warn("Failed to load workspace custom prompt", { error: err });
  }

  // Build system prompt
  const systemPrompt = UNIVERSAL_PROMPT_V2;

  // Get workspace database connections for context
  const workspaceDatabases = await DatabaseConnection.find({
    workspaceId: new ObjectId(workspaceId),
  }).select({ type: 1, name: 1 });

  const databaseTypeMap = new Map<string, string>();
  const databaseNameMap = new Map<string, string>();
  workspaceDatabases.forEach(db => {
    databaseTypeMap.set(db._id.toString(), db.type);
    databaseNameMap.set(db._id.toString(), db.name);
  });

  // Convert openConsoles to ConsoleDataV2 format for tools (enriched with connection type)
  const enrichedConsoles: ConsoleDataV2[] = (openConsoles || []).map(c => ({
    id: c.id,
    title: c.title,
    content: c.content,
    connectionId: c.connectionId,
    databaseId: c.databaseId,
    databaseName: c.databaseName,
    connectionType:
      c.connectionType ||
      (c.connectionId ? databaseTypeMap.get(c.connectionId) : undefined),
  }));

  // Get tools (uses client-side console tools)
  const tools = createUniversalTools(workspaceId, enrichedConsoles, consoleId);

  // Build custom prompt context for the full system message
  const customPromptContext =
    workspaceCustomPrompt.trim().length > 0
      ? `\n\n---\n\n### Workspace Context\n${workspaceCustomPrompt.trim()}`
      : "";

  // Build runtime context with open consoles and available connections
  let runtimeContext = "";

  if (
    (openConsoles && openConsoles.length > 0) ||
    workspaceDatabases.length > 0
  ) {
    runtimeContext += "\n\n---\n\n## Current State (auto-injected)\n";

    // Open Consoles section
    if (openConsoles && openConsoles.length > 0) {
      runtimeContext += "\n### Open Consoles:\n";
      for (let i = 0; i < openConsoles.length; i++) {
        const c = openConsoles[i];
        const connType =
          c.connectionType ||
          (c.connectionId ? databaseTypeMap.get(c.connectionId) : undefined);
        const connName =
          c.connectionName ||
          (c.connectionId ? databaseNameMap.get(c.connectionId) : undefined);

        // Determine active console using consoleId param (avoids frontend re-render loops)
        const isActive = c.id === consoleId;
        const activeLabel = isActive ? "[ACTIVE] " : "";
        runtimeContext += `\n${i + 1}. ${activeLabel}"${c.title}" (id: ${c.id})\n`;

        // Connection info
        if (connType || connName || c.databaseName) {
          const parts: string[] = [];
          if (connType) parts.push(connType);
          if (connName) parts.push(connName);
          if (c.databaseName) parts.push(`db: ${c.databaseName}`);
          runtimeContext += `   - Connection: ${parts.join(" / ")}\n`;
        } else {
          runtimeContext += `   - Connection: none\n`;
        }

        // Content
        const trimmedContent = c.content.trim();
        if (!trimmedContent) {
          runtimeContext += `   - Content: empty\n`;
        } else {
          const truncatedNote = c.contentTruncated
            ? ` (truncated from ${c.lineCount} lines)`
            : "";
          runtimeContext += `   - Content${truncatedNote}:\n`;
          // Indent the content
          const indentedContent = trimmedContent
            .split("\n")
            .map(line => `     ${line}`)
            .join("\n");
          runtimeContext += `${indentedContent}\n`;
        }
      }
    }

    // Available Connections section
    if (workspaceDatabases.length > 0) {
      runtimeContext += "\n### Available Connections:\n";
      for (const db of workspaceDatabases) {
        runtimeContext += `- ${db.type}: ${db.name} (id: ${db._id.toString()})\n`;
      }
    }

    runtimeContext += "\n---";
  }

  // Get model instance
  const model = getModelInstance(modelId);
  logger.info("Using model", { model: modelId || "gpt-5.2 (default)" });

  // Sanitize messages to remove incomplete tool calls from interrupted streams
  // This prevents Anthropic API errors: "tool_use ids were found without tool_result blocks"
  const sanitizedMessages = sanitizeMessagesForModel(messages);

  // Convert UI messages (from useChat) to model messages (for streamText)
  const modelMessages = await convertToModelMessages(sanitizedMessages);

  // Guardrail: prevent runaway multi-step tool loops in production.
  // The AI SDK defaults to stopWhen: stepCountIs(1). We intentionally allow multi-step,
  // but keep a firm upper bound.
  const MAX_STEPS = 256;
  let stepsCompleted = 0;

  const result = streamText({
    model,
    system: systemPrompt + customPromptContext + runtimeContext,
    messages: modelMessages,
    tools: tools as any,
    stopWhen: stepCountIs(MAX_STEPS),
    onStepFinish: ({ toolCalls }) => {
      stepsCompleted += 1;

      logger.debug("Step finished", {
        step: stepsCompleted,
        maxSteps: MAX_STEPS,
        toolCallCount: toolCalls?.length,
      });

      if (stepsCompleted >= MAX_STEPS) {
        logger.warn("Step limit reached, terminating tool loop", {
          maxSteps: MAX_STEPS,
        });
      }
    },
  });

  // Return native AI SDK UI message stream response (for useChat compatibility)
  // Using AI SDK best practice: save once at the end with all messages
  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    generateMessageId: () => new ObjectId().toString(),
    // Forward reasoning tokens from models that support extended thinking
    // (e.g., Claude claude-3-7-sonnet-20250219, DeepSeek deepseek-r1)
    sendReasoning: true,
    onFinish: async ({ messages: allMessages }) => {
      // Get usage from the streamText result (not from toUIMessageStreamResponse callback)
      // result.usage is a promise that resolves when the stream completes
      let modelUsage: Record<string, unknown> | undefined;
      try {
        const usage = await result.usage;
        modelUsage = usage as unknown as Record<string, unknown>;
      } catch (err) {
        logger.warn("Failed to get usage from model", { error: err });
      }

      // Safely extract usage values
      // Handle different provider naming conventions:
      // - OpenAI/standard: promptTokens, completionTokens
      // - Anthropic: may use input_tokens, output_tokens or similar
      const getNumber = (val: unknown): number => {
        if (typeof val === "number" && !isNaN(val)) return val;
        return 0;
      };

      const promptTokens =
        getNumber(modelUsage?.promptTokens) ||
        getNumber(modelUsage?.input_tokens) ||
        getNumber(modelUsage?.inputTokens) ||
        0;
      const completionTokens =
        getNumber(modelUsage?.completionTokens) ||
        getNumber(modelUsage?.output_tokens) ||
        getNumber(modelUsage?.outputTokens) ||
        0;
      const totalTokens =
        getNumber(modelUsage?.totalTokens) ||
        getNumber(modelUsage?.total_tokens) ||
        promptTokens + completionTokens;

      logger.info("Stream finished, saving chat", {
        chatId,
        messageCount: allMessages.length,
      });

      try {
        // Save all messages in one atomic operation (AI SDK best practice)
        // Title was already generated in parallel at the start for new chats
        // Note: Draft consoles are saved client-side when modified (debounced)
        await saveChat(chatId, workspaceId, userId.toString(), allMessages, {
          promptTokens,
          completionTokens,
          totalTokens,
          model: modelId,
        });
      } catch (error) {
        logger.error("Error saving chat", { error });
      }
    },
  });
});
