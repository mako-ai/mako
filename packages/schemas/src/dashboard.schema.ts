import { z } from "zod";

export const DashboardQueryLanguageSchema = z.enum([
  "sql",
  "javascript",
  "mongodb",
]);

export const DashboardQueryDefinitionSchema = z.object({
  connectionId: z.string(),
  language: DashboardQueryLanguageSchema,
  code: z.string(),
  databaseId: z.string().optional(),
  databaseName: z.string().optional(),
  mongoOptions: z
    .object({
      collection: z.string().optional(),
      operation: z
        .enum([
          "find",
          "aggregate",
          "insertMany",
          "updateMany",
          "deleteMany",
          "findOne",
          "updateOne",
          "deleteOne",
        ])
        .optional(),
    })
    .optional(),
});

export const DashboardDataSourceOriginSchema = z.object({
  type: z.enum(["saved_console", "local"]),
  consoleId: z.string().optional(),
  consoleName: z.string().optional(),
  importedAt: z.string().optional(),
});

export const DashboardDataSourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  tableRef: z.string(),
  query: DashboardQueryDefinitionSchema,
  origin: DashboardDataSourceOriginSchema.optional(),
  timeDimension: z.string().optional(),
  rowLimit: z.number().optional(),
  materializationMode: z
    .enum(["auto", "local_opfs", "remote_parquet", "legacy_streamed"])
    .optional(),
  cache: z
    .object({
      ttlSeconds: z.number().optional(),
      lastRefreshedAt: z.string().optional(),
      rowCount: z.number().optional(),
      byteSize: z.number().optional(),
      parquetArtifactKey: z.string().optional(),
      parquetVersion: z.string().optional(),
      parquetBuiltAt: z.string().optional(),
      parquetExpiresAt: z.string().optional(),
      parquetBuildStatus: z
        .enum(["missing", "building", "ready", "error"])
        .optional(),
      parquetLastError: z.string().optional(),
      parquetUrl: z.string().optional(),
    })
    .optional(),
  computedColumns: z
    .array(
      z.object({
        name: z.string(),
        expression: z.string(),
        type: z.enum(["quantitative", "temporal", "nominal", "ordinal"]),
      }),
    )
    .optional(),
});

export const WidgetLayoutSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  minW: z.number().optional(),
  minH: z.number().optional(),
});

export type WidgetLayout = z.infer<typeof WidgetLayoutSchema>;

export const DashboardWidgetSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  type: z.enum(["chart", "kpi", "table"]),
  dataSourceId: z.string(),
  localSql: z.string(),
  vegaLiteSpec: z.record(z.string(), z.unknown()).optional(),
  kpiConfig: z
    .object({
      valueField: z.string(),
      format: z.string().optional(),
      comparisonField: z.string().optional(),
      comparisonLabel: z.string().optional(),
    })
    .optional(),
  tableConfig: z
    .object({
      columns: z.array(z.string()).optional(),
      pageSize: z.number().optional(),
    })
    .optional(),
  crossFilter: z.object({
    enabled: z.boolean(),
    fields: z.array(z.string()).optional(),
  }),
  layouts: z.object({
    lg: WidgetLayoutSchema,
    md: WidgetLayoutSchema.optional(),
    sm: WidgetLayoutSchema.optional(),
    xs: WidgetLayoutSchema.optional(),
  }),
});

export const TableRelationshipSchema = z.object({
  id: z.string(),
  from: z.object({ dataSourceId: z.string(), column: z.string() }),
  to: z.object({ dataSourceId: z.string(), column: z.string() }),
  type: z.enum(["one-to-one", "one-to-many", "many-to-one", "many-to-many"]),
});

export const GlobalFilterSchema = z.object({
  id: z.string(),
  type: z.enum(["date-range", "select", "multi-select", "search"]),
  label: z.string(),
  dataSourceId: z.string(),
  column: z.string(),
  config: z.record(z.string(), z.unknown()),
  layout: z.object({
    order: z.number(),
    width: z.number().optional(),
  }),
});

/**
 * Schema for the editable portion of a dashboard definition.
 * Excludes DB metadata fields (_id, workspaceId, createdBy, etc.)
 * so that Zod strips them when parsing user-edited JSON.
 */
export const DashboardDefinitionSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  dataSources: z.array(DashboardDataSourceSchema),
  widgets: z.array(DashboardWidgetSchema),
  relationships: z.array(TableRelationshipSchema),
  globalFilters: z.array(GlobalFilterSchema),
  crossFilter: z.object({
    enabled: z.boolean(),
    resolution: z.enum(["intersect", "union"]),
    engine: z.enum(["mosaic", "legacy"]).optional(),
  }),
  materializationMode: z
    .enum(["auto", "local_opfs", "remote_parquet", "legacy_streamed"])
    .optional(),
  layout: z.object({
    columns: z.number(),
    rowHeight: z.number(),
  }),
  cache: z.object({
    ttlSeconds: z.number(),
    lastRefreshedAt: z.string().optional(),
  }),
});

export type DashboardQueryLanguage = z.infer<
  typeof DashboardQueryLanguageSchema
>;
export type DashboardQueryDefinition = z.infer<
  typeof DashboardQueryDefinitionSchema
>;
export type DashboardDataSourceOrigin = z.infer<
  typeof DashboardDataSourceOriginSchema
>;
export type DashboardDataSource = z.infer<typeof DashboardDataSourceSchema>;
export type DashboardWidget = z.infer<typeof DashboardWidgetSchema>;
export type TableRelationship = z.infer<typeof TableRelationshipSchema>;
export type GlobalFilter = z.infer<typeof GlobalFilterSchema>;
export type DashboardDefinition = z.infer<typeof DashboardDefinitionSchema>;

const DEFAULT_LAYOUT: WidgetLayout = { x: 0, y: 0, w: 6, h: 4 };

function safeLayout(raw: Record<string, unknown> | undefined): WidgetLayout {
  if (!raw) return { ...DEFAULT_LAYOUT };
  return {
    x: typeof raw.x === "number" ? raw.x : 0,
    y: typeof raw.y === "number" ? raw.y : 0,
    w: typeof raw.w === "number" ? raw.w : DEFAULT_LAYOUT.w,
    h: typeof raw.h === "number" ? raw.h : DEFAULT_LAYOUT.h,
    ...(typeof raw.minW === "number" ? { minW: raw.minW } : {}),
    ...(typeof raw.minH === "number" ? { minH: raw.minH } : {}),
  };
}

/**
 * Normalize a widget that may have legacy `layout` (single) or new `layouts`
 * (per-breakpoint). Returns a widget guaranteed to have `layouts.lg`.
 * Handles missing, partial, and corrupted data gracefully.
 */
export function normalizeWidgetLayouts<
  T extends Record<string, unknown>,
>(widget: T): T & { layouts: DashboardWidget["layouts"] } {
  const w = widget as Record<string, unknown>;

  if (
    w.layouts &&
    typeof w.layouts === "object" &&
    !Array.isArray(w.layouts)
  ) {
    const raw = w.layouts as Record<string, unknown>;
    if (raw.lg && typeof raw.lg === "object") {
      const result: DashboardWidget["layouts"] = {
        lg: safeLayout(raw.lg as Record<string, unknown>),
      };
      if (raw.md && typeof raw.md === "object")
        result.md = safeLayout(raw.md as Record<string, unknown>);
      if (raw.sm && typeof raw.sm === "object")
        result.sm = safeLayout(raw.sm as Record<string, unknown>);
      if (raw.xs && typeof raw.xs === "object")
        result.xs = safeLayout(raw.xs as Record<string, unknown>);
      return { ...widget, layouts: result };
    }
    const firstBp = (["md", "sm", "xs"] as const).find(
      bp => raw[bp] && typeof raw[bp] === "object",
    );
    const lg = firstBp
      ? safeLayout(raw[firstBp] as Record<string, unknown>)
      : safeLayout(undefined);
    return { ...widget, layouts: { lg } };
  }

  if (w.layout && typeof w.layout === "object" && !Array.isArray(w.layout)) {
    const lg = safeLayout(w.layout as Record<string, unknown>);
    const { layout: _removed, ...rest } = widget;
    return { ...rest, layouts: { lg } } as T & {
      layouts: DashboardWidget["layouts"];
    };
  }

  return { ...widget, layouts: { lg: { ...DEFAULT_LAYOUT } } };
}
