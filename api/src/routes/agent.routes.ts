/**
 * Agent Routes
 * Native Vercel AI SDK streaming protocol for useChat compatibility
 * Uses agent registry for multi-agent support
 */

import { Types } from "mongoose";
import { createRoute, z } from "@hono/zod-openapi";
import { ObjectId } from "mongodb";
import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
} from "ai";
import { getModel, buildProviderOptions } from "../agent-lib/ai-gateway";
import {
  buildClientStreamErrorPayload,
  describeStreamError,
} from "../agent-lib/stream-error";
import { repairStringifiedToolInputs } from "../agent-lib/tool-input-repair";
import { propagateAttributes } from "@langfuse/tracing";
import { buildAnthropicThinkingConfig } from "../agent-lib/anthropic-thinking";
import { withThinkingSelfHeal } from "../agent-lib/thinking-self-heal";
import { withContextOverflowSelfHeal } from "../agent-lib/context-overflow-self-heal";
import {
  computeInputBudget,
  compactUiMessagesForBudget,
  dedupeAssistantReasoning,
  elideOldToolOutputs,
  stripReplayedReasoning,
} from "../agent-lib/context/compaction";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import type { ConsoleDataV2 } from "../agent-lib/types";
import {
  getModelById,
  getAvailableModels,
  getDefaultModelId,
  getDefaultFreeModelId,
} from "../agent-lib/ai-models";
import { getWorkspaceGatewayModelListings } from "../services/model-catalog.service";
import {
  AppWorktreeV2,
  Workspace,
  DatabaseConnection,
  Chat,
  SavedConsole,
} from "../database/workspace-schema";
import { saveChat } from "../services/agent-thread.service";
import { buildMcpToolsForChat } from "../services/mcp-client.service";
import { trackUsage } from "../services/llm-usage.service";
import { computeInvocationCost } from "../services/cost-calculator";
import { generateChatTitle } from "../services/title-generator";
import {
  isDescriptionGenAvailable,
  extractConsoleContextFromMessages,
  generateDescriptionAndEmbedding,
} from "../services/console-description.service";
import { searchConsoles } from "../agent-lib/tools/console-search-tools";
import { prepareAgentTurnGuidance } from "../services/agent-turn-preparation.service";
import { isDbtShapedTurn } from "../dbt/dbt-turn-shape";
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
import {
  buildUnifiedModeRuntime,
  type UnifiedModeRuntime,
} from "../agents/modes";
import { databaseConnectionService } from "../services/database-connection.service";
import { createAgentExecutionId } from "../agent-lib/tools/shared/truncation";
import { toNum, extractTokenCounts } from "../utils/safe-num";
import { scheduleChatFinalization } from "./chat-finalization-queue";
import {
  getResumableStreamContext,
  registerActiveGeneration,
  clearActiveGeneration,
} from "../services/resumable-stream.service";
import { hasAttachedClients } from "../services/realtime-presence.service";
import { publishRealtimeEvent } from "../services/realtime.service";
import { commitAgentTurn } from "../apps-v2/worktree.service";
import { reportPubSubFailure } from "../services/pubsub.service";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";
import {
  buildScreenshotVisionModelMessage,
  resumeChatStream,
  stopChatGeneration,
  withSseKeepAlive,
  type ScreenshotVisionAttachment,
} from "../services/agent-stream.service";

const logger = loggers.agent();

export const agentRoutes = createRouter();

const ChatIdParam = z.object({
  chatId: z.string().openapi({ param: { name: "chatId", in: "path" } }),
});
const StreamResponses = {
  ...OPEN_RESPONSES,
  200: {
    description: "Streaming response (AI SDK UI message stream / SSE).",
    content: { "text/event-stream": { schema: z.string() } },
  },
};

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
agentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/models",
    tags: ["Agent"],
    summary: "List available AI models",
    security: AUTH_SECURITY,
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
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
  },
);

/**
 * GET /gateway-models - Model catalog available to workspaces.
 *
 * Returns the super-admin-curated catalog from MongoDB (same source as
 * GET /models). Avoids a live fetch to ai-gateway.vercel.sh in the request
 * path — that upstream call is refreshed out-of-band by Inngest/startup.
 */
agentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/gateway-models",
    tags: ["Agent"],
    summary: "List gateway models with curation",
    security: AUTH_SECURITY,
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const models = await getWorkspaceGatewayModelListings();
    return c.json({ models });
  },
);

/**
 * GET /agents - List available agent modes
 */
agentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/agents",
    tags: ["Agent"],
    summary: "List available agents",
    security: AUTH_SECURITY,
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const agents = getAllAgentMeta();
    return c.json({ agents });
  },
);

/**
 * POST /api/agent/chat
 * useChat-compatible endpoint using native AI SDK streaming
 */
agentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/chat",
    tags: ["Agent"],
    summary: "Stream an agent chat turn",
    description:
      "Runs an agent chat turn and streams the response using the Vercel AI SDK UI message stream protocol.",
    security: AUTH_SECURITY,
    request: {
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...StreamResponses },
  }),
  async c => {
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
      notebookId?: string;
      connectionId?: string;
      databaseName?: string;
      dbtProjectId?: string;
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
            .filter(
              (p): p is { type: "text"; text: string } => p.type === "text",
            )
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

    // The turn's lifetime is decoupled from the HTTP connection: the SSE
    // response is buffered as a resumable stream (see consumeSseStream below),
    // so a browser disconnect (refresh, tab close, network drop) must NOT abort
    // generation — reconnecting clients pick the stream back up. Aborting is an
    // explicit action via POST /chat/:chatId/stop, which fires this controller.
    const turnAbortController = new AbortController();
    const turnSignal = turnAbortController.signal;
    const requestExecutionIds = new Set<string>();

    // Cancel all currently-registered database executions.
    // Invariant: this only runs as a batch on abort. Any execution registered
    // *after* the abort fires is individually cancelled inside registerExecution
    // (which checks turnSignal.aborted synchronously after adding the ID).
    const cancelRegisteredExecutions = async (): Promise<void> => {
      const executionIds = Array.from(requestExecutionIds);
      await Promise.allSettled(
        executionIds.map(executionId =>
          databaseConnectionService.cancelQuery(executionId),
        ),
      );
    };
    turnSignal.addEventListener(
      "abort",
      () => {
        void cancelRegisteredExecutions();
      },
      { once: true },
    );

    const toolExecutionContext: NonNullable<
      AgentContext["toolExecutionContext"]
    > = {
      signal: turnSignal,
      createExecutionId: createAgentExecutionId,
      registerExecution: executionId => {
        requestExecutionIds.add(executionId);
        if (turnSignal.aborted) {
          requestExecutionIds.delete(executionId);
          void databaseConnectionService.cancelQuery(executionId);
        }
      },
      releaseExecution: executionId => {
        requestExecutionIds.delete(executionId);
      },
      isAborted: () => turnSignal.aborted,
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

    let skillsBlock = "";
    let dbtRulesBlock = "";
    if (resolvedAgentId === "console" || resolvedAgentId === "unified") {
      try {
        const includeDbtRules = isDbtShapedTurn({ openTabs, tabKind });
        const dbtTabs = (openTabs ?? []).filter(t => t.dbtProjectId);
        const activeDbtProjectId = dbtTabs.find(t => t.isActive)?.dbtProjectId;
        const distinctProjectIds = new Set(dbtTabs.map(t => t.dbtProjectId));
        const dbtProjectId =
          activeDbtProjectId ??
          (distinctProjectIds.size === 1
            ? dbtTabs[0]?.dbtProjectId
            : undefined);
        const guidance = await prepareAgentTurnGuidance({
          workspaceId,
          userId: actorId,
          userText: lastUserText,
          includeDbtRules,
          dbtProjectId,
        });
        skillsBlock = guidance.skillsBlock;
        dbtRulesBlock = guidance.dbtRulesBlock;
      } catch (err) {
        logger.warn("Turn guidance injection skipped", { error: err });
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

    // MCP tools (Close CRM etc.): built from DB-cached tool definitions, so
    // this never blocks on remote MCP servers. Executions connect on demand.
    let mcpChatTools: Awaited<ReturnType<typeof buildMcpToolsForChat>> = {
      tools: {},
      readOnlyToolNames: [],
      allToolNames: [],
      catalog: [],
    };
    if (resolvedAgentId === "unified") {
      try {
        mcpChatTools = await buildMcpToolsForChat({
          workspaceId,
          userId: actorId,
        });
        if (mcpChatTools.allToolNames.length > 0) {
          logger.info("MCP tools loaded for chat", {
            workspaceId,
            chatId,
            toolCount: mcpChatTools.allToolNames.length,
          });
        }
      } catch (err) {
        logger.warn("MCP tool loading skipped", { error: err });
      }
    }

    // The caller's Apps v2 checkout branch, so the agent starts oriented
    // instead of spending a tool call on `git status`. The doc is synced by
    // every exec and checkout; a missing doc simply means "main".
    const appsV2Worktree = await AppWorktreeV2.findOne(
      { workspaceId: new Types.ObjectId(workspaceId), userId: actorId },
      { branch: 1 },
    )
      .lean()
      .catch(() => null);

    // Build agent context
    const agentContext: AgentContext = {
      workspaceId,
      chatId,
      appsV2Branch: appsV2Worktree?.branch ?? undefined,
      activeView,
      activeExplorer,
      userId: actorId,
      consoles: enrichedConsoles,
      consoleId,
      notebookId: openTabs?.find(t => t.isActive && t.kind === "notebook")
        ?.notebookId,
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
      dbtRulesBlock,
      activeConsoleResults,
      activeDashboardContext: dashboardContext.activeDashboardContext,
      toolExecutionContext,
      canManageScheduledQueries,
      mcpTools: mcpChatTools.tools,
      mcpReadOnlyToolNames: mcpChatTools.readOnlyToolNames,
      mcpToolNames: mcpChatTools.allToolNames,
      mcpToolCatalog: mcpChatTools.catalog,
    };

    // Create agent configuration.
    //
    // The unified agent uses the PostHog-style mode-switching runtime: a single
    // ALL_TOOLS union plus a `prepareStep` that recomputes the active tool
    // allowlist + cached system blocks each step from a derived mode state. This
    // is what enforces the plan hard gate (mutations blocked once the model has
    // submitted a plan, until the user approves). Other agents keep the simpler
    // static system + tools path.
    let systemPrompt: ReturnType<typeof agentFactory>["systemPrompt"];
    let tools: ReturnType<typeof agentFactory>["tools"];
    let prepareStep: UnifiedModeRuntime["prepareStep"] | undefined;

    if (resolvedAgentId === "unified") {
      const runtime = buildUnifiedModeRuntime({
        context: agentContext,
        messages,
        tabKind,
        modelId: resolvedModelId,
      });
      systemPrompt = runtime.system;
      tools = runtime.tools;
      prepareStep = runtime.prepareStep;
      logger.info("Unified mode runtime", {
        enabledModes: Array.from(runtime.modeState.enabledModes),
        planSubmitted: runtime.modeState.planSubmitted,
        planApproved: runtime.modeState.planApproved,
        loadedToolCount: runtime.modeState.loadedToolNames.length,
        ...runtime.workingSet,
      });
      if (
        runtime.workingSet.pagingActive &&
        runtime.workingSet.activeToolCount >= runtime.workingSet.maxActiveTools
      ) {
        logger.warn("Tool working set at budget — oldest loads evicted", {
          chatId,
          modelId: resolvedModelId,
          ...runtime.workingSet,
        });
      }
    } else {
      const agentConfig = agentFactory(agentContext);
      systemPrompt = agentConfig.systemPrompt;
      tools = agentConfig.tools;
    }

    const modelDef = await getModelById(resolvedModelId);
    // Self-heal wrapper: if the catalog still classifies this model as manual
    // thinking but Anthropic rejects the payload with the adaptive-only 400,
    // persist the corrected mode and retry the call transparently.
    const baseModel = resolvedModelId.startsWith("anthropic/")
      ? withThinkingSelfHeal(getModel(resolvedModelId), resolvedModelId)
      : getModel(resolvedModelId);
    // Provider-agnostic backstop: if the prompt still overflows the context
    // window (estimate was too optimistic, or contextWindow unknown), retry
    // once with aggressively trimmed history instead of surfacing a raw 400.
    const model = withContextOverflowSelfHeal(baseModel, resolvedModelId);
    logger.info("Using model", { model: resolvedModelId });

    /**
     * Build the model messages for one generation segment.
     *
     * - Resolves object-storage-backed image attachments (from reopened chats)
     *   back into inline data URLs the model provider can read. Runs before
     *   sanitization so its empty-parts guard covers any message left with no
     *   parts after a missing attachment is dropped.
     * - Sanitizes messages to remove incomplete tool calls from interrupted
     *   streams (prevents Anthropic "tool_use ids without tool_result" errors).
     * - Screenshot vision attachments ride only on the FIRST segment (they are
     *   consumed from the originating request).
     */
    const buildSegmentModelMessages = async (
      segmentUiMessages: UIMessage[],
      includeVisionAttachments: boolean,
    ) => {
      const messagesWithAttachments = await resolveChatAttachmentsForModel(
        segmentUiMessages,
        workspaceId,
      );
      const sanitizedMessages = sanitizeMessagesForModel(
        messagesWithAttachments,
      );
      // Always-on cost control (budget-independent): the client replays the
      // entire `messages[]` every turn, so a long session re-sends every prior
      // turn's full tool outputs on every request — re-billed as input tokens
      // each time, even when the prompt comfortably fits the context window.
      // Elide large tool outputs from older turns (keeping the most recent
      // turns verbatim) before any budget math. This is the main lever against
      // runaway spend on long chats. Runs even when `contextWindow` is unknown.
      const elision = elideOldToolOutputs(sanitizedMessages);
      let messagesForModel = elision.messages;
      if (elision.changed) {
        logger.info("Elided old tool outputs before generation", {
          chatId,
          workspaceId,
          modelId: resolvedModelId,
          elidedCount: elision.elidedCount,
        });
      }
      // Strip replayed thinking/reasoning traces. `sendReasoning: true` persists
      // the model's thinking and the client replays it every turn; a model never
      // needs to re-read its own past thinking, and those blocks are re-billed as
      // input tokens each request. Kept only on the assistant turn being
      // continued with tool results (Anthropic interleaved-thinking requirement).
      const reasoningStrip = stripReplayedReasoning(messagesForModel);
      messagesForModel = reasoningStrip.messages;
      if (reasoningStrip.changed) {
        logger.info("Stripped replayed reasoning before generation", {
          chatId,
          workspaceId,
          modelId: resolvedModelId,
          strippedCount: reasoningStrip.strippedCount,
        });
      }
      // Collapse duplicate reasoning parts on the assistant turn(s) preserved
      // above. A persisted assistant message can accumulate duplicate thinking
      // blocks (streamed parts merged with `originalMessages`, resumable-stream
      // replay, persist→reload). On a tool-use continuation Anthropic requires
      // the latest assistant message's thinking blocks to be replayed
      // byte-for-byte unmodified, and a duplicate IS a modification — the turn
      // is rejected with "thinking ... blocks in the latest assistant message
      // cannot be modified", permanently wedging the chat. De-duping restores
      // the original sequence so the turn round-trips.
      const reasoningDedupe = dedupeAssistantReasoning(messagesForModel);
      messagesForModel = reasoningDedupe.messages;
      if (reasoningDedupe.changed) {
        logger.info("De-duplicated replayed reasoning before generation", {
          chatId,
          workspaceId,
          modelId: resolvedModelId,
          removedCount: reasoningDedupe.removedCount,
        });
      }
      // Proactively keep the prompt under the model's context window. Budget is
      // derived from the catalog `contextWindow` (provider-agnostic — every
      // gateway model reports it); when unknown we skip this and rely on the
      // reactive overflow backstop wrapping the model. Tool calls/results live
      // as parts inside a single assistant UIMessage here, so compacting whole
      // messages preserves tool call↔result pairing automatically.
      const inputBudget = computeInputBudget({
        contextWindow: modelDef?.contextWindow,
        systemText: systemPrompt,
        thinkingBudgetTokens: modelDef?.thinkingBudgetTokens,
      });
      if (inputBudget !== null) {
        const compaction = await compactUiMessagesForBudget({
          messages: messagesForModel,
          budgetTokens: inputBudget,
          summarize: true,
          abortSignal: turnSignal,
        });
        messagesForModel = compaction.messages;
        if (compaction.didCompact) {
          logger.info("Compacted chat history before generation", {
            chatId,
            workspaceId,
            modelId: resolvedModelId,
            strategy: compaction.strategy,
            estimatedTokensBefore: compaction.estimatedTokensBefore,
            estimatedTokensAfter: compaction.estimatedTokensAfter,
            budgetTokens: inputBudget,
          });
        }
      }
      const modelMessages = await convertToModelMessages(messagesForModel);
      if (includeVisionAttachments) {
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
      }
      return modelMessages;
    };

    const MAX_STEPS = 256;

    // "No client attached" fallback (issue #475): when a turn dead-ends on
    // client-only tools (e.g. capture_screenshot, dashboard tools) and no
    // browser window is attached to the workspace, the server synthesizes the
    // tool results and continues the turn itself so the model can adapt
    // instead of the chat stalling until someone reattaches. Bounded so a
    // model that keeps calling browser tools can't loop forever.
    const MAX_NO_CLIENT_CONTINUATIONS = 3;
    const STRANDED_GRACE_MS = 10_000;
    const NO_CLIENT_TOOL_RESULT = {
      success: false,
      error:
        "No client attached — this tool needs an open browser window in the workspace. Continue without it (use server-side tools) or summarize what you would have done.",
    };
    // Human-in-the-loop tools must stay pending until a person answers.
    const HUMAN_IN_THE_LOOP_TOOLS = new Set([
      "ask_clarifying_questions",
      "submit_plan",
    ]);

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
        /**
         * Run one generation segment of this turn.
         *
         * Segment 0 is the normal request-driven generation. Further segments
         * exist only for the "no client attached" fallback: when a segment
         * ends stranded on client-only tool calls with no browser attached,
         * finalization synthesizes the tool results and starts the next
         * segment server-side (the continuation's Response body has no HTTP
         * consumer; the resumable stream still buffers it for reattaching
         * clients).
         */
        const runSegment = async (
          segmentUiMessages: UIMessage[],
          continuationDepth: number,
        ): Promise<Response> => {
          const modelMessages = await buildSegmentModelMessages(
            segmentUiMessages,
            continuationDepth === 0,
          );
          const startTime = Date.now();
          let stepsCompleted = 0;
          // Stream ID minted in consumeSseStream once the SSE stream starts;
          // used by finalization to clear the resume pointer for exactly this
          // segment.
          let turnStreamId: string | null = null;

          const result = streamText({
            model,
            system: systemPrompt,
            messages: modelMessages,
            tools,
            ...(prepareStep
              ? {
                  prepareStep: prepareStep as Parameters<
                    typeof streamText
                  >[0]["prepareStep"],
                }
              : {}),
            stopWhen: stepCountIs(MAX_STEPS),
            // Deterministic fix-up for models that emit tool args with nested
            // values JSON-stringified (e.g. an array param as "[\"...\"]"),
            // which otherwise fail schema validation and dead-end the tool
            // call. See agent-lib/tool-input-repair.ts.
            experimental_repairToolCall: repairStringifiedToolInputs,
            providerOptions,
            abortSignal: turnSignal,
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
            // The AI SDK's default onError is a bare console.error(error) —
            // unstructured and without any request context, which made
            // provider-scoped gateway failures (e.g. a 401 for one provider
            // while others work) effectively untraceable. Log the full
            // description so failed turns can be found by chatId / model /
            // gateway generationId in logs and alerting.
            onError({ error }: { error: unknown }) {
              logger.error("Chat model stream error", {
                ...describeStreamError(error),
                chatId,
                workspaceId,
                agentId: resolvedAgentId,
                modelId: resolvedModelId,
                continuationDepth,
                error,
              });
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
          // the entire assistant turn (and any tool work) is lost. Disconnects no
          // longer abort the turn (turnSignal only fires via the explicit stop
          // endpoint); the resumable stream below lets clients reattach mid-turn.
          void result.consumeStream({
            onError: error =>
              logger.warn("Error draining chat stream", { error, chatId }),
          });

          // Return native AI SDK UI message stream response (for useChat compatibility)
          // Using AI SDK best practice: save once at the end with all messages
          const streamResponse = result.toUIMessageStreamResponse({
            originalMessages: segmentUiMessages,
            generateMessageId: () => new ObjectId().toString(),
            // Replace the SDK's raw error text (for gateway auth failures a
            // misleading "configure AI_GATEWAY_API_KEY" message) with the
            // structured `{ code, message, ... }` JSON envelope. The client
            // treats JSON errors with a `code` as terminal server errors:
            // it renders `message` immediately instead of burning resume
            // retries on a turn that is already dead.
            onError: (error: unknown) =>
              buildClientStreamErrorPayload(error, resolvedModelId),
            // Forward reasoning tokens from models that support extended thinking
            // (e.g., Claude claude-3-7-sonnet-20250219, DeepSeek deepseek-r1)
            sendReasoning: true,
            // Buffer a tee'd copy of the SSE stream so detached clients (refresh,
            // other devices, additional viewers) can reattach via
            // GET /chat/:chatId/stream while the turn is still generating. The
            // chat's activeStreamId is the resume pointer; finalization clears it.
            consumeSseStream: async ({ stream }) => {
              // Persist the conversation as of turn start (which includes this
              // turn's user message — until now it only existed in the request
              // body). A client that reloads mid-turn can then render the full
              // history from MongoDB and layer the resumed SSE replay (assistant
              // chunks only) on top. Also bumps updatedAt so the in-flight chat
              // sorts to the top of the history list. Scheduled through the
              // per-chat finalization queue so a fast turn's finalization (full
              // message set) can never be overwritten by this earlier snapshot.
              scheduleChatFinalization(chatId, async () => {
                try {
                  await saveChat(
                    chatId,
                    workspaceId,
                    actorId,
                    segmentUiMessages,
                  );
                } catch (error) {
                  logger.warn("Failed to persist turn-start messages", {
                    error,
                    chatId,
                  });
                }
              });

              const streamId = new ObjectId().toString();
              turnStreamId = streamId;
              try {
                registerActiveGeneration(chatId, streamId, turnAbortController);
                await getResumableStreamContext().createNewResumableStream(
                  streamId,
                  () => stream,
                );
                await Chat.updateOne(
                  { _id: new ObjectId(chatId) },
                  { $set: { activeStreamId: streamId } },
                );
                // Live activity indicators: open windows light up the chat in
                // the history menu without polling.
                publishRealtimeEvent(workspaceId, {
                  type: "chat.activity",
                  chatId,
                  state: "streaming",
                });
              } catch (error) {
                // Resumability is best-effort: the direct response stream to
                // the originating client is unaffected by failures here. But
                // it failing means reload/second-device reattach is silently
                // broken for this turn — log at ERROR so Error Reporting
                // alerts (the Upstash quota exhaustion hid behind a warn),
                // and feed the throttled backend-level reporter.
                logger.error("Failed to set up resumable stream", {
                  error,
                  chatId,
                  streamId,
                });
                reportPubSubFailure("resumable-stream-setup", error);
              }
            },
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

                // Apps v2 (Cursor-cloud model): turn any WIP the agent
                // accumulated on this conversation's app branches into one
                // commit per turn. No-op unless the turn touched an Apps v2
                // worktree; never throws.
                if (!isAborted) {
                  try {
                    const lastUserText = [...allMessages]
                      .reverse()
                      .find(m => m.role === "user")
                      ?.parts?.filter(
                        (p): p is { type: "text"; text: string } =>
                          (p as { type?: string }).type === "text",
                      )
                      .map(p => p.text)
                      .join(" ");
                    await commitAgentTurn(workspaceId, actorId, lastUserText);
                  } catch (err) {
                    logger.warn("Apps v2 turn commit failed", { error: err });
                  }
                }

                // Extract detailed per-step usage from result.steps
                let steps: Array<Record<string, unknown>> = [];
                try {
                  steps = (await result.steps) as unknown as Array<
                    Record<string, unknown>
                  >;
                } catch (err) {
                  logger.warn("Failed to get steps from result", {
                    error: err,
                  });
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
                  const usage = step.usage as
                    | Record<string, unknown>
                    | undefined;
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
                    logger.warn("Failed to get usage from model", {
                      error: err,
                    });
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
                  logger.warn("Failed to compute invocation cost", {
                    error: err,
                  });
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

                // "No client attached" fallback: if this segment dead-ended on
                // client-only tool calls and no browser is attached, synthesize
                // the tool results and continue the turn server-side. When a
                // continuation starts it owns the resume pointer, so the clear
                // below is skipped.
                let continued = false;
                try {
                  continued = await maybeContinueStrandedTurn(
                    allMessages,
                    isAborted,
                    continuationDepth,
                    turnStreamId,
                  );
                } catch (error) {
                  logger.warn("Stranded-turn continuation failed", {
                    error,
                    chatId,
                  });
                }

                // Turn is finalized: drop the resume pointer so reconnecting
                // clients load the saved chat instead of reattaching. Guarded on
                // the streamId so a newer turn's pointer is never clobbered.
                if (!continued && turnStreamId) {
                  clearActiveGeneration(chatId, turnStreamId);
                  try {
                    await Chat.updateOne(
                      {
                        _id: new ObjectId(chatId),
                        activeStreamId: turnStreamId,
                      },
                      { $set: { activeStreamId: null } },
                    );
                  } catch (error) {
                    logger.warn("Failed to clear activeStreamId", {
                      error,
                      chatId,
                    });
                  }
                  publishRealtimeEvent(workspaceId, {
                    type: "chat.activity",
                    chatId,
                    state: "idle",
                  });
                }

                if (isDescriptionGenAvailable()) {
                  void (async () => {
                    try {
                      const consoleContexts =
                        extractConsoleContextFromMessages(allMessages);
                      for (const [consoleId, ctx] of consoleContexts) {
                        const console = await SavedConsole.findById(
                          consoleId,
                        ).select(
                          "code name connectionId databaseName language",
                        );
                        if (!console) continue;

                        const connDoc = console.connectionId
                          ? await DatabaseConnection.findById(
                              console.connectionId,
                            )
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
                            {
                              workspaceId,
                              userId: actorId,
                              userEmail: actorEmail,
                            },
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

          return withSseKeepAlive(streamResponse);
        };

        /**
         * Stranded-turn detection + continuation ("no client attached"
         * fallback, issue #475).
         *
         * A segment is stranded when it finished waiting on tool calls that
         * only a browser can execute, but no browser window is attached to
         * the workspace (refresh mid-call, tab closed). In that case we patch
         * the pending tool parts with an in-band "no client attached" result,
         * persist, and run the next segment so the model can adapt and the
         * turn survives end-to-end.
         *
         * Returns true when a continuation segment was started (the caller
         * must then leave the resume pointer to the new segment).
         */
        const maybeContinueStrandedTurn = async (
          allMessages: UIMessage[],
          isAborted: boolean,
          continuationDepth: number,
          segmentStreamId: string | null,
        ): Promise<boolean> => {
          if (isAborted || turnSignal.aborted) return false;
          if (continuationDepth >= MAX_NO_CLIENT_CONTINUATIONS) {
            return false;
          }

          const lastMessage = allMessages[allMessages.length - 1];
          if (!lastMessage || lastMessage.role !== "assistant") return false;

          type ToolPart = {
            type: string;
            state?: string;
            toolName?: string;
            input?: unknown;
          };
          const pendingParts = ((lastMessage.parts ?? []) as ToolPart[]).filter(
            part =>
              (part.type?.startsWith("tool-") ||
                part.type === "dynamic-tool") &&
              part.state === "input-available",
          );
          if (pendingParts.length === 0) return false;

          // Every pending tool must be a registered client-side tool (no
          // execute function) and none may be human-in-the-loop.
          for (const part of pendingParts) {
            const toolName =
              part.type === "dynamic-tool"
                ? (part.toolName ?? "")
                : part.type.slice("tool-".length);
            if (HUMAN_IN_THE_LOOP_TOOLS.has(toolName)) return false;
            const registered = (
              tools as Record<string, { execute?: unknown } | undefined>
            )[toolName];
            if (!registered || typeof registered.execute === "function") {
              return false;
            }
          }

          // Grace period: a client that just refreshed gets a chance to
          // reattach and run the tools itself (the normal client-driven loop).
          await new Promise(resolve => setTimeout(resolve, STRANDED_GRACE_MS));
          if (turnSignal.aborted) return false;
          if (await hasAttachedClients(workspaceId)) return false;

          // Confirm this segment still owns the turn (no newer turn or stop).
          const freshChat =
            await Chat.findById(chatId).select("activeStreamId");
          if (!freshChat || freshChat.activeStreamId !== segmentStreamId) {
            return false;
          }

          const pendingSet = new Set(pendingParts);
          const patchedLast = {
            ...lastMessage,
            parts: (lastMessage.parts ?? []).map(part =>
              pendingSet.has(part as ToolPart)
                ? {
                    ...part,
                    state: "output-available" as const,
                    output: NO_CLIENT_TOOL_RESULT,
                  }
                : part,
            ),
          } as UIMessage;
          const patchedMessages = [...allMessages.slice(0, -1), patchedLast];

          try {
            await saveChat(chatId, workspaceId, actorId, patchedMessages);
          } catch (error) {
            logger.warn("Failed to persist synthesized tool results", {
              error,
              chatId,
            });
            return false;
          }

          logger.info("Continuing stranded turn without attached client", {
            chatId,
            continuationDepth: continuationDepth + 1,
            pendingTools: pendingParts.map(p =>
              p.type === "dynamic-tool" ? p.toolName : p.type.slice(5),
            ),
          });

          // The continuation Response has no HTTP consumer — drain its body so
          // nothing backs up; reattaching clients consume the resumable copy.
          const response = await runSegment(
            patchedMessages,
            continuationDepth + 1,
          );
          if (response.body) {
            void response.body
              .pipeTo(
                new WritableStream({
                  write() {
                    /* discard */
                  },
                }),
              )
              .catch(() => undefined);
          }
          return true;
        };

        return await runSegment(messages, 0);
      },
    );
  },
);

/**
 * Load a chat and verify the caller may access its workspace. Mirrors the
 * auth model of POST /chat: session users need workspace membership, API
 * keys must belong to the chat's workspace.
 */
/**
 * GET /api/agent/chat/:chatId/stream
 *
 * Resume endpoint for useChat({ resume: true }). Reattaches the caller to
 * the chat's in-flight turn: buffered chunks are replayed, then live chunks
 * follow. Multiple clients may attach to the same stream concurrently.
 * Responds 204 when nothing is streaming — the client then renders the chat
 * persisted in MongoDB.
 */
agentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/chat/{chatId}/stream",
    tags: ["Agent"],
    summary: "Resume an in-flight chat stream",
    security: AUTH_SECURITY,
    request: { params: ChatIdParam },
    responses: { ...StreamResponses },
  }),
  async c => {
    const chatId = c.req.param("chatId");
    const result = await resumeChatStream(c, chatId);
    if (result.kind === "no-content") return c.body(null, 204);
    if (result.kind === "forbidden") {
      return c.json({ error: "Cannot access chat stream" }, result.status);
    }
    return result.response;
  },
);

/**
 * POST /api/agent/chat/:chatId/stop
 *
 * Explicitly aborts the chat's in-flight generation. With resumable streams a
 * client disconnect (refresh, tab close) intentionally no longer cancels the
 * turn, so the Stop button calls this endpoint. Aborting triggers the normal
 * onFinish(isAborted) path, which persists the partial assistant message and
 * clears the resume pointer.
 */
agentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/chat/{chatId}/stop",
    tags: ["Agent"],
    summary: "Stop an in-flight chat generation",
    security: AUTH_SECURITY,
    request: { params: ChatIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const chatId = c.req.param("chatId");
    const result = await stopChatGeneration(c, chatId);
    if (result.kind === "not-found") return c.json({ stopped: false });
    if (result.kind === "forbidden") {
      return c.json({ error: "Cannot access chat" }, result.status);
    }
    return c.json({ stopped: result.stopped });
  },
);
