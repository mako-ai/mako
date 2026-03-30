/**
 * Client-Side Chart Tools
 *
 * These tools are executed on the client-side via the AI SDK's onToolCall callback.
 * They do NOT have execute functions, which signals to the AI SDK that they
 * should be handled client-side.
 *
 * The client will:
 * 1. Receive the tool call with a MakoChartSpec
 * 2. Validate the spec with Zod
 * 3. Set the chart spec on the active console tab
 * 4. Switch the results view to chart mode
 * 5. Call addToolOutput to provide the result
 */

import { z } from "zod";
import { MakoChartSpecBase } from "./chart-spec-schema";

export const modifyChartSpecSchema = z.object({
  vegaLiteSpec: MakoChartSpecBase.describe("Vega-Lite chart specification"),
  reasoning: z
    .string()
    .describe("Brief explanation of the chart choice and why it fits the data"),
});

export type ModifyChartSpecInput = z.infer<typeof modifyChartSpecSchema>;

export const clientChartTools = {
  modify_chart_spec: {
    description:
      "Modify the chart visualization for the current query results. " +
      "Produces a Vega-Lite spec that will be rendered in the chart view of the results panel. " +
      "Only call this when the user has query results and asks for a visualization or chart. " +
      "The spec should NOT include a data property — data is injected automatically from the query results. " +
      "Available mark types: bar, line, area, point, arc, boxplot, rect, rule, text, tick, trail. " +
      "Use fold transforms to unpivot multiple numeric columns into a single series for multi-line charts.",
    inputSchema: modifyChartSpecSchema,
  },
  get_chart_template: {
    description:
      "Get a best-practice chart template with full vegaLiteSpec, SQL pattern, and implementation notes. " +
      "Use for complex patterns (e.g. multi-series hover rule, stacked bar, donut) instead of inventing specs from scratch. " +
      "Available IDs: multi-series-line-hover, time-series-area, grouped-bar, stacked-bar, horizontal-ranking, donut, kpi-sparkline.",
    inputSchema: z.object({
      templateId: z
        .string()
        .describe("Template ID (e.g. 'multi-series-line-hover', 'donut')"),
    }),
  },
};
