/**
 * PostHog Max-style mode-switching for the unified agent.
 *
 * - Expertise modes (dynamic) are loaded via the `enable_mode` tool.
 * - The `plan` lifecycle adds a clarify -> plan -> approve -> execute state
 *   machine with a hard mutation gate enforced in `prepareStep`.
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
  PLAN_MODE_SYSTEM_PROMPT,
  PLAN_EXECUTION_SYSTEM_PROMPT,
  SQL_MODE_SYSTEM_PROMPT,
  DASHBOARD_MODE_SYSTEM_PROMPT,
  FLOW_MODE_SYSTEM_PROMPT,
  EXPLORE_MODE_SYSTEM_PROMPT,
} from "./prompts";
export { READ_ONLY_TOOL_NAMES } from "@mako/agent-tools";
