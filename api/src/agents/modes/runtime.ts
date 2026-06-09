/**
 * Unified-agent mode runtime.
 *
 * Wires the expertise-mode registry + plan lifecycle into a single `streamText`
 * loop via `prepareStep`: every step recomputes the active tool allowlist and
 * the (cached + dynamic) system blocks from a derived, then live-mutated,
 * `ModeState`.
 */

import type { SystemModelMessage, ToolSet, UIMessage } from "ai";
import { clientPlanTools, READ_ONLY_TOOL_NAMES } from "@mako/agent-tools";
import type { AgentContext } from "../types";
import { unifiedAgentFactory } from "../unified";
import { buildCurrentScreenContext } from "../unified/prompt";
import { createModeTools } from "../../agent-lib/tools/mode-tools";
import {
  modeRegistry,
  defaultExpertiseMode,
  toolNamesForModes,
  isExpertiseModeId,
} from "./registry";
import { BASE_SYSTEM_PROMPT, PLAN_MODE_SYSTEM_PROMPT } from "./prompts";
import type { ExpertiseModeId, LifecycleMode, ModeState } from "./types";

/** Tools only exposed while the chat is in the plan lifecycle. */
const PLAN_ONLY_TOOL_NAMES = new Set<string>(["submit_plan"]);

type UIMessagePart = {
  type?: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
};

function partToolName(part: UIMessagePart): string | undefined {
  if (typeof part.type !== "string") return undefined;
  if (part.type === "dynamic-tool") return part.toolName;
  if (part.type.startsWith("tool-")) return part.type.slice("tool-".length);
  return undefined;
}

/**
 * Statelessly derive the mode state from the full message history + the chat's
 * lifecycle mode. Consistent with the "full context" model: enabled expertise
 * modes are reconstructed from prior `enable_mode` calls, and plan approval
 * from the latest `submit_plan` decision.
 */
export function deriveModeState(
  messages: UIMessage[],
  chatMode: LifecycleMode,
  defaultMode: ExpertiseModeId,
): ModeState {
  const enabledModes = new Set<ExpertiseModeId>([defaultMode]);
  let planApproved = false;

  for (const message of messages) {
    const parts = (message.parts ?? []) as UIMessagePart[];
    for (const part of parts) {
      const toolName = partToolName(part);
      if (!toolName) continue;

      if (toolName === "enable_mode") {
        const mode = (part.input as { mode?: unknown } | undefined)?.mode;
        if (isExpertiseModeId(mode)) enabledModes.add(mode);
      } else if (toolName === "submit_plan") {
        const decision = (part.output as { decision?: unknown } | undefined)
          ?.decision;
        // The latest decision wins; only an explicit approval unlocks writes.
        if (decision === "approve") planApproved = true;
        else if (decision === "request_changes" || decision === "cancel") {
          planApproved = false;
        }
      }
    }
  }

  return { enabledModes, planApproved, lifecycle: chatMode };
}

function buildModeSystem(
  context: AgentContext,
  modeState: ModeState,
): SystemModelMessage[] {
  const dynamicParts: string[] = [];

  for (const modeId of modeState.enabledModes) {
    const mode = modeRegistry[modeId];
    if (mode?.systemPrompt) dynamicParts.push(mode.systemPrompt);
  }

  const planGated = modeState.lifecycle === "plan" && !modeState.planApproved;
  if (planGated) dynamicParts.push(PLAN_MODE_SYSTEM_PROMPT);

  dynamicParts.push(buildCurrentScreenContext(context));

  return [
    {
      role: "system",
      content: BASE_SYSTEM_PROMPT,
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
      },
    },
    {
      role: "system",
      content: dynamicParts.join("\n\n---\n\n"),
    },
  ];
}

/**
 * Compute the active tool allowlist for the current step from the live
 * `ModeState`. Implements the plan-mode hard gate.
 */
export function computeActiveTools(
  modeState: ModeState,
  allToolNames: Set<string>,
): string[] {
  let names = new Set<string>();
  for (const name of toolNamesForModes(modeState.enabledModes)) {
    if (allToolNames.has(name)) names.add(name);
  }

  // submit_plan only exists in the plan lifecycle.
  if (modeState.lifecycle !== "plan") {
    for (const planOnly of PLAN_ONLY_TOOL_NAMES) names.delete(planOnly);
  }

  // Plan-mode hard gate: before approval, intersect with read-only tools and
  // add back the lifecycle tools needed to clarify, plan, and switch modes.
  if (modeState.lifecycle === "plan" && !modeState.planApproved) {
    const gated = new Set<string>();
    for (const name of names) {
      if (READ_ONLY_TOOL_NAMES.has(name)) gated.add(name);
    }
    for (const allowed of [
      "enable_mode",
      "todo_write",
      "ask_clarifying_questions",
      "submit_plan",
    ]) {
      if (allToolNames.has(allowed)) gated.add(allowed);
    }
    names = gated;
  }

  return Array.from(names);
}

export interface UnifiedModeRuntime {
  tools: ToolSet;
  modeState: ModeState;
  system: SystemModelMessage[];
  prepareStep: (options: {
    stepNumber: number;
  }) => { activeTools: string[]; system: SystemModelMessage[] } | undefined;
}

/**
 * Build the full tool union, derived mode state, initial system, and the
 * per-step `prepareStep` for the unified agent.
 */
export function buildUnifiedModeRuntime(params: {
  context: AgentContext;
  messages: UIMessage[];
  chatMode: LifecycleMode;
  tabKind?: string;
}): UnifiedModeRuntime {
  const { context, messages, chatMode, tabKind } = params;

  const defaultMode = defaultExpertiseMode(context, tabKind);
  const modeState = deriveModeState(messages, chatMode, defaultMode);

  // Reuse the unified agent factory for the domain tool objects, then add the
  // core lifecycle tools (server `enable_mode`/`todo_write` + the deferred
  // client plan tools).
  const { tools: domainTools } = unifiedAgentFactory(context);
  const modeTools = createModeTools(modeState);

  const tools: ToolSet = {
    ...domainTools,
    ...clientPlanTools,
    ...modeTools,
  } as ToolSet;

  const allToolNames = new Set<string>(Object.keys(tools));

  const prepareStep = () => ({
    activeTools: computeActiveTools(modeState, allToolNames),
    system: buildModeSystem(context, modeState),
  });

  return {
    tools,
    modeState,
    system: buildModeSystem(context, modeState),
    prepareStep,
  };
}
