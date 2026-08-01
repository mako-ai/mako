/**
 * @mako/agent-tools
 *
 * Single source of truth for the agent's **client-side** tool definitions —
 * the tools that have no `execute` function and are run in the browser via the
 * AI SDK `onToolCall` handler. Both the API (which registers them on the agents)
 * and the app (which executes them and derives typed `onToolCall` input via
 * `InferUITools`) import from here, so the tool surface can never drift.
 *
 * Server-side tools (database access, search, etc.) stay in the API package
 * because they depend on API-only services.
 */

import type { InferUITools, UIDataTypes, UIMessage } from "ai";

import { clientConsoleTools } from "./console-tools";
import { clientChartTools } from "./chart-tools";
import { clientDashboardTools } from "./dashboard-tools";
import { clientFlowTools } from "./flow-tools";
import { clientAppTools } from "./app-tools";
import { clientDbtTools } from "./dbt-tools";
import { clientDataSourceTools } from "./data-source-tools";
import { clientScreenshotTools } from "./screenshot-tools";
import { clientPlanTools } from "./plan-tools";
import { clientNotebookTools } from "./notebook-tools";

export { clientConsoleTools } from "./console-tools";
export {
  // Schemas for the server-executed console tools (registered with execute
  // functions in api/src/agent-lib/tools/server-console-tools.ts).
  modifyConsoleSchema,
  readConsoleSchema,
  createConsoleSchema,
  listOpenConsolesSchema,
  setConsoleConnectionSchema,
  openConsoleSchema,
  runConsoleSchema,
  checkQueryStatusSchema,
  cancelQueryStatusSchema,
  listConsoleExecutionsSchema,
} from "./console-tools";
export type {
  ModifyConsoleInput,
  ReadConsoleInput,
  CreateConsoleInput,
  ListOpenConsolesInput,
  SetConsoleConnectionInput,
  OpenConsoleInput,
  RunConsoleInput,
  CheckQueryStatusInput,
  CancelQueryStatusInput,
  ListConsoleExecutionsInput,
} from "./console-tools";

export { clientChartTools } from "./chart-tools";
export type { ModifyChartSpecInput } from "./chart-tools";

export { clientDashboardTools } from "./dashboard-tools";
export { clientFlowTools } from "./flow-tools";

export { clientAppTools } from "./app-tools";
export {
  // Schemas for the server-executed app mutation tools (registered with execute
  // functions in api/src/agent-lib/tools/server-app-tools.ts).
  writeFileSchema,
  editFileSchema,
  deleteFileSchema,
  renameFileSchema,
  addDependencySchema,
  removeDependencySchema,
  createDataBindingSchema,
  updateDataBindingSchema,
  deleteDataBindingSchema,
  saveAppVersionSchema,
  restoreAppVersionSchema,
  // Server-executed read/create/materialize tools (full-server apps).
  listAppsSchema,
  createAppSchema,
  getAppStateSchema,
  appReadFileSchema,
  appReadResourceSchema,
  appSearchSchema,
  materializeBindingSchema,
  setBindingScheduleSchema,
  setBindingMaterializationSchema,
  bindingMaterializationScheduleSchema,
  APP_STATE_CODE_PREVIEW_CHARS,
  APP_READ_FILE_MAX_CHARS,
  APP_INSPECT_CODE_PREVIEW_CHARS,
  APP_PREVIEW_ERROR_MAX,
  APP_PREVIEW_ERROR_CHARS,
  APP_SAMPLE_CELL_MAX_CHARS,
  APP_RESOURCE_MAX_LINES,
  APP_RESOURCE_MAX_CHARS,
  APP_SEARCH_MAX_OUTPUT_CHARS,
  APP_SEARCH_SNIPPET_MAX_CHARS,
  appResourceRef,
  parseAppResourceRef,
  appResourceVersion,
  appVersionedResourceVersion,
  appBindingResourceVersion,
  readAppResourceRange,
  searchAppResources,
  clipAgentText,
  summarizeAppBindingForState,
  summarizePreviewErrors,
} from "./app-tools";
export type {
  AppResourceKind,
  AppSearchableResource,
  AppWriteFileInput,
  AppEditFileInput,
  AppCreateDataBindingInput,
  AppUpdateDataBindingInput,
} from "./app-tools";

export { clientDbtTools } from "./dbt-tools";
export {
  // Schemas for the server-executed dbt file tools (registered with execute
  // functions in api/src/agent-lib/tools/dbt-tools.ts).
  createDbtFileSchema,
  modifyDbtFileSchema,
  editDbtFileSchema,
  deleteDbtFileSchema,
  readDbtTreeSchema,
  readDbtFileSchema,
} from "./dbt-tools";
export type {
  DbtCreateFileInput,
  DbtModifyFileInput,
  DbtEditFileInput,
} from "./dbt-tools";

export { clientDataSourceTools } from "./data-source-tools";

export {
  clientNotebookTools,
  editNotebookCellSchema,
  notebookCellResourceVersion,
  readNotebookCellRange,
  readNotebookCellSchema,
  readNotebookSchema,
  searchNotebookCells,
  searchNotebookSchema,
  summarizeNotebookCell,
  NOTEBOOK_CELL_PAGE_LIMIT,
  NOTEBOOK_SOURCE_PREVIEW_CHARS,
} from "./notebook-tools";

export {
  runAppBaseSchema,
  clampRunAppTimeoutMs,
  summarizeRunAppResult,
  runAppResultToMcpContent,
  isRunAppResult,
  RUN_APP_DEFAULT_TIMEOUT_MS,
  RUN_APP_MIN_TIMEOUT_MS,
  RUN_APP_MAX_TIMEOUT_MS,
} from "./run-app";
export type {
  RunAppBaseInput,
  RunAppResult,
  RunAppScreenshot,
  RunAppSource,
  RunAppMcpContent,
} from "./run-app";

export { clientScreenshotTools } from "./screenshot-tools";
export type { CaptureScreenshotInput } from "./screenshot-tools";

export {
  clientPlanTools,
  HITL_TOOL_JSON_SCHEMAS,
  validateHitlToolArguments,
} from "./plan-tools";
export type {
  ClarifyingQuestion,
  AskClarifyingQuestionsInput,
  AskClarifyingQuestionsOutput,
  PlanTodo,
  SubmitPlanInput,
  SubmitPlanOutput,
  PlanDecision,
  HitlToolName,
} from "./plan-tools";

export {
  READ_ONLY_TOOL_NAMES,
  PLAN_GATE_ALLOWED_TOOL_NAMES,
  isReadOnlyToolName,
} from "./read-only-tools";

export {
  CAPABILITY_GRANTS,
  type AgentCapabilityDefinition,
  type AgentSurface,
  type CapabilityGrant,
  type CapabilityMcpExclusionWhy,
  type CapabilityResultKind,
  type CapabilityRisk,
} from "./capabilities/types";

export {
  DBT_CAPABILITIES,
  DBT_CAPABILITY_BY_NAME,
  DBT_CAPABILITY_NAMES,
  dbtCapabilitiesForPack,
  dbtCapabilitiesForSurface,
  type DbtCapabilityDefinition,
  type DbtCapabilityPack,
} from "./capabilities/dbt-capabilities";

export {
  APP_CAPABILITIES,
  type AppCapabilityDefinition,
  type AppCapabilityPack,
} from "./capabilities/app-capabilities";

export {
  CONSOLE_CAPABILITIES,
  type ConsoleCapabilityDefinition,
  type ConsoleCapabilityPack,
} from "./capabilities/console-capabilities";

export {
  QUERY_CAPABILITIES,
  type QueryCapabilityDefinition,
  type QueryCapabilityPack,
} from "./capabilities/query-capabilities";

export {
  NOTEBOOK_CAPABILITIES,
  type NotebookCapabilityDefinition,
  type NotebookCapabilityPack,
} from "./capabilities/notebook-capabilities";

export {
  AGENT_CAPABILITIES,
  AGENT_CAPABILITY_BY_NAME,
  agentCapabilitiesForSurface,
} from "./capabilities/registry";

export {
  applyModification,
  buildModificationDiff,
  type ConsoleModification,
} from "./console-modification";

export {
  applyStrReplace,
  buildStrReplaceDiff,
  type StrReplaceResult,
  type StrReplaceSuccess,
  type StrReplaceFailure,
} from "./str-replace";

export {
  MakoChartSpecBase,
  MakoChartSpec,
  type MakoChartSpec as MakoChartSpecType,
} from "./chart-spec-schema";

/**
 * The complete set of client-side agent tools, across every agent surface
 * (console, chart, dashboard, flow). Used to derive the typed UI message /
 * tool-call types below.
 */
export const clientAgentTools = {
  ...clientConsoleTools,
  ...clientChartTools,
  ...clientDashboardTools,
  ...clientFlowTools,
  ...clientAppTools,
  ...clientDbtTools,
  ...clientDataSourceTools,
  ...clientPlanTools,
  ...clientNotebookTools,
};

/** Map of client tool name -> inferred input/output types. */
export type MakoUITools = InferUITools<typeof clientAgentTools>;

/** UI message type with the client tool surface threaded through. */
export type MakoUIMessage = UIMessage<unknown, UIDataTypes, MakoUITools>;
