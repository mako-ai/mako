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

import { tool } from "ai";
import { z } from "zod";

export const modifyChartSpecSchema = z.object({
  // A loose record instead of the full ~98 KB Vega-Lite JSON Schema: the model
  // already knows Vega-Lite, so we describe only the Mako-specific constraints
  // and rely on the client-side `MakoChartSpec` schema (app/src/lib/chart-spec.ts)
  // to validate and feed errors back for self-correction.
  vegaLiteSpec: z
    .record(z.string(), z.unknown())
    .describe(
      "A Vega-Lite spec object (the model already knows Vega-Lite). " +
        "Do NOT include a `data` property — data is injected from the query results at render time. " +
        "Marks: bar | line | area | point | arc | boxplot | rect | rule | text | tick | trail. " +
        "Use a `fold` transform to unpivot multiple numeric columns into one series for multi-line charts. " +
        "For complex patterns (multi-series hover, donut, stacked bar) call get_chart_template first. " +
        "Invalid specs are reported back with the exact validation error so you can fix and retry.",
    ),
  reasoning: z
    .string()
    .describe("Brief explanation of the chart choice and why it fits the data"),
});

export type ModifyChartSpecInput = z.infer<typeof modifyChartSpecSchema>;

// Chart-template reads are pure static lookups (`@mako/schemas`) and execute
// SERVER-SIDE — see api/src/agent-lib/tools/server-chart-tools.ts.
export const getChartTemplateSchema = z.object({
  templateId: z
    .string()
    .describe("Template ID (e.g. 'multi-series-line-hover', 'donut')"),
});

export const getChartTemplatesSchema = z.object({});

export const clientChartTools = {
  modify_chart_spec: tool({
    description:
      "Modify the chart visualization for the current query results. " +
      "Produces a Vega-Lite spec that will be rendered in the chart view of the results panel. " +
      "Only call this when the user has query results and asks for a visualization or chart. " +
      "The spec should NOT include a data property — data is injected automatically from the query results. " +
      "Available mark types: bar, line, area, point, arc, boxplot, rect, rule, text, tick, trail. " +
      "Use fold transforms to unpivot multiple numeric columns into a single series for multi-line charts.",
    inputSchema: modifyChartSpecSchema,
  }),
  get_chart_template: tool({
    description:
      "Get a best-practice chart template with full vegaLiteSpec, SQL pattern, and implementation notes. " +
      "Use for complex patterns (e.g. multi-series hover rule, stacked bar, donut) instead of inventing specs from scratch. " +
      "Available IDs: multi-series-line-hover, time-series-area, grouped-bar, stacked-bar, horizontal-ranking, donut, kpi-sparkline.",
    inputSchema: getChartTemplateSchema,
  }),
};
