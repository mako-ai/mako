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
    console.warn(
      `[Agent] Model "${modelId}" not found, falling back to gpt-5.2`,
    );
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
      console.warn(
        `[Agent] Unknown provider for model "${modelId}", falling back to gpt-5.2`,
      );
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
    console.error("[Agent] Error parsing request body", e);
    return c.json({ error: "Invalid request body" }, 400);
  }

  const { messages, chatId, workspaceId, consoles, consoleId, modelId } =
    body as {
      messages?: UIMessage[];
      chatId?: string; // Frontend-owned chat ID (AI SDK best practice)
      workspaceId?: string;
      consoles?: ConsoleDataV2[];
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
          console.error("[Agent] Background title generation failed:", err);
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
    console.warn("[Agent] Failed to load workspace custom prompt:", err);
  }

  // Build system prompt
  const systemPrompt = UNIVERSAL_PROMPT_V2;

  // Get workspace database capabilities for enriching consoles and description context
  const workspaceDatabases = await DatabaseConnection.find({
    workspaceId: new ObjectId(workspaceId),
  }).select({ type: 1, name: 1, summary: 1, databases: 1 });

  const databaseTypeMap = new Map<string, string>();
  workspaceDatabases.forEach(db => {
    databaseTypeMap.set(db._id.toString(), db.type);
  });

  // Enrich consoles with connection type information
  const enrichedConsoles: ConsoleDataV2[] = (consoles || []).map(
    (c: ConsoleDataV2) => ({
      ...c,
      connectionType:
        c.connectionType ||
        (c.connectionId ? databaseTypeMap.get(c.connectionId) : undefined),
    }),
  );

  // Get tools (uses client-side console tools)
  const tools = createUniversalTools(workspaceId, enrichedConsoles, consoleId);

  // Build custom prompt context for the full system message
  const customPromptContext =
    workspaceCustomPrompt.trim().length > 0
      ? `\n\n---\n\n### Workspace Context\n${workspaceCustomPrompt.trim()}`
      : "";

  const consoleContext =
    enrichedConsoles.length > 0
      ? `\n\nAvailable consoles:\n${enrichedConsoles
          .map(
            (c, i) =>
              `${i + 1}. "${c.title}" (ID: ${c.id}, Type: ${c.connectionType || "unknown"}${c.databaseName ? `, DB: ${c.databaseName}` : ""})`,
          )
          .join("\n")}`
      : "";

  // Build database knowledge context from per-database descriptions
  const databaseContextEntries: string[] = [];

  for (const conn of workspaceDatabases) {
    // Check if connection has any description content
    const hasDescriptions =
      conn.summary?.trim() ||
      conn.databases?.some((db: { name: string; description?: string }) =>
        db.description?.trim(),
      );

    if (!hasDescriptions) continue;

    let entry = `**${conn.name}** (${conn.type})`;

    // Add connection-level summary if present
    if (conn.summary?.trim()) {
      entry += `\n  Summary: ${conn.summary.trim()}`;
    }

    // Add per-database descriptions
    if (conn.databases && conn.databases.length > 0) {
      for (const db of conn.databases) {
        if (db.description?.trim()) {
          entry += `\n  Database "${db.name}": ${db.description.trim()}`;
        }
      }
    }

    databaseContextEntries.push(entry);
  }

  const databaseContext =
    databaseContextEntries.length > 0
      ? `\n\n### Database Knowledge\n${databaseContextEntries.join("\n\n")}`
      : "";

  // Get model instance
  const model = getModelInstance(modelId);
  console.log(`[Agent] Using model: ${modelId || "gpt-5.2 (default)"}`);

  // Convert UI messages (from useChat) to model messages (for streamText)
  // Note: convertToModelMessages is async in AI SDK
  const modelMessages = await convertToModelMessages(messages);

  // Guardrail: prevent runaway multi-step tool loops in production.
  // The AI SDK defaults to stopWhen: stepCountIs(1). We intentionally allow multi-step,
  // but keep a firm upper bound.
  const MAX_STEPS = 256;
  let stepsCompleted = 0;

  const result = streamText({
    model,
    system:
      systemPrompt + customPromptContext + databaseContext + consoleContext,
    messages: modelMessages,
    tools: tools as any,
    stopWhen: stepCountIs(MAX_STEPS),
    onStepFinish: ({ toolCalls }) => {
      stepsCompleted += 1;

      console.log("[Agent] Step finished:", {
        step: stepsCompleted,
        maxSteps: MAX_STEPS,
        toolCallCount: toolCalls?.length,
      });

      if (stepsCompleted >= MAX_STEPS) {
        console.warn(
          `[Agent] Step limit reached (${MAX_STEPS}). Terminating tool loop to prevent runaway execution.`,
        );
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
      console.log("[Agent] Stream finished, saving chat:", {
        chatId,
        messageCount: allMessages.length,
      });

      try {
        // Save all messages in one atomic operation (AI SDK best practice)
        // Title was already generated in parallel at the start for new chats
        await saveChat(chatId, workspaceId, userId.toString(), allMessages);
      } catch (error) {
        console.error("[Agent] Error saving chat:", error);
      }
    },
  });
});
