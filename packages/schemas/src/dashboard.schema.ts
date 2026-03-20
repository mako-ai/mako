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
  cache: z
    .object({
      ttlSeconds: z.number().optional(),
      lastRefreshedAt: z.string().optional(),
      rowCount: z.number().optional(),
      byteSize: z.number().optional(),
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
  layout: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    minW: z.number().optional(),
    minH: z.number().optional(),
  }),
});

export const TableRelationshipSchema = z.object({
  id: z.string(),
  from: z.object({ dataSourceId: z.string(), column: z.string() }),
  to: z.object({ dataSourceId: z.string(), column: z.string() }),
  type: z.enum([
    "one-to-one",
    "one-to-many",
    "many-to-one",
    "many-to-many",
  ]),
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
  }),
  layout: z.object({
    columns: z.number(),
    rowHeight: z.number(),
  }),
  cache: z.object({
    ttlSeconds: z.number(),
    lastRefreshedAt: z.string().optional(),
  }),
});

export type DashboardQueryLanguage = z.infer<typeof DashboardQueryLanguageSchema>;
export type DashboardQueryDefinition = z.infer<typeof DashboardQueryDefinitionSchema>;
export type DashboardDataSourceOrigin = z.infer<typeof DashboardDataSourceOriginSchema>;
export type DashboardDataSource = z.infer<typeof DashboardDataSourceSchema>;
export type DashboardWidget = z.infer<typeof DashboardWidgetSchema>;
export type TableRelationship = z.infer<typeof TableRelationshipSchema>;
export type GlobalFilter = z.infer<typeof GlobalFilterSchema>;
export type DashboardDefinition = z.infer<typeof DashboardDefinitionSchema>;
