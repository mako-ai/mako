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
} from "./console-tools";

export { clientChartTools } from "./chart-tools";
export {
  // Schemas for the server-executed chart-template reads.
  getChartTemplateSchema,
  getChartTemplatesSchema,
} from "./chart-tools";
export type { ModifyChartSpecInput } from "./chart-tools";

export { clientDashboardTools } from "./dashboard-tools";
export { clientFlowTools } from "./flow-tools";

export { clientAppTools } from "./app-tools";
export {
  // Schemas for the server-executed app mutation tools (registered with execute
  // functions in api/src/agent-lib/tools/server-app-tools.ts).
  writeFileSchema,
  deleteFileSchema,
  renameFileSchema,
  addDependencySchema,
  removeDependencySchema,
  createDataBindingSchema,
  deleteDataBindingSchema,
  saveAppVersionSchema,
  restoreAppVersionSchema,
  // Server-executed read/create/materialize tools (full-server apps).
  listAppsSchema,
  createAppSchema,
  getAppStateSchema,
  appReadFileSchema,
  materializeBindingSchema,
} from "./app-tools";
export type { AppWriteFileInput, AppCreateDataBindingInput } from "./app-tools";

export { clientDbtTools } from "./dbt-tools";
export {
  // Schemas for the server-executed dbt file tools (registered with execute
  // functions in api/src/agent-lib/tools/dbt-tools.ts).
  createDbtFileSchema,
  modifyDbtFileSchema,
  deleteDbtFileSchema,
  readDbtTreeSchema,
  readDbtFileSchema,
} from "./dbt-tools";
export type { DbtCreateFileInput, DbtModifyFileInput } from "./dbt-tools";

export { clientDataSourceTools } from "./data-source-tools";
export {
  // Schemas for the server-executed data-source tools (registered with execute
  // functions in api/src/agent-lib/tools/server-data-source-tools.ts).
  listDataSourcesSchema,
  inspectDataSourceSchema,
  queryDuckdbSchema,
} from "./data-source-tools";
export type {
  ListDataSourcesInput,
  InspectDataSourceInput,
  QueryDuckdbInput,
} from "./data-source-tools";

export { clientScreenshotTools } from "./screenshot-tools";
export type { CaptureScreenshotInput } from "./screenshot-tools";

export { clientPlanTools } from "./plan-tools";
export type {
  ClarifyingQuestion,
  AskClarifyingQuestionsInput,
  AskClarifyingQuestionsOutput,
  PlanTodo,
  SubmitPlanInput,
  SubmitPlanOutput,
  PlanDecision,
} from "./plan-tools";

export {
  READ_ONLY_TOOL_NAMES,
  PLAN_GATE_ALLOWED_TOOL_NAMES,
  isReadOnlyToolName,
} from "./read-only-tools";

export {
  applyModification,
  buildModificationDiff,
  type ConsoleModification,
} from "./console-modification";

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
};

/** Map of client tool name -> inferred input/output types. */
export type MakoUITools = InferUITools<typeof clientAgentTools>;

/** UI message type with the client tool surface threaded through. */
export type MakoUIMessage = UIMessage<unknown, UIDataTypes, MakoUITools>;
