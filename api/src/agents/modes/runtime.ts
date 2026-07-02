/**
 * Unified-agent mode runtime.
 *
 * Wires the expertise-mode registry + the model-initiated plan gate into a
 * single `streamText` loop via `prepareStep`: every step recomputes the active
 * tool allowlist and the (cached + dynamic) system blocks from a derived, then
 * live-mutated, `ModeState`.
 *
 * There is no user-facing plan/agent toggle. The model decides when planning
 * makes sense; once it calls `submit_plan` in the current user turn, mutating
 * tools are hard-gated until the user approves.
 */

import type { SystemModelMessage, ToolSet, UIMessage } from "ai";
import {
  clientPlanTools,
  READ_ONLY_TOOL_NAMES,
  PLAN_GATE_ALLOWED_TOOL_NAMES,
} from "@mako/agent-tools";
import type { AgentContext } from "../types";
import { unifiedAgentFactory } from "../unified";
import { buildCurrentScreenContext } from "../unified/prompt";
import { createModeTools } from "../../agent-lib/tools/mode-tools";
import {
  modeRegistry,
  defaultExpertiseMode,
  toolNamesForModes,
  resolveExpertiseModeId,
} from "./registry";
import {
  BASE_SYSTEM_PROMPT,
  PLAN_GATE_SYSTEM_PROMPT,
  PLAN_EXECUTION_SYSTEM_PROMPT,
} from "./prompts";
import type { ExpertiseModeId, ModeState } from "./types";

/** The plan gate is engaged: a plan was submitted this turn but not approved. */
function isPlanGateActive(modeState: ModeState): boolean {
  return modeState.planSubmitted && !modeState.planApproved;
}

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
 * Statelessly derive the mode state from the full message history. Consistent
 * with the "full context" model: enabled expertise modes are reconstructed
 * from prior `enable_mode` calls, and the plan gate from `submit_plan` calls
 * in the current user turn (latest decision wins).
 */
export function deriveModeState(
  messages: UIMessage[],
  defaultMode: ExpertiseModeId,
): ModeState {
  const enabledModes = new Set<ExpertiseModeId>([defaultMode]);
  let planSubmitted = false;
  let planApproved = false;
  let lastPlanDecision: unknown;

  for (const message of messages) {
    // A new user turn normally starts a fresh plan cycle: any previous
    // submission or approval is stale for the new request. Exception
    // (conversational plan iteration, Cursor-style): when the latest plan was
    // resolved with request_changes, the following user message IS the
    // feedback — the gate stays engaged so the model revises and re-submits
    // instead of mutating. Enabled expertise modes are intentionally NOT
    // reset (they accumulate across the conversation).
    if (message.role === "user") {
      const isPlanIterationFeedback =
        planSubmitted && !planApproved && lastPlanDecision === "request_changes";
      if (!isPlanIterationFeedback) {
        planSubmitted = false;
      }
      planApproved = false;
    }

    const parts = (message.parts ?? []) as UIMessagePart[];
    for (const part of parts) {
      const toolName = partToolName(part);
      if (!toolName) continue;

      if (toolName === "enable_mode") {
        const mode = (part.input as { mode?: unknown } | undefined)?.mode;
        const resolved = resolveExpertiseModeId(mode);
        if (resolved) enabledModes.add(resolved);
      } else if (toolName === "submit_plan") {
        planSubmitted = true;
        const decision = (part.output as { decision?: unknown } | undefined)
          ?.decision;
        lastPlanDecision = decision;
        // The latest decision in this turn wins; only an explicit approval
        // unlocks writes. A pending submission (no output yet) stays gated.
        planApproved = decision === "approve";
      }
    }
  }

  return { enabledModes, planSubmitted, planApproved };
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

  if (modeState.planSubmitted) {
    dynamicParts.push(
      modeState.planApproved
        ? PLAN_EXECUTION_SYSTEM_PROMPT
        : PLAN_GATE_SYSTEM_PROMPT,
    );
  }

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
 * `ModeState`. Implements the plan hard gate: once the model has submitted a
 * plan this turn and the user has not approved it, only read-only tools and
 * the lifecycle tools (clarify / re-plan / switch modes / todos) remain.
 */
export function computeActiveTools(
  modeState: ModeState,
  allToolNames: Set<string>,
): string[] {
  let names = new Set<string>();
  for (const name of toolNamesForModes(modeState.enabledModes)) {
    if (allToolNames.has(name)) names.add(name);
  }

  if (isPlanGateActive(modeState)) {
    const gated = new Set<string>();
    for (const name of names) {
      if (READ_ONLY_TOOL_NAMES.has(name)) gated.add(name);
    }
    for (const allowed of PLAN_GATE_ALLOWED_TOOL_NAMES) {
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
  tabKind?: string;
}): UnifiedModeRuntime {
  const { context, messages, tabKind } = params;

  const defaultMode = defaultExpertiseMode(context, tabKind);
  const modeState = deriveModeState(messages, defaultMode);

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
