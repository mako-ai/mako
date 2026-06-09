/**
 * PostHog Max-style mode-switching for the unified agent.
 *
 * - Expertise modes (dynamic) are loaded via the `enable_mode` tool.
 * - The model-initiated plan gate: once the model calls `submit_plan` in the
 *   current user turn, mutations are hard-gated in `prepareStep` until the
 *   user approves the plan.
 */

export * from "./types";
export {
  modeRegistry,
  EXPERTISE_MODE_IDS,
  CORE_ALWAYS_TOOL_NAMES,
  isExpertiseModeId,
  defaultExpertiseMode,
  toolNamesForModes,
} from "./registry";
export {
  deriveModeState,
  computeActiveTools,
  buildUnifiedModeRuntime,
  type UnifiedModeRuntime,
} from "./runtime";
export {
  BASE_SYSTEM_PROMPT,
  PLAN_GATE_SYSTEM_PROMPT,
  PLAN_EXECUTION_SYSTEM_PROMPT,
  SQL_MODE_SYSTEM_PROMPT,
  DASHBOARD_MODE_SYSTEM_PROMPT,
  FLOW_MODE_SYSTEM_PROMPT,
  EXPLORE_MODE_SYSTEM_PROMPT,
} from "./prompts";
export { READ_ONLY_TOOL_NAMES } from "@mako/agent-tools";
