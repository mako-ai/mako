/**
 * Server-side chart-template read tools (issue #475 pattern).
 *
 * `get_chart_templates` / `get_chart_template` are pure static lookups against
 * the `@mako/schemas` template registry — no browser, no workspace state — so
 * they execute on the API. This lets the agent discover/read chart templates
 * with no attached browser. Schemas live in @mako/agent-tools (shared with the
 * app's tool cards).
 */
import { tool } from "ai";
import {
  getChartTemplateSchema,
  getChartTemplatesSchema,
} from "@mako/agent-tools";
import { getAllTemplates, getTemplate } from "@mako/schemas";

export function createServerChartTools() {
  return {
    get_chart_templates: tool({
      description:
        "List available best-practice chart templates with IDs and descriptions. " +
        "Call before creating charts to discover proven simple patterns " +
        "(e.g. multi-series line with hover rule, donut, stacked bar).",
      inputSchema: getChartTemplatesSchema,
      execute: async () => ({ success: true, templates: getAllTemplates() }),
    }),

    get_chart_template: tool({
      description:
        "Get a best-practice chart template with full vegaLiteSpec, SQL pattern, and implementation notes. " +
        "Use for complex patterns (e.g. multi-series hover rule, stacked bar, donut) instead of inventing specs from scratch. " +
        "Available IDs: multi-series-line-hover, time-series-area, grouped-bar, stacked-bar, horizontal-ranking, donut, kpi-sparkline.",
      inputSchema: getChartTemplateSchema,
      execute: async ({ templateId }) => {
        const template = getTemplate(templateId);
        if (!template) {
          return {
            success: false,
            error: `No chart template with id "${templateId}".`,
          };
        }
        return { success: true, template };
      },
    }),
  };
}
