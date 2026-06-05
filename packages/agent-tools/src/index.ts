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
import { clientScreenshotTools } from "./screenshot-tools";

export { clientConsoleTools } from "./console-tools";
export type {
  ModifyConsoleInput,
  ReadConsoleInput,
  CreateConsoleInput,
  ListOpenConsolesInput,
  SetConsoleConnectionInput,
  OpenConsoleInput,
  RunConsoleInput,
} from "./console-tools";

export { clientChartTools } from "./chart-tools";
export type { ModifyChartSpecInput } from "./chart-tools";

export { clientDashboardTools } from "./dashboard-tools";
export { clientFlowTools } from "./flow-tools";

export { clientScreenshotTools } from "./screenshot-tools";
export type { CaptureScreenshotInput } from "./screenshot-tools";

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
};

/** Map of client tool name -> inferred input/output types. */
export type MakoUITools = InferUITools<typeof clientAgentTools>;

/** UI message type with the client tool surface threaded through. */
export type MakoUIMessage = UIMessage<unknown, UIDataTypes, MakoUITools>;
