/**
 * Chart Template Registry
 *
 * Named best-practice chart patterns that the AI agent can look up on demand
 * via `get_chart_templates` / `get_chart_template` tools. Each template
 * provides a full working vegaLiteSpec, an example SQL pattern, and notes
 * about constraints and gotchas.
 *
 * Used by both the dashboard agent (via agent-tools.ts) and the console
 * agent (via Chat.tsx onToolCall).
 */

export interface ChartTemplate {
  id: string;
  name: string;
  description: string;
  sqlPattern: string;
  vegaLiteSpec: Record<string, unknown>;
  notes: string[];
}

const templates: ChartTemplate[] = [
  {
    id: "multi-series-line-hover",
    name: "Multi-Series Line with Hover Rule",
    description:
      "Multi-series line chart with a vertical hover rule that snaps to the nearest x-date and shows all series values in one tooltip. Best for comparing trends across categories over time.",
    sqlPattern: [
      "SELECT {{date_col}} AS day, {{category_col}} AS category, {{value_col}} AS value",
      "FROM {{table}}",
      "ORDER BY day, category",
    ].join("\n"),
    vegaLiteSpec: {
      layer: [
        {
          mark: { type: "line", strokeWidth: 2 },
          encoding: {
            x: { field: "day", type: "temporal", title: "Date" },
            y: {
              field: "value",
              type: "quantitative",
              title: "Value",
            },
            color: {
              field: "category",
              type: "nominal",
              title: "Category",
            },
          },
        },
        {
          params: [
            {
              name: "__mako_tooltip",
              select: {
                type: "point",
                fields: ["day"],
                nearest: true,
                on: "pointerover",
                clear: "pointerout",
              },
            },
          ],
          transform: [{ pivot: "category", value: "value", groupby: ["day"] }],
          mark: { type: "rule", color: "#888", strokeWidth: 1 },
          encoding: {
            x: { field: "day", type: "temporal" },
            opacity: {
              value: 0,
              condition: {
                param: "__mako_tooltip",
                empty: false,
                value: 0.5,
              },
            },
            tooltip: [
              { field: "day", type: "temporal", title: "Date" },
              {
                field: "{{series_1}}",
                type: "quantitative",
              },
              {
                field: "{{series_2}}",
                type: "quantitative",
              },
            ],
          },
        },
      ],
    },
    notes: [
      "Replace {{series_1}}, {{series_2}}, etc. in the tooltip with the actual unique values of the category column.",
      "The pivot transform converts long-format data (one row per series per date) to wide-format (one row per date, one column per series) — needed so the tooltip can show all series at once.",
      "Use param name '__mako_tooltip' or another unique name starting with '__mako_' to avoid collision with the dashboard cross-filter params ('brush', 'crossfilter').",
      "Alternative to Vega pivot: pivot in SQL using MAX(value) FILTER (WHERE category = '...') OVER (PARTITION BY day) AS \"Series Name\", then reference the pivoted columns directly in tooltip.",
      "For dashboard widgets, this layered spec disables the temporal brush cross-filter (because encoding.x is per-layer, not top-level). This is an acceptable trade-off.",
      "Colored SVG dots and a Total row are auto-injected at render time by the custom tooltip handler. Do NOT add emoji circles or manual total fields — the renderer handles it.",
      "Do NOT set format on series tooltip fields (e.g. '.2f'). The custom handler formats numbers with locale-aware separators and smart decimal places.",
    ],
  },
  {
    id: "time-series-area",
    name: "Time Series Area Chart",
    description:
      "Single or multi-series area chart for showing volume/magnitude over time. Optional line overlay for clarity.",
    sqlPattern: [
      "SELECT {{date_col}} AS period, {{value_col}} AS value",
      "FROM {{table}}",
      "GROUP BY 1 ORDER BY 1",
    ].join("\n"),
    vegaLiteSpec: {
      mark: { type: "area", line: true, opacity: 0.3, tooltip: true },
      encoding: {
        x: {
          field: "period",
          type: "temporal",
          title: "Period",
        },
        y: {
          field: "value",
          type: "quantitative",
          title: "Value",
        },
        tooltip: [
          { field: "period", type: "temporal" },
          { field: "value", type: "quantitative" },
        ],
      },
    },
    notes: [
      "For multi-series, add color: { field: 'category', type: 'nominal' } and include the category column in the SQL.",
      "Set opacity on the mark (0.2-0.4) so overlapping areas remain visible.",
      "Use line: true on the mark to draw a solid line on top of the shaded area.",
      "For stacked area, add stack: 'zero' to the y encoding.",
    ],
  },
  {
    id: "grouped-bar",
    name: "Grouped Bar Chart",
    description:
      "Side-by-side bars comparing categories within groups. Good for comparing values across two categorical dimensions.",
    sqlPattern: [
      "SELECT {{group_col}} AS group_name, {{category_col}} AS category, {{value_col}} AS value",
      "FROM {{table}}",
      "GROUP BY 1, 2 ORDER BY 1",
    ].join("\n"),
    vegaLiteSpec: {
      mark: { type: "bar", tooltip: true },
      encoding: {
        x: { field: "group_name", type: "nominal", title: "Group" },
        y: {
          field: "value",
          type: "quantitative",
          title: "Value",
        },
        color: { field: "category", type: "nominal", title: "Category" },
        xOffset: { field: "category", type: "nominal" },
        tooltip: [
          { field: "group_name", type: "nominal" },
          { field: "category", type: "nominal" },
          { field: "value", type: "quantitative" },
        ],
      },
    },
    notes: [
      "xOffset creates side-by-side bars within each group. Without it, bars stack.",
      "For temporal groups (months, weeks), use type: 'temporal' on x with timeUnit.",
      "Keep the number of categories reasonable (2-6) or the bars become too narrow.",
    ],
  },
  {
    id: "stacked-bar",
    name: "Stacked Bar Chart",
    description:
      "Stacked bars showing part-to-whole composition. Use 'normalize' stack for percentage view.",
    sqlPattern: [
      "SELECT {{x_col}} AS x_val, {{category_col}} AS category, {{value_col}} AS value",
      "FROM {{table}}",
      "GROUP BY 1, 2 ORDER BY 1",
    ].join("\n"),
    vegaLiteSpec: {
      mark: { type: "bar", tooltip: true },
      encoding: {
        x: { field: "x_val", type: "nominal", title: "Category" },
        y: {
          field: "value",
          type: "quantitative",
          title: "Value",
          stack: "zero",
        },
        color: { field: "category", type: "nominal", title: "Segment" },
        tooltip: [
          { field: "x_val", type: "nominal" },
          { field: "category", type: "nominal" },
          { field: "value", type: "quantitative" },
        ],
      },
    },
    notes: [
      "stack: 'zero' is the default stacking mode (absolute values).",
      "Use stack: 'normalize' for 100% stacked bars (percentage composition).",
      "For temporal x-axis, use type: 'temporal' with appropriate timeUnit.",
      "Order matters — the SQL ORDER BY affects the stacking order.",
    ],
  },
  {
    id: "horizontal-ranking",
    name: "Horizontal Ranking Bar",
    description:
      "Horizontal bar chart sorted by value, ideal for rankings, top-N lists, and funnel analysis.",
    sqlPattern: [
      "SELECT {{category_col}} AS category, {{agg}}({{value_col}}) AS value",
      "FROM {{table}}",
      "GROUP BY 1",
      "ORDER BY value DESC",
    ].join("\n"),
    vegaLiteSpec: {
      mark: { type: "bar", cornerRadiusEnd: 4, tooltip: true },
      encoding: {
        x: { field: "value", type: "quantitative", title: "Value" },
        y: {
          field: "category",
          type: "nominal",
          sort: { field: "value", op: "sum", order: "descending" },
          axis: { title: "" },
        },
        color: { field: "category", type: "nominal", legend: null },
        tooltip: [
          { field: "category", type: "nominal" },
          { field: "value", type: "quantitative" },
        ],
      },
    },
    notes: [
      "Sort by value descending via the sort object on the y encoding to get a proper ranking.",
      "Hide the legend (legend: null on color) since the y-axis labels already identify each bar.",
      "cornerRadiusEnd adds a rounded right edge for polish.",
      "Use LIMIT in SQL to show only the top-N items.",
    ],
  },
  {
    id: "donut",
    name: "Donut Chart",
    description:
      "Arc chart with inner radius for part-to-whole comparisons. Best for small numbers of categories (2-8).",
    sqlPattern: [
      "SELECT {{category_col}} AS category, {{agg}}({{value_col}}) AS value",
      "FROM {{table}}",
      "GROUP BY 1",
    ].join("\n"),
    vegaLiteSpec: {
      mark: { type: "arc", innerRadius: 50, tooltip: true },
      encoding: {
        theta: { field: "value", type: "quantitative" },
        color: { field: "category", type: "nominal", title: "Category" },
        tooltip: [
          { field: "category", type: "nominal" },
          { field: "value", type: "quantitative" },
        ],
      },
    },
    notes: [
      "innerRadius: 50 creates the donut hole. Set to 0 for a full pie chart.",
      "Keep categories under 8 for readability. Aggregate smaller values into 'Other' in SQL.",
      "For percentage labels, add a calculate transform: { calculate: 'datum.value / sum(datum.value)', as: 'pct' } and use text encoding.",
      "In dashboard cross-filter mode, clicking a slice filters other widgets by that category.",
    ],
  },
  {
    id: "kpi-sparkline",
    name: "KPI with Sparkline",
    description:
      "Two-layer chart combining a large KPI text value with a small trend sparkline. Use for dashboard headline metrics.",
    sqlPattern: [
      "-- Two queries needed:",
      "-- KPI widget: SELECT {{agg}}({{value_col}}) AS value FROM {{table}}",
      "-- Sparkline: SELECT {{date_col}} AS period, {{agg}}({{value_col}}) AS value FROM {{table}} GROUP BY 1 ORDER BY 1",
    ].join("\n"),
    vegaLiteSpec: {
      mark: {
        type: "area",
        line: true,
        opacity: 0.15,
        color: "#3498db",
        tooltip: true,
      },
      encoding: {
        x: { field: "period", type: "temporal", axis: null },
        y: {
          field: "value",
          type: "quantitative",
          axis: null,
          scale: { zero: false },
        },
        tooltip: [
          { field: "period", type: "temporal" },
          { field: "value", type: "quantitative" },
        ],
      },
    },
    notes: [
      "This template is for the sparkline chart widget. Pair it with a separate KPI widget (type: 'kpi') for the headline number.",
      "axis: null hides both axes for a clean sparkline appearance.",
      "scale: { zero: false } on y ensures the sparkline fills the vertical space.",
      "Use a small layout (w: 3, h: 2) and place it next to the KPI card.",
    ],
  },
];

const templateMap = new Map(templates.map(t => [t.id, t]));

export function getAllTemplates(): Array<{
  id: string;
  name: string;
  description: string;
}> {
  return templates.map(({ id, name, description }) => ({
    id,
    name,
    description,
  }));
}

export function getTemplate(templateId: string): ChartTemplate | undefined {
  return templateMap.get(templateId);
}
