/**
 * Agent Routes
 * Native Vercel AI SDK streaming protocol for useChat compatibility
 * Uses agent registry for multi-agent support
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
import type { ConsoleDataV2 } from "../agent-lib/types";
import { getModelById, getAvailableModels } from "../agent-lib/ai-models";
import {
  Workspace,
  DatabaseConnection,
  Chat,
  SavedConsole,
} from "../database/workspace-schema";
import { saveChat } from "../services/agent-thread.service";
import { generateChatTitle } from "../services/title-generator";
import {
  isDescriptionGenAvailable,
  extractConsoleContextFromMessages,
  generateDescriptionAndEmbedding,
} from "../services/console-description.service";
import {
  isEmbeddingAvailable,
  isVectorSearchAvailable,
} from "../services/embedding.service";
import { searchConsoles } from "../agent-lib/tools/console-search-tools";
import { sanitizeMessagesForModel } from "../utils/message-sanitizer";
import { loggers, enrichContextWithWorkspace } from "../logging";
import {
  getAgentFactory,
  detectAgentId,
  getAllAgentMeta,
  type AgentContext,
} from "../agents";

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
 * GET /agents - List available agent modes
 */
agentRoutes.get("/agents", async (c: AuthenticatedContext) => {
  const agents = getAllAgentMeta();
  return c.json({ agents });
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
  const workspace = c.get("workspace");
  const apiKey = c.get("apiKey");

  // Allow both session auth (user) and API key auth (workspace)
  // Actor ID: user ID for session, API key creator for programmatic access
  // (chats appear in creator's history when they log in)
  const actorId =
    user?.id ??
    (apiKey?.createdBy
      ? String(apiKey.createdBy)
      : workspace
        ? "api-key"
        : undefined);
  if (!actorId) {
    return c.json({ error: "Unauthorized" }, 401);
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

  interface ActiveConsoleResults {
    viewMode: "table" | "json" | "chart";
    hasResults: boolean;
    rowCount: number;
    columns: string[];
    sampleRows: Record<string, unknown>[];
    chartSpec: Record<string, unknown> | null;
  }

  const {
    messages,
    chatId,
    workspaceId,
    openConsoles,
    consoleId,
    modelId,
    activeConsoleResults,
    // Agent mode selection (new)
    agentId,
    tabKind,
    flowType,
    flowFormState,
    activeDashboardContext,
  } = body as {
    messages?: UIMessage[];
    chatId?: string;
    workspaceId?: string;
    openConsoles?: OpenConsoleContext[];
    consoleId?: string;
    modelId?: string;
    activeConsoleResults?: ActiveConsoleResults;
    agentId?: string;
    tabKind?: string;
    flowType?: string;
    flowFormState?: Record<string, unknown>;
    activeDashboardContext?: {
      dashboardId: string;
      title: string;
      dataSources: Array<{
        id: string;
        name: string;
        tableRef?: string;
        status?: "idle" | "loading" | "ready" | "error" | null;
        rowsLoaded?: number;
        error?: string | null;
        columns: Array<{ name: string; type: string }>;
        sampleRows?: Record<string, unknown>[];
      }>;
      widgets: Array<{
        id: string;
        title?: string;
        type: string;
        dataSourceId: string;
      }>;
      crossFilterEnabled: boolean;
    };
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
  if (workspace) {
    // For API key auth, verify the body workspace matches the API key's workspace
    if (workspace._id.toString() !== workspaceId) {
      return c.json(
        { error: "API key not authorized for this workspace" },
        403,
      );
    }
  } else if (user) {
    // For session auth, verify user has access to this workspace
    const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
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
      createdBy: actorId,
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

  // Load workspace for custom prompt and self-directive
  let workspaceCustomPrompt = "";
  let selfDirective = "";
  try {
    const workspace = await Workspace.findById(workspaceId).select({
      settings: 1,
      selfDirective: 1,
    });
    workspaceCustomPrompt = workspace?.settings?.customPrompt || "";
    selfDirective = workspace?.selfDirective || "";
  } catch (err) {
    logger.warn("Failed to load workspace custom prompt", { error: err });
  }

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

  // Resolve agent: explicit ID > auto-detect from tab context > default to console
  const resolvedAgentId = agentId || detectAgentId(tabKind, flowType);
  const agentFactory = getAgentFactory(resolvedAgentId);

  if (!agentFactory) {
    logger.error("Agent not found", { agentId: resolvedAgentId });
    return c.json({ error: `Agent '${resolvedAgentId}' not found` }, 404);
  }

  logger.info("Using agent", { agentId: resolvedAgentId, tabKind, flowType });

  // Auto-discover relevant consoles via embedding search (parallel with other setup)
  let consoleHints = "";
  if (
    resolvedAgentId === "console" &&
    isEmbeddingAvailable() &&
    messages.length > 0
  ) {
    try {
      const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
      const userText = lastUserMsg?.parts
        ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map(p => p.text)
        .join("");

      if (
        userText &&
        userText.length >= 5 &&
        (await isVectorSearchAvailable())
      ) {
        const hints = await searchConsoles(userText, workspaceId, 3);
        if (hints.length > 0) {
          consoleHints =
            "\n\n---\n\n### Relevant Saved Consoles (auto-discovered)\n" +
            hints
              .map(
                h =>
                  `- "${h.title}" — ${h.description || "no description"} (id: ${h.id}${h.connectionName ? `, connection: ${h.connectionName}` : ""}, ${h.language})${h.isSaved ? " [saved]" : ""}`,
              )
              .join("\n") +
            "\nUse search_consoles for more, or open_console to load one into the editor.";
        }
      }
    } catch (err) {
      logger.debug("Console hint injection skipped", { error: err });
    }
  }

  // Build agent context
  const agentContext: AgentContext = {
    workspaceId,
    userId: actorId,
    consoles: enrichedConsoles,
    consoleId,
    databases: workspaceDatabases.map(db => ({
      id: db._id.toString(),
      name: db.name,
      type: db.type,
    })),
    flowFormState,
    workspaceCustomPrompt,
    selfDirective,
    consoleHints,
    activeConsoleResults,
    activeDashboardContext,
  };

  // Create agent configuration
  const agentConfig = agentFactory(agentContext);
  const { systemPrompt, tools } = agentConfig;

  // Get model instance
  const model = getModelInstance(modelId);
  const modelDef = modelId ? getModelById(modelId) : undefined;
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

  // Enable Anthropic extended thinking for models that support it.
  // The @ai-sdk/anthropic provider computes max_tokens = maxOutputTokens + budgetTokens
  // then clamps to the model's known cap. We must NOT set maxOutputTokens ourselves
  // (let the SDK use its model default) and keep budgetTokens under that cap.
  const enableThinking = modelDef?.supportsThinking === true;
  const thinkingBudget = modelDef?.thinkingBudgetTokens ?? 10000;

  const result = streamText({
    model,
    system: systemPrompt,
    messages: modelMessages,
    tools: tools as Record<string, any>,
    stopWhen: stepCountIs(MAX_STEPS),
    providerOptions: enableThinking
      ? {
          anthropic: {
            thinking: { type: "enabled", budgetTokens: thinkingBudget },
          },
        }
      : undefined,
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
        await saveChat(chatId, workspaceId, actorId, allMessages, {
          promptTokens,
          completionTokens,
          totalTokens,
          model: modelId,
        });
      } catch (error) {
        logger.error("Error saving chat", { error });
      }

      if (isDescriptionGenAvailable()) {
        void (async () => {
          try {
            const consoleContexts =
              extractConsoleContextFromMessages(allMessages);
            for (const [consoleId, ctx] of consoleContexts) {
              const console = await SavedConsole.findById(consoleId).select(
                "code name connectionId databaseName language",
              );
              if (!console) continue;

              const connDoc = console.connectionId
                ? await DatabaseConnection.findById(console.connectionId)
                : null;

              const { description, embedding, embeddingModel } =
                await generateDescriptionAndEmbedding({
                  code: console.code,
                  title: console.name,
                  connectionName: connDoc?.name,
                  databaseType: connDoc?.type,
                  databaseName: console.databaseName,
                  language: console.language,
                  conversationExcerpt: ctx.conversationExcerpt,
                  resultSample: ctx.resultSample,
                });

              const $set: Record<string, any> = {
                descriptionGeneratedAt: new Date(),
              };
              if (description) $set.description = description;
              if (embedding) {
                $set.descriptionEmbedding = embedding;
                $set.embeddingModel = embeddingModel;
              }
              await SavedConsole.updateOne(
                { _id: new ObjectId(consoleId) },
                { $set },
              );
            }
          } catch (err) {
            logger.error("Background description generation failed", {
              error: err,
            });
          }
        })();
      }
    },
  });
});
