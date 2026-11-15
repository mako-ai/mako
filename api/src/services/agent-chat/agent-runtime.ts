/**
 * Step 5 of a chat turn: the agent's system prompt, tool working set and
 * per-step preparation.
 *
 * The unified agent uses the PostHog-style mode-switching runtime: a single
 * ALL_TOOLS union plus a `prepareStep` that recomputes the active tool
 * allowlist + cached system blocks each step from a derived mode state. This
 * is what enforces the plan hard gate (mutations blocked once the model has
 * submitted a plan, until the user approves). Other agents keep the simpler
 * static system + tools path.
 */
import type { UIMessage } from "ai";

import type { AgentConfig, AgentContext, AgentFactory } from "../../agents";
import {
  buildUnifiedModeRuntime,
  type UnifiedModeRuntime,
} from "../../agents/modes";
import { withToolFailureObservation } from "../../agent-lib/tool-failure-observation";
import { withToolQueryLabels } from "../../agent-lib/tool-query-labels";
import { withToolOutputBackstop } from "../../agent-lib/tools/shared/output-cap";
import { loggers } from "../../logging";

const logger = loggers.agent();

export interface ChatAgentRuntime {
  systemPrompt: AgentConfig["systemPrompt"];
  tools: AgentConfig["tools"];
  prepareStep: UnifiedModeRuntime["prepareStep"] | undefined;
}

export function resolveChatAgentRuntime(input: {
  agentId: string;
  agentFactory: AgentFactory;
  context: AgentContext;
  messages: UIMessage[];
  tabKind: string | undefined;
  modelId: string;
  chatId: string;
  actorId: string;
  workspaceId: string;
}): ChatAgentRuntime {
  const { agentId, agentFactory, context, messages, tabKind, modelId } = input;
  let systemPrompt: ChatAgentRuntime["systemPrompt"];
  let tools: ChatAgentRuntime["tools"];
  let prepareStep: ChatAgentRuntime["prepareStep"];

  if (agentId === "unified") {
    const runtime = buildUnifiedModeRuntime({
      context,
      messages,
      tabKind,
      modelId,
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
        chatId: input.chatId,
        modelId,
        ...runtime.workingSet,
      });
    }
  } else {
    const agentConfig = agentFactory(context);
    systemPrompt = agentConfig.systemPrompt;
    tools = agentConfig.tools;
  }

  // Backstop cap on every server-executed tool result: each result is
  // replayed on every later step and turn, so one oversized output is
  // re-billed many times. Per-tool caps sit below this; it catches the tool
  // nobody capped yet.
  tools = withToolOutputBackstop(
    withToolFailureObservation(
      withToolQueryLabels(tools, {
        mako_trigger: "chat",
        mako_chat: input.chatId,
        mako_user: input.actorId,
        mako_workspace: input.workspaceId,
      }),
    ),
  );

  return { systemPrompt, tools, prepareStep };
}
