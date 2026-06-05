/**
 * MakoChartSpec — Zod schema for Vega-Lite chart specifications.
 *
 * This is the single source of truth for chart spec validation.
 * It covers the subset of Vega-Lite needed for ~95% of analytical charts
 * while being constrained enough for reliable LLM generation.
 *
 * Used by:
 * - Agent tool definitions (inputSchema for modify_chart_spec, add_widget)
 * - Chart renderer (safeParse before vega-embed)
 * - Auto-spec generator (produces valid MakoChartSpec instances)
 *
 * SYNC NOTE: A copy of this schema lives in app/src/lib/chart-spec.ts
 * for frontend use. Keep both files in sync when making changes.
 */

import { z } from "zod";

// --- Primitives ---
const LooseObject = z.record(z.string(), z.unknown());

export const FieldType = z.enum([
  "quantitative",
  "temporal",
  "nominal",
  "ordinal",
]);

export const AggregateOp = z
  .enum([
    "count",
    "sum",
    "mean",
    "average",
    "median",
    "min",
    "max",
    "distinct",
    "variance",
    "stdev",
    "q1",
    "q3",
  ])
  .optional();

export const TimeUnit = z
  .enum([
    "year",
    "quarter",
    "month",
    "week",
    "day",
    "yearmonth",
    "yearmonthdate",
    "yearquarter",
    "monthdate",
    "hours",
    "minutes",
    "seconds",
    "hoursminutes",
    "hoursminutesseconds",
  ])
  .optional();

export const SortOrder = z.enum(["ascending", "descending"]).optional();

const StackOption = z
  .union([
    z.enum(["zero", "normalize", "center"]),
    z.literal(false),
    z.literal(null),
  ])
  .optional();

// --- Encoding channel ---

export const FieldDef = z
  .object({
    field: z.string().describe("Column name from the data"),
    type: FieldType.describe("Vega-Lite data type"),
    aggregate: AggregateOp.describe("Aggregation function"),
    timeUnit: TimeUnit.describe("Time unit for temporal fields"),
    bin: z
      .union([z.boolean(), z.object({ maxbins: z.number().optional() })])
      .optional()
      .describe("Bin quantitative values"),
    sort: z
      .union([
        SortOrder,
        z.object({
          field: z.string().optional(),
          op: AggregateOp,
          order: SortOrder,
        }),
      ])
      .optional()
      .describe("Sort order"),
    title: z.string().optional().describe("Axis / legend title override"),
    format: z
      .string()
      .optional()
      .describe("D3 format string (e.g. '$,.0f', '.1%')"),
    axis: z
      .object({
        title: z.string().optional(),
        format: z.string().optional(),
        labelAngle: z.number().optional(),
        grid: z.boolean().optional(),
        tickCount: z.number().optional(),
      })
      .optional()
      .describe("Axis configuration"),
    scale: z
      .object({
        type: z
          .enum(["linear", "log", "sqrt", "symlog", "pow", "time", "utc"])
          .optional(),
        domain: z.array(z.any()).optional(),
        range: z.array(z.any()).optional(),
        zero: z.boolean().optional(),
        nice: z.boolean().optional(),
      })
      .optional()
      .describe("Scale configuration"),
    stack: StackOption.describe("Stack mode for bar/area charts"),
    legend: z
      .union([
        z.object({
          title: z.string().optional(),
          orient: z.enum(["left", "right", "top", "bottom", "none"]).optional(),
        }),
        z.literal(null),
      ])
      .optional()
      .describe("Legend configuration, null to hide"),
  })
  .passthrough();

const ValueDef = z
  .object({
    value: z
      .union([z.string(), z.number(), z.boolean(), z.null()])
      .describe("Constant value"),
  })
  .passthrough();

const EncodingChannel = z.union([FieldDef, ValueDef, LooseObject]);

// --- Encoding object ---

export const Encoding = z
  .object({
    x: EncodingChannel.optional(),
    y: EncodingChannel.optional(),
    x2: EncodingChannel.optional(),
    y2: EncodingChannel.optional(),
    color: EncodingChannel.optional(),
    size: EncodingChannel.optional(),
    opacity: EncodingChannel.optional(),
    shape: EncodingChannel.optional(),
    detail: EncodingChannel.optional(),
    text: EncodingChannel.optional(),
    tooltip: z.union([EncodingChannel, z.array(FieldDef)]).optional(),
    order: EncodingChannel.optional(),
    theta: EncodingChannel.optional(),
    radius: EncodingChannel.optional(),
  })
  .passthrough()
  .describe("Vega-Lite encoding channels");

// --- Mark ---

export const MarkType = z.enum([
  "bar",
  "line",
  "area",
  "point",
  "circle",
  "square",
  "tick",
  "rect",
  "rule",
  "text",
  "arc",
  "trail",
  "boxplot",
]);

export const MarkDef = z.union([
  MarkType,
  z
    .object({
      type: MarkType,
      tooltip: z
        .union([
          z.boolean(),
          z.object({ content: z.enum(["data", "encoding"]) }),
        ])
        .optional(),
      point: z
        .union([
          z.boolean(),
          z.object({
            filled: z.boolean().optional(),
            size: z.number().optional(),
          }),
        ])
        .optional()
        .describe("Show points on line/area marks"),
      opacity: z.number().min(0).max(1).optional(),
      color: z.string().optional(),
      filled: z.boolean().optional(),
      strokeWidth: z.number().optional(),
      cornerRadiusEnd: z.number().optional(),
      interpolate: z
        .enum([
          "linear",
          "step",
          "step-before",
          "step-after",
          "basis",
          "cardinal",
          "monotone",
        ])
        .optional(),
      line: z.boolean().optional().describe("Show line on area marks"),
      size: z.number().optional(),
      innerRadius: z
        .number()
        .optional()
        .describe("Inner radius for arc/donut charts"),
    })
    .passthrough(),
]);

// --- Transform ---

export const Transform = z.union([
  z.object({
    filter: z.union([
      z.string(),
      z.object({
        field: z.string(),
        oneOf: z.array(z.any()).optional(),
        range: z.array(z.any()).optional(),
        equal: z.any().optional(),
        gt: z.any().optional(),
        gte: z.any().optional(),
        lt: z.any().optional(),
        lte: z.any().optional(),
      }),
    ]),
  }),
  z.object({
    calculate: z.string().describe("Vega expression"),
    as: z.string().describe("New field name"),
  }),
  z.object({
    aggregate: z.array(
      z.object({
        op: z.string(),
        field: z.string().optional(),
        as: z.string(),
      }),
    ),
    groupby: z.array(z.string()),
  }),
  z.object({
    fold: z.array(z.string()).describe("Columns to unpivot"),
    as: z
      .array(z.string())
      .min(2)
      .max(2)
      .optional()
      .describe("Output field names [key, value]"),
  }),
  z.object({
    window: z.array(
      z.object({
        op: z.string(),
        field: z.string().optional(),
        as: z.string(),
      }),
    ),
    frame: z.array(z.number().nullable()).min(2).max(2).optional(),
    groupby: z.array(z.string()).optional(),
    sort: z
      .array(
        z.object({
          field: z.string(),
          order: SortOrder,
        }),
      )
      .optional(),
  }),
  z.object({
    joinaggregate: z.array(
      z.object({
        op: z.string(),
        field: z.string().optional(),
        as: z.string(),
      }),
    ),
    groupby: z.array(z.string()).optional(),
  }),
  LooseObject,
]);

// --- Layer spec (for multi-mark charts) ---

const LayerSpec = z
  .object({
    mark: MarkDef,
    encoding: Encoding.optional(),
    transform: z.array(Transform).optional(),
  })
  .passthrough();

// --- Top-level chart spec ---

export const MakoChartSpecBase = z
  .object({
    $schema: z
      .string()
      .optional()
      .describe("Vega-Lite schema URL. Omit — injected at render time."),
    description: z.string().optional(),
    title: z
      .union([
        z.string(),
        z.object({
          text: z.string(),
          subtitle: z.string().optional(),
          anchor: z.enum(["start", "middle", "end"]).optional(),
        }),
      ])
      .optional(),
    width: z.union([z.number(), z.literal("container")]).optional(),
    height: z.union([z.number(), z.literal("container")]).optional(),
    autosize: z
      .union([
        z.enum(["fit", "fit-x", "fit-y", "pad", "none"]),
        z.object({
          type: z.enum(["fit", "fit-x", "fit-y", "pad", "none"]),
          contains: z.enum(["padding", "content"]).optional(),
          resize: z.boolean().optional(),
        }),
      ])
      .optional(),
    transform: z.array(Transform).optional(),

    // Single-mark chart
    mark: MarkDef.optional(),
    encoding: Encoding.optional(),

    // Multi-mark chart (layers)
    layer: z.array(LayerSpec).optional(),
  })
  .passthrough();

export const MakoChartSpec = MakoChartSpecBase.refine(
  spec =>
    spec.mark !== undefined ||
    (spec.layer !== undefined && spec.layer.length > 0),
  {
    message:
      "Spec must have either 'mark' (single chart) or 'layer' (multi-mark chart)",
  },
);

export type MakoChartSpec = z.infer<typeof MakoChartSpec>;
