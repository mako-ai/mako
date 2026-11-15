/**
 * POST /api/agent/chat as a pipeline of named steps:
 *
 *   validate request → authorize workspace → authorize app chat →
 *   select model (+ billing) → load or create chat → load workspace context →
 *   resolve agent → open abort scope → gather turn guidance →
 *   resolve runtime (prompt + tool working set) → run segment 0
 *
 * Each step lives in its own module; this file only threads their results
 * together, in the order the route has always run them (the status a client
 * sees for a bad request depends on that order).
 */
import { propagateAttributes } from "@langfuse/tracing";
import { ObjectId } from "mongodb";

import { buildProviderOptions } from "../../agent-lib/ai-gateway";
import { getModelById } from "../../agent-lib/ai-models";
import { buildAnthropicThinkingConfig } from "../../agent-lib/anthropic-thinking";
import {
  detectAgentId,
  getAgentFactory,
  type AgentContext,
} from "../../agents";
import { enrichContextWithWorkspace, loggers } from "../../logging";
import { modelSupportsImageInput } from "../model-catalog.service";
import { gatherTurnGuidance, loadWorkspaceTurnContext } from "./agent-context";
import { resolveChatAgentRuntime } from "./agent-runtime";
import { loadOrCreateChat } from "./chat-record";
import { buildChatLanguageModel, selectChatModel } from "./model-selection";
import {
  authorizeAppChatRequest,
  authorizeWorkspaceAccess,
  lastUserMessageText,
  resolveCanManageScheduledQueries,
  stepFailure,
  validateChatRequest,
  type ChatPrincipal,
  type ChatRequestBody,
  type StepFailure,
} from "./request";
import { runSegment } from "./run-segment";
import { createTurnAbortScope } from "./turn-abort";
import type { ChatTurn } from "./turn";

const logger = loggers.agent();

function failed(f: StepFailure) {
  return { kind: "failure" as const, status: f.status, error: f.error };
}

export type ChatTurnOutcome =
  | { kind: "stream"; response: Response }
  | { kind: "failure"; status: StepFailure["status"]; error: string }
  | {
      kind: "billing";
      status: 402 | 403;
      body: Extract<
        Awaited<ReturnType<typeof selectChatModel>>,
        { ok: false }
      >["body"];
    };

export async function handleChatTurn(input: {
  principal: ChatPrincipal;
  actorId: string;
  actorEmail: string | undefined;
  body: ChatRequestBody;
}): Promise<ChatTurnOutcome> {
  const { principal, actorId, actorEmail } = input;

  const request = validateChatRequest(input.body);
  if (!request.ok) return failed(request);
  const { body, messages, workspaceId } = request;

  const denied = await authorizeWorkspaceAccess(principal, workspaceId);
  if (denied) return failed(denied);
  // Only enrich logging context after authorization succeeds.
  enrichContextWithWorkspace(workspaceId);

  const appChatAccess = await authorizeAppChatRequest(
    principal,
    workspaceId,
    body,
  );
  if (!appChatAccess.ok) return failed(appChatAccess);
  const { appChat } = appChatAccess;

  const canManageScheduledQueries = await resolveCanManageScheduledQueries(
    principal,
    workspaceId,
  );

  const selection = await selectChatModel(workspaceId, body.modelId);
  if (!selection.ok) {
    return { kind: "billing", status: selection.status, body: selection.body };
  }
  const modelId = selection.resolvedModelId;

  const { chatId } = body;
  if (!chatId || !ObjectId.isValid(chatId)) {
    return failed(
      stepFailure(400, "'chatId' is required and must be a valid ObjectId"),
    );
  }

  const chatDenied = await loadOrCreateChat({
    chatId,
    workspaceId,
    actorId,
    actorEmail,
    appChat,
    messages,
  });
  if (chatDenied) return failed(chatDenied);

  const workspaceContext = await loadWorkspaceTurnContext(
    workspaceId,
    body.openConsoles,
  );

  // Explicit ID > auto-detect from tab context > default to console.
  const { tabKind, flowType } = body;
  const agentId = body.agentId || detectAgentId(tabKind, flowType);
  const agentFactory = getAgentFactory(agentId);
  if (!agentFactory) {
    logger.error("Agent not found", { agentId });
    return failed(stepFailure(404, `Agent '${agentId}' not found`));
  }
  logger.info("Using agent", { agentId, tabKind, flowType });

  const abort = createTurnAbortScope();

  const guidance = await gatherTurnGuidance({
    agentId,
    workspaceId,
    actorId,
    chatId,
    lastUserText: lastUserMessageText(messages),
    messageCount: messages.length,
    openTabs: body.openTabs,
    tabKind,
  });

  // What THIS turn's apps tools write to (repo-relative `apps/<slug>`
  // roots). The sandbox is shared across every chat this user runs, so the
  // turn-end auto-commit must stage only these paths — an unscoped commit
  // sweeps a concurrent chat's in-flight work on another app.
  const appsTouchedPaths = new Set<string>();

  const agentContext: AgentContext = {
    workspaceId,
    chatId,
    appsBranch: guidance.appsBranch,
    appsTouchedPaths,
    activeView: body.activeView,
    activeExplorer: body.activeExplorer,
    userId: actorId,
    consoles: workspaceContext.consoles,
    consoleId: body.consoleId,
    notebookId: body.openTabs?.find(t => t.isActive && t.kind === "notebook")
      ?.notebookId,
    openTabs: body.openTabs,
    databases: workspaceContext.databases,
    flowFormState: body.flowFormState,
    workspaceCustomPrompt: workspaceContext.workspaceCustomPrompt,
    selfDirective: workspaceContext.selfDirective,
    consoleHints: guidance.consoleHints,
    skillsBlock: guidance.skillsBlock,
    dbtRulesBlock: guidance.dbtRulesBlock,
    activeConsoleResults: body.activeConsoleResults,
    toolExecutionContext: abort.toolExecutionContext,
    canManageScheduledQueries,
    mcpTools: guidance.mcp.tools,
    mcpReadOnlyToolNames: guidance.mcp.readOnlyToolNames,
    mcpToolNames: guidance.mcp.allToolNames,
    mcpToolCatalog: guidance.mcp.catalog,
    appChat,
  };

  // Vision capability for tool outputs (browse screenshots): resolved from
  // the catalog BEFORE tool construction so toModelOutput can gate image
  // parts for text-only models (§13.26). getModelById is memory-cached.
  agentContext.modelSupportsVision = await modelSupportsImageInput(modelId);

  const runtime = resolveChatAgentRuntime({
    agentId,
    agentFactory,
    context: agentContext,
    messages,
    tabKind,
    modelId,
    chatId,
    actorId,
    workspaceId,
  });

  const modelDef = await getModelById(modelId);
  const model = buildChatLanguageModel(modelId);
  logger.info("Using model", { model: modelId });

  const thinkingPayload = buildAnthropicThinkingConfig(
    modelDef?.thinkingMode ?? "none",
    modelDef?.thinkingBudgetTokens ?? 10000,
  );
  const providerOptions = {
    ...buildProviderOptions({
      userId: actorId,
      workspaceId,
      agentId,
      invocationType: "chat",
      // Every step of the tool loop re-sends the whole prompt; cache it so
      // each step pays full input price only for what it appended.
      promptCacheSessionId: chatId,
    }),
    ...(thinkingPayload ? { anthropic: { thinking: thinkingPayload } } : {}),
  };

  const turn: ChatTurn = {
    ...runtime,
    chatId,
    workspaceId,
    actorId,
    actorEmail,
    agentId,
    modelId,
    model,
    modelDef,
    modelSupportsVision: agentContext.modelSupportsVision,
    providerOptions,
    abort,
    appsTouchedPaths,
    screenshotVisionAttachments: body.screenshotVisionAttachments,
  };

  // Group this turn into a single Langfuse trace. sessionId=chatId links the
  // messages of a conversation together in the Sessions view; userId enables
  // per-user cost/quality analysis; tags make traces filterable by
  // agent/model/view. These attributes propagate to the AI SDK GenAI spans
  // created synchronously within this callback.
  const response = await propagateAttributes(
    {
      traceName: "agent-chat",
      sessionId: chatId,
      userId: actorEmail ?? actorId,
      tags: [
        `agent:${agentId}`,
        `model:${modelId}`,
        `view:${body.activeView ?? "unknown"}`,
      ],
      metadata: {
        workspaceId,
        chatId,
        agentId,
        modelId,
        invocationType: "chat",
      },
    },
    () => runSegment(turn, messages, 0),
  );
  return { kind: "stream", response };
}
