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
} from "ai";
import { getModel, buildProviderOptions } from "../agent-lib/ai-gateway";
import { propagateAttributes } from "@langfuse/tracing";
import { buildAnthropicThinkingConfig } from "../agent-lib/anthropic-thinking";
import { withThinkingSelfHeal } from "../agent-lib/thinking-self-heal";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { workspaceService } from "../services/workspace.service";
import type { ConsoleDataV2 } from "../agent-lib/types";
import {
  getModelById,
  getAvailableModels,
  getDefaultModelId,
  getDefaultFreeModelId,
} from "../agent-lib/ai-models";
import { getGatewayModels } from "../services/gateway-models.service";
import { getCatalogModels } from "../services/model-catalog.service";
import {
  Workspace,
  DatabaseConnection,
  Chat,
  SavedConsole,
} from "../database/workspace-schema";
import { saveChat } from "../services/agent-thread.service";
import { trackUsage } from "../services/llm-usage.service";
import { computeInvocationCost } from "../services/cost-calculator";
import { generateChatTitle } from "../services/title-generator";
import {
  isDescriptionGenAvailable,
  extractConsoleContextFromMessages,
  generateDescriptionAndEmbedding,
} from "../services/console-description.service";
import { searchConsoles } from "../agent-lib/tools/console-search-tools";
import {
  retrieveRelevantSkills,
  renderSkillsPromptBlock,
} from "../services/skills.service";
import { sanitizeMessagesForModel } from "../utils/message-sanitizer";
import { resolveChatAttachmentsForModel } from "../services/chat-attachment.service";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { checkBillingLimits } from "../billing/usage-limit.middleware";
import { getEffectiveBillingPlan } from "../billing/config";
import {
  getAgentFactory,
  detectAgentId,
  getAllAgentMeta,
  type AgentContext,
} from "../agents";
import { databaseConnectionService } from "../services/database-connection.service";
import { createAgentExecutionId } from "../agent-lib/tools/shared/truncation";
import { toNum, extractTokenCounts } from "../utils/safe-num";
import { scheduleChatFinalization } from "./chat-finalization-queue";

const logger = loggers.agent();

export const agentRoutes = new Hono();

interface ScreenshotVisionAttachment {
  renderer?: string;
  filename?: string;
  mediaType?: string;
  dataUrl?: string;
  outputBytes?: number;
  targetLabel?: string;
}

const MAX_SCREENSHOT_VISION_ATTACHMENTS = 6;
const MAX_SCREENSHOT_VISION_BYTES = 2_000_000;

function estimateDataUrlBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return dataUrl.length;
  return Math.floor(((dataUrl.length - commaIndex - 1) * 3) / 4);
}

function buildScreenshotVisionModelMessage(
  attachments: ScreenshotVisionAttachment[] | undefined,
) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return null;
  }

  const accepted = attachments
    .filter(attachment => {
      if (
        typeof attachment.dataUrl !== "string" ||
        !attachment.dataUrl.startsWith("data:image/")
      ) {
        return false;
      }
      const byteCount =
        typeof attachment.outputBytes === "number"
          ? attachment.outputBytes
          : estimateDataUrlBytes(attachment.dataUrl);
      return byteCount <= MAX_SCREENSHOT_VISION_BYTES;
    })
    .slice(0, MAX_SCREENSHOT_VISION_ATTACHMENTS);

  if (accepted.length === 0) {
    return null;
  }

  const content: Array<
    | { type: "text"; text: string }
    | { type: "file"; mediaType: string; filename?: string; data: string }
  > = [
    {
      type: "text",
      text:
        "The previous screenshot tool call captured these PNG images for visual inspection. " +
        "Look at the actual images, describe what is visible, and use them as visual evidence when answering.",
    },
  ];

  accepted.forEach((attachment, index) => {
    const renderer = attachment.renderer || `renderer-${index + 1}`;
    const filename = attachment.filename || `${renderer}.png`;
    content.push({
      type: "text",
      text: `Screenshot ${index + 1}: ${renderer} (${filename})`,
    });
    content.push({
      type: "file",
      mediaType: attachment.mediaType || "image/png",
      filename,
      data: attachment.dataUrl as string,
    });
  });

  return {
    role: "user" as const,
    content,
  };
}

// Apply unified auth middleware to all routes
agentRoutes.use("*", unifiedAuthMiddleware);

/**
 * GET /models - List available AI models for the current workspace.
 *
 * Returns the super-admin-curated catalog minus any model IDs the workspace
 * has explicitly disabled via `settings.disabledModelIds`. When no workspace
 * is in scope (no header / no active workspace) we return the full curated
 * catalog.
 *
 * Also returns `recommendedModelId`: the plan-aware default the chat endpoint
 * would fall back to if the client sent an unknown/hidden model. The client
 * uses this to reset the model picker when its persisted selection is no
 * longer available (e.g. super-admin hid the previously-selected model), so
 * the UI matches what the server will actually run.
 */
agentRoutes.get("/models", async (c: AuthenticatedContext) => {
  try {
    const workspaceId =
      c.req.header("x-workspace-id") || c.get("session")?.activeWorkspaceId;

    let models: Awaited<ReturnType<typeof getAvailableModels>> = [];
    let effectivePlan: ReturnType<typeof getEffectiveBillingPlan> = "free";

    if (workspaceId) {
      const ws = await Workspace.findById(workspaceId)
        .select({
          "settings.disabledModelIds": 1,
          "billing.plan": 1,
          "billing.subscriptionStatus": 1,
        })
        .lean();

      effectivePlan = getEffectiveBillingPlan(ws?.billing);
      models = await getAvailableModels(ws?.settings?.disabledModelIds);
    } else {
      models = await getAvailableModels();
    }

    const platformDefault =
      effectivePlan === "free"
        ? await getDefaultFreeModelId()
        : await getDefaultModelId();

    // Only surface the platform default if it's actually in the returned
    // list — otherwise the client would set an id the selector can't render.
    // Fall back to the first available model, matching legacy behaviour.
    const recommendedModelId = models.some(m => m.id === platformDefault)
      ? platformDefault
      : (models[0]?.id ?? null);

    return c.json({ models, recommendedModelId });
  } catch (err) {
    logger.error("Failed to load models", { error: err });
    return c.json({ models: [], recommendedModelId: null }, 200);
  }
});

/**
 * GET /gateway-models - Model catalog available to workspaces.
 *
 * Returns the Vercel AI Gateway catalog intersected with the super-admin
 * curation: only models with `visible: true` in the curation document are
 * exposed. This is the list the workspace "AI Models" settings UI picks
 * from, so workspace admins can never enable a model that the platform
 * super-admin has hidden.
 *
 * If curation is empty (e.g. fresh install before the seed migration), we
 * fall back to the unfiltered gateway list to avoid a hard "no models"
 * state — super-admins will still see everything in `/api/admin/catalog`.
 */
agentRoutes.get("/gateway-models", async (c: AuthenticatedContext) => {
  const [gateway, catalog] = await Promise.all([
    getGatewayModels(),
    getCatalogModels(),
  ]);
  if (catalog.length === 0) {
    return c.json({ models: gateway });
  }
  const visible = new Set(catalog.map(m => m.id));
  const models = gateway.filter(m => visible.has(m.id));
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
  // Email is the human-friendly identifier surfaced in Langfuse; falls back to
  // actorId for API-key access where no user email is available.
  const actorEmail = user?.email;

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

  interface OpenTabContext {
    id: string;
    kind: string;
    title: string;
    isActive: boolean;
    dashboardId?: string;
    flowId?: string;
    connectionId?: string;
    databaseName?: string;
  }

  interface OpenDashboardContext {
    id: string;
    title: string;
    isActive: boolean;
  }

  const {
    messages,
    chatId,
    workspaceId,
    openConsoles,
    openTabs,
    openDashboards,
    consoleId,
    modelId,
    activeConsoleResults,
    // Agent mode selection (new)
    agentId,
    activeView,
    activeExplorer,
    tabKind,
    flowType,
    flowFormState,
    activeDashboardContext,
    screenshotVisionAttachments,
  } = body as {
    messages?: UIMessage[];
    chatId?: string;
    workspaceId?: string;
    openConsoles?: OpenConsoleContext[];
    openTabs?: OpenTabContext[];
    openDashboards?: OpenDashboardContext[];
    consoleId?: string;
    modelId?: string;
    activeConsoleResults?: ActiveConsoleResults;
    agentId?: string;
    activeView?: "console" | "dashboard" | "flow-editor" | "empty";
    activeExplorer?:
      | "databases"
      | "consoles"
      | "connectors"
      | "flows"
      | "dashboards"
      | null;
    tabKind?: string;
    flowType?: string;
    flowFormState?: Record<string, unknown>;
    screenshotVisionAttachments?: ScreenshotVisionAttachment[];
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

  let canManageScheduledQueries = false;
  if (workspace) {
    canManageScheduledQueries = true;
  } else if (user?.id) {
    const member = await workspaceService.getMember(workspaceId, user.id);
    canManageScheduledQueries =
      member?.role === "owner" || member?.role === "admin";
  }

  // Load billing plan + disabled model IDs for plan-appropriate defaults and blocklist.
  const wsForModels = await Workspace.findById(workspaceId).select(
    "billing.plan billing.subscriptionStatus settings.disabledModelIds",
  );
  const effectivePlan = getEffectiveBillingPlan(wsForModels?.billing);
  const wsDisabledModelIds = wsForModels?.settings?.disabledModelIds ?? [];

  // Resolve model early so billing checks run against the actual model used.
  const available = await getAvailableModels(wsDisabledModelIds);
  const isModelAllowed = available.some(m => m.id === modelId);
  const resolvedModelId =
    modelId && isModelAllowed
      ? (modelId as string)
      : effectivePlan === "free"
        ? await getDefaultFreeModelId()
        : await getDefaultModelId();

  // Check billing limits (model access + usage quota)
  const billingCheck = await checkBillingLimits(workspaceId, resolvedModelId);
  if (!billingCheck.allowed) {
    return c.json(billingCheck.error, billingCheck.statusCode || 402);
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
          const title = await generateChatTitle(userContent, {
            workspaceId,
            userId: actorId,
            userEmail: actorEmail,
          });
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

  // Get workspace database connections for context (include sqlDialect for prompt enrichment)
  const workspaceDatabases = await DatabaseConnection.find({
    workspaceId: new ObjectId(workspaceId),
  }).select({ type: 1, name: 1, sqlDialect: 1 });

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

  const requestSignal = c.req.raw.signal;
  const requestExecutionIds = new Set<string>();

  // Cancel all currently-registered database executions.
  // Invariant: this only runs as a batch on abort. Any execution registered
  // *after* the abort fires is individually cancelled inside registerExecution
  // (which checks requestSignal.aborted synchronously after adding the ID).
  const cancelRegisteredExecutions = async (): Promise<void> => {
    const executionIds = Array.from(requestExecutionIds);
    await Promise.allSettled(
      executionIds.map(executionId =>
        databaseConnectionService.cancelQuery(executionId),
      ),
    );
  };
  requestSignal.addEventListener(
    "abort",
    () => {
      void cancelRegisteredExecutions();
    },
    { once: true },
  );

  const toolExecutionContext: NonNullable<
    AgentContext["toolExecutionContext"]
  > = {
    signal: requestSignal,
    createExecutionId: createAgentExecutionId,
    registerExecution: executionId => {
      requestExecutionIds.add(executionId);
      if (requestSignal.aborted) {
        requestExecutionIds.delete(executionId);
        void databaseConnectionService.cancelQuery(executionId);
      }
    },
    releaseExecution: executionId => {
      requestExecutionIds.delete(executionId);
    },
    isAborted: () => requestSignal.aborted,
  };

  // Extract last user text once — used by both console hints and skills retrieval.
  const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
  const lastUserText =
    lastUserMsg?.parts
      ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map(p => p.text)
      .join("") ?? "";

  // Auto-discover relevant consoles (parallel with other setup).
  // `searchConsoles` internally prefers vector search but falls back to
  // MongoDB $text and regex-name search, so we run it regardless of whether
  // Atlas vector search / embeddings are available — otherwise self-hosted /
  // local Mongo deployments would get zero hints and the agent would recreate
  // consoles it could have found by name.
  let consoleHints = "";
  if (
    (resolvedAgentId === "console" || resolvedAgentId === "unified") &&
    messages.length > 0
  ) {
    try {
      if (lastUserText.length >= 5) {
        const hints = await searchConsoles(lastUserText, workspaceId, 3);
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

  // Skills retrieval — runs for console + unified agents (parity with
  // self-directive). Index is always included when any skills exist;
  // bodies are only pulled in when score clears threshold.
  let skillsBlock = "";
  if (resolvedAgentId === "console" || resolvedAgentId === "unified") {
    try {
      const retrieval = await retrieveRelevantSkills(workspaceId, lastUserText);
      skillsBlock = renderSkillsPromptBlock(retrieval);
    } catch (err) {
      logger.debug("Skills block injection skipped", { error: err });
    }
  }

  const dashboardContext =
    activeView === "dashboard"
      ? {
          openDashboards,
          activeDashboardContext,
        }
      : {
          openDashboards: undefined,
          activeDashboardContext: undefined,
        };

  // Build agent context
  const agentContext: AgentContext = {
    workspaceId,
    activeView,
    activeExplorer,
    userId: actorId,
    consoles: enrichedConsoles,
    consoleId,
    openTabs,
    openDashboards: dashboardContext.openDashboards,
    databases: workspaceDatabases.map(db => ({
      id: db._id.toString(),
      name: db.name,
      type: db.type,
      sqlDialect: (db as any).sqlDialect || undefined,
    })),
    flowFormState,
    workspaceCustomPrompt,
    selfDirective,
    consoleHints,
    skillsBlock,
    activeConsoleResults,
    activeDashboardContext: dashboardContext.activeDashboardContext,
    toolExecutionContext,
    canManageScheduledQueries,
  };

  // Create agent configuration
  const agentConfig = agentFactory(agentContext);
  const { systemPrompt, tools } = agentConfig;

  const modelDef = await getModelById(resolvedModelId);
  // Self-heal wrapper: if the catalog still classifies this model as manual
  // thinking but Anthropic rejects the payload with the adaptive-only 400,
  // persist the corrected mode and retry the call transparently.
  const model = resolvedModelId.startsWith("anthropic/")
    ? withThinkingSelfHeal(getModel(resolvedModelId), resolvedModelId)
    : getModel(resolvedModelId);
  logger.info("Using model", { model: resolvedModelId });

  // Resolve object-storage-backed image attachments (from reopened chats) back
  // into inline data URLs the model provider can read. Freshly attached images
  // in the current turn already arrive as data URLs and pass through untouched.
  // Runs before sanitization so its empty-parts guard covers any message left
  // with no parts after a missing attachment is dropped.
  const messagesWithAttachments = await resolveChatAttachmentsForModel(
    messages,
    workspaceId,
  );

  // Sanitize messages to remove incomplete tool calls from interrupted streams
  // This prevents Anthropic API errors: "tool_use ids were found without tool_result blocks"
  const sanitizedMessages = sanitizeMessagesForModel(messagesWithAttachments);

  // Convert UI messages (from useChat) to model messages (for streamText)
  const modelMessages = await convertToModelMessages(sanitizedMessages);
  const screenshotVisionMessage = buildScreenshotVisionModelMessage(
    screenshotVisionAttachments,
  );
  if (screenshotVisionMessage) {
    modelMessages.push(
      screenshotVisionMessage as (typeof modelMessages)[number],
    );
    logger.info("Attached screenshot images to model request", {
      chatId,
      workspaceId,
      count: screenshotVisionAttachments?.length ?? 0,
    });
  }

  const MAX_STEPS = 256;
  let stepsCompleted = 0;

  const thinkingMode = modelDef?.thinkingMode ?? "none";
  const thinkingBudget = modelDef?.thinkingBudgetTokens ?? 10000;
  const thinkingPayload = buildAnthropicThinkingConfig(
    thinkingMode,
    thinkingBudget,
  );

  const providerOptions = {
    ...buildProviderOptions({
      userId: actorId,
      workspaceId,
      agentId: resolvedAgentId,
      invocationType: "chat",
    }),
    ...(thinkingPayload ? { anthropic: { thinking: thinkingPayload } } : {}),
  };

  const startTime = Date.now();

  // Group this turn into a single Langfuse trace. sessionId=chatId links the
  // messages of a conversation together in the Sessions view; userId enables
  // per-user cost/quality analysis; tags make traces filterable by
  // agent/model/view. These attributes propagate to the AI SDK GenAI spans
  // created synchronously within this callback.
  return await propagateAttributes(
    {
      traceName: "agent-chat",
      sessionId: chatId,
      userId: actorEmail ?? actorId,
      tags: [
        `agent:${resolvedAgentId}`,
        `model:${resolvedModelId}`,
        `view:${activeView ?? "unknown"}`,
      ],
    },
    async () => {
      const result = streamText({
        model,
        system: systemPrompt,
        messages: modelMessages,
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
        providerOptions,
        abortSignal: requestSignal,
        experimental_telemetry: {
          isEnabled: true,
          functionId: `agent-chat:${resolvedAgentId}`,
          metadata: {
            workspaceId,
            chatId,
            agentId: resolvedAgentId,
            modelId: resolvedModelId,
            invocationType: "chat",
          },
        },
        onStepFinish({ toolCalls }: { toolCalls?: Array<unknown> }) {
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

      // Drain the stream server-side so generation runs to completion and the
      // onFinish handler below always fires — even when the client disconnects
      // (network drop, tab close) or aborts via the Stop button. Without this the
      // HTTP response stops being pulled on disconnect, onFinish never runs, and
      // the entire assistant turn (and any tool work) is lost. With abortSignal
      // wired to the request signal, Stop still halts the LLM; we persist whatever
      // was generated up to that point.
      void result.consumeStream({
        onError: error =>
          logger.warn("Error draining chat stream", { error, chatId }),
      });

      // Return native AI SDK UI message stream response (for useChat compatibility)
      // Using AI SDK best practice: save once at the end with all messages
      return result.toUIMessageStreamResponse({
        originalMessages: messages,
        generateMessageId: () => new ObjectId().toString(),
        // Forward reasoning tokens from models that support extended thinking
        // (e.g., Claude claude-3-7-sonnet-20250219, DeepSeek deepseek-r1)
        sendReasoning: true,
        onFinish: ({ messages: allMessages, isAborted }) => {
          // Run finalization in the background so it does not block the UI
          // message stream from closing. The AI SDK awaits onFinish inside the
          // stream's flush(), and useChat only fires the tool-result auto-resume
          // once the stream closes — so any slow work here (cost computation,
          // saveChat, etc.) is serialized into the user-perceived latency of
          // every client-side tool round-trip, making fast tools (e.g. an
          // instant modify_console patch) appear frozen. See
          // scheduleChatFinalization above.
          scheduleChatFinalization(chatId, async () => {
            if (requestExecutionIds.size > 0) {
              await cancelRegisteredExecutions();
              requestExecutionIds.clear();
            }
            const durationMs = Date.now() - startTime;

            // Extract detailed per-step usage from result.steps
            let steps: Array<Record<string, unknown>> = [];
            try {
              steps = (await result.steps) as unknown as Array<
                Record<string, unknown>
              >;
            } catch (err) {
              logger.warn("Failed to get steps from result", { error: err });
            }

            // Aggregate detailed token usage across all steps
            let inputTokens = 0;
            let outputTokens = 0;
            let cacheReadTokens = 0;
            let cacheWriteTokens = 0;
            let reasoningTokens = 0;

            let stepDetails: Array<{
              modelId: string;
              inputTokens: number;
              outputTokens: number;
              cacheReadTokens: number;
              cacheWriteTokens: number;
              reasoningTokens: number;
              costUsd: number;
            }> = [];

            for (const step of steps) {
              const usage = step.usage as Record<string, unknown> | undefined;
              if (!usage) continue;

              const { inputTokens: sInput, outputTokens: sOutput } =
                extractTokenCounts(usage);

              const details = usage.inputTokenDetails as
                | Record<string, unknown>
                | undefined;
              const outDetails = usage.outputTokenDetails as
                | Record<string, unknown>
                | undefined;

              const sCacheRead = toNum(details?.cacheReadTokens);
              const sCacheWrite = toNum(details?.cacheWriteTokens);
              const sReasoning = toNum(outDetails?.reasoningTokens);

              inputTokens += sInput;
              outputTokens += sOutput;
              cacheReadTokens += sCacheRead;
              cacheWriteTokens += sCacheWrite;
              reasoningTokens += sReasoning;

              const stepModelId = (
                step.response as Record<string, unknown> | undefined
              )?.modelId as string | undefined;

              stepDetails.push({
                modelId: stepModelId || resolvedModelId,
                inputTokens: sInput,
                outputTokens: sOutput,
                cacheReadTokens: sCacheRead,
                cacheWriteTokens: sCacheWrite,
                reasoningTokens: sReasoning,
                costUsd: 0, // filled in by cost calculator
              });
            }

            // Fallback to top-level usage if no steps produced usage data
            if (stepDetails.length === 0) {
              try {
                const usage = (await result.usage) as unknown as Record<
                  string,
                  unknown
                >;
                const extracted = extractTokenCounts(usage ?? {});
                inputTokens = extracted.inputTokens;
                outputTokens = extracted.outputTokens;

                const details = usage?.inputTokenDetails as
                  | Record<string, unknown>
                  | undefined;
                const outDetails = usage?.outputTokenDetails as
                  | Record<string, unknown>
                  | undefined;
                cacheReadTokens = toNum(details?.cacheReadTokens);
                cacheWriteTokens = toNum(details?.cacheWriteTokens);
                reasoningTokens = toNum(outDetails?.reasoningTokens);
              } catch (err) {
                logger.warn("Failed to get usage from model", { error: err });
              }
            }

            const totalTokens = inputTokens + outputTokens;

            logger.info(
              isAborted
                ? "Stream aborted, saving partial chat"
                : "Stream finished, saving chat",
              {
                chatId,
                isAborted,
                messageCount: allMessages.length,
                inputTokens,
                outputTokens,
                cacheReadTokens,
                totalTokens,
                durationMs,
              },
            );

            // Compute cost before saving so both trackUsage and saveChat receive it
            let costUsd: number | undefined;
            try {
              const costResult = await computeInvocationCost({
                modelId: resolvedModelId,
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheWriteTokens,
                reasoningTokens,
                steps: stepDetails,
              });
              costUsd = costResult.totalCostUsd;
              if (costResult.steps) {
                stepDetails = costResult.steps;
              }
            } catch (err) {
              logger.warn("Failed to compute invocation cost", { error: err });
            }

            // Track usage (fire-and-forget)
            void trackUsage({
              workspaceId,
              userId: actorId,
              chatId,
              invocationType: "chat",
              modelId: resolvedModelId,
              inputTokens,
              outputTokens,
              cacheReadTokens,
              cacheWriteTokens,
              reasoningTokens,
              totalTokens,
              steps: stepDetails,
              agentId: resolvedAgentId,
              durationMs,
              costUsd,
            }).catch(err =>
              logger.warn("Failed to track LLM usage", { error: err }),
            );

            try {
              await saveChat(chatId, workspaceId, actorId, allMessages, {
                promptTokens: inputTokens,
                completionTokens: outputTokens,
                totalTokens,
                cacheReadTokens,
                cacheWriteTokens,
                reasoningTokens,
                costUsd,
                model: resolvedModelId,
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
                    const console = await SavedConsole.findById(
                      consoleId,
                    ).select("code name connectionId databaseName language");
                    if (!console) continue;

                    const connDoc = console.connectionId
                      ? await DatabaseConnection.findById(console.connectionId)
                      : null;

                    const { description, embedding, embeddingModel } =
                      await generateDescriptionAndEmbedding(
                        {
                          code: console.code,
                          title: console.name,
                          connectionName: connDoc?.name,
                          databaseType: connDoc?.type,
                          databaseName: console.databaseName,
                          language: console.language,
                          conversationExcerpt: ctx.conversationExcerpt,
                          resultSample: ctx.resultSample,
                        },
                        { workspaceId, userId: actorId, userEmail: actorEmail },
                      );

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
          });
        },
      });
    },
  );
});
