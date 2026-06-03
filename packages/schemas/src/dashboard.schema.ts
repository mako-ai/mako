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

export const DashboardMaterializationScheduleSchema = z.object({
  enabled: z.boolean(),
  cron: z.string().nullable(),
  timezone: z.string().optional(),
  dataFreshnessTtlMs: z.number().nullable().optional(),
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
      lastRefreshedAt: z.string().optional(),
      rowCount: z.number().optional(),
      byteSize: z.number().optional(),
      parquetArtifactKey: z.string().optional(),
      definitionHash: z.string().optional(),
      artifactRevision: z.string().optional(),
      parquetVersion: z.string().optional(),
      parquetBuiltAt: z.string().optional(),
      parquetBuildStatus: z
        .enum(["missing", "queued", "building", "ready", "error"])
        .nullable()
        .optional(),
      parquetLastError: z.string().nullable().optional(),
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
  /** True when a user intentionally edited this breakpoint layout. */
  custom: z.boolean().optional(),
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
  materializationSchedule: DashboardMaterializationScheduleSchema,
  layout: z.object({
    columns: z.number(),
    rowHeight: z.number(),
  }),
  cache: z.object({
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
export type DashboardMaterializationSchedule = z.infer<
  typeof DashboardMaterializationScheduleSchema
>;
export type DashboardDataSource = z.infer<typeof DashboardDataSourceSchema>;
export type DashboardWidget = z.infer<typeof DashboardWidgetSchema>;
export type TableRelationship = z.infer<typeof TableRelationshipSchema>;
export type GlobalFilter = z.infer<typeof GlobalFilterSchema>;
export type DashboardDefinition = z.infer<typeof DashboardDefinitionSchema>;

const DEFAULT_LAYOUT: WidgetLayout = { x: 0, y: 0, w: 6, h: 4 };

const BREAKPOINT_COLS = { lg: 12, md: 10, sm: 6, xs: 4 } as const;
type LayoutBreakpoint = keyof typeof BREAKPOINT_COLS;

type LayoutWidgetInput = Record<string, unknown> & {
  id?: unknown;
  type?: unknown;
  layouts?: unknown;
  layout?: unknown;
  vegaLiteSpec?: unknown;
};

const RESPONSIVE_BREAKPOINTS = ["lg", "md", "sm", "xs"] as const;

/**
 * Returns recommended size and enforced minimums for a widget based on its
 * type and (for charts) the Vega-Lite mark type.
 */
export function getWidgetSizeDefaults(
  type: "chart" | "kpi" | "table",
  vegaMark?: string,
): { w: number; h: number; minW: number; minH: number } {
  if (type === "kpi") return { w: 3, h: 2, minW: 2, minH: 2 };
  if (type === "table") return { w: 12, h: 5, minW: 4, minH: 3 };
  if (vegaMark === "arc") return { w: 4, h: 4, minW: 3, minH: 3 };
  return { w: 12, h: 5, minW: 4, minH: 3 };
}

/**
 * Derive `md`, `sm`, and `xs` layouts from an `lg` layout by proportionally
 * scaling widths to match each breakpoint's column count.
 */
export function deriveResponsiveLayouts(
  lgLayout: WidgetLayout,
): DashboardWidget["layouts"] {
  const derive = (cols: number): WidgetLayout => {
    const scale = cols / BREAKPOINT_COLS.lg;
    const minW = lgLayout.minW ?? 2;
    const w = Math.min(Math.max(Math.round(lgLayout.w * scale), minW), cols);
    return {
      x: Math.min(Math.round(lgLayout.x * scale), cols - w),
      y: lgLayout.y,
      w,
      h: lgLayout.h,
      ...(lgLayout.minW != null ? { minW: Math.min(lgLayout.minW, cols) } : {}),
      ...(lgLayout.minH != null ? { minH: lgLayout.minH } : {}),
    };
  };
  return {
    lg: lgLayout,
    md: derive(BREAKPOINT_COLS.md),
    sm: derive(BREAKPOINT_COLS.sm),
    xs: derive(BREAKPOINT_COLS.xs),
  };
}

function getWidgetVegaMark(widget: LayoutWidgetInput): string | undefined {
  const spec = widget.vegaLiteSpec;
  if (!spec || typeof spec !== "object") return undefined;
  const mark = (spec as Record<string, unknown>).mark;
  if (typeof mark === "string") return mark;
  if (mark && typeof mark === "object") {
    const type = (mark as Record<string, unknown>).type;
    return typeof type === "string" ? type : undefined;
  }
  return undefined;
}

function getWidgetType(widget: LayoutWidgetInput): "chart" | "kpi" | "table" {
  return widget.type === "kpi" || widget.type === "table"
    ? widget.type
    : "chart";
}

function readRawLayouts(
  widget: LayoutWidgetInput,
): Partial<Record<LayoutBreakpoint, WidgetLayout>> {
  const result: Partial<Record<LayoutBreakpoint, WidgetLayout>> = {};
  const rawLayouts =
    widget.layouts && typeof widget.layouts === "object"
      ? (widget.layouts as Record<string, unknown>)
      : null;

  for (const bp of RESPONSIVE_BREAKPOINTS) {
    const raw = rawLayouts?.[bp];
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      result[bp] = safeLayout(raw as Record<string, unknown>);
    }
  }

  if (
    !result.lg &&
    widget.layout &&
    typeof widget.layout === "object" &&
    !Array.isArray(widget.layout)
  ) {
    result.lg = safeLayout(widget.layout as Record<string, unknown>);
  }

  return result;
}

function layoutsMatch(a: WidgetLayout, b: WidgetLayout): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function withWidgetMinimums(
  widget: LayoutWidgetInput,
  layout: WidgetLayout,
): WidgetLayout {
  const defaults = getWidgetSizeDefaults(
    getWidgetType(widget),
    getWidgetVegaMark(widget),
  );
  return {
    ...layout,
    minW: layout.minW ?? defaults.minW,
    minH: layout.minH ?? defaults.minH,
  };
}

function preferredWidgetWidth(
  widget: LayoutWidgetInput,
  layout: WidgetLayout,
  cols: number,
): number {
  const type = getWidgetType(widget);
  const minW = Math.min(layout.minW ?? 2, cols);

  if (type === "table") return cols;

  if (type === "chart") {
    if (layout.w >= 9) return cols;
    if (layout.w >= 6) {
      return cols >= 10 ? Math.max(Math.floor(cols / 2), minW) : cols;
    }
    if (cols <= 4) return cols;
  }

  const scaled = Math.round((layout.w * cols) / BREAKPOINT_COLS.lg);
  return Math.min(Math.max(scaled, minW), cols);
}

function packKpiRow(
  widgets: Array<{ widget: LayoutWidgetInput; lg: WidgetLayout }>,
  cols: number,
  y: number,
): { layouts: Map<string, WidgetLayout>; nextY: number } {
  const layouts = new Map<string, WidgetLayout>();
  const perRow = cols <= 4 ? 1 : 2;
  let cursorY = y;

  for (let index = 0; index < widgets.length; index += perRow) {
    const row = widgets.slice(index, index + perRow);
    const singleRemainder = row.length === 1 && widgets.length > perRow;
    const width = singleRemainder ? cols : Math.floor(cols / row.length);
    const rowHeight = Math.max(...row.map(entry => entry.lg.h));
    let cursorX = 0;

    for (let rowIndex = 0; rowIndex < row.length; rowIndex += 1) {
      const { widget, lg } = row[rowIndex];
      const w = rowIndex === row.length - 1 ? cols - cursorX : width;
      layouts.set(String(widget.id), {
        x: cursorX,
        y: cursorY,
        w,
        h: lg.h,
        ...(lg.minW != null ? { minW: Math.min(lg.minW, cols) } : {}),
        ...(lg.minH != null ? { minH: lg.minH } : {}),
      });
      cursorX += w;
    }

    cursorY += rowHeight;
  }

  return { layouts, nextY: cursorY };
}

function packMixedRow(
  widgets: Array<{ widget: LayoutWidgetInput; lg: WidgetLayout }>,
  cols: number,
  y: number,
): { layouts: Map<string, WidgetLayout>; nextY: number } {
  const layouts = new Map<string, WidgetLayout>();
  let cursorX = 0;
  let cursorY = y;
  let rowHeight = 0;

  for (const { widget, lg } of widgets) {
    const w = preferredWidgetWidth(widget, lg, cols);
    if (cursorX > 0 && cursorX + w > cols) {
      cursorY += rowHeight;
      cursorX = 0;
      rowHeight = 0;
    }

    layouts.set(String(widget.id), {
      x: cursorX,
      y: cursorY,
      w,
      h: lg.h,
      ...(lg.minW != null ? { minW: Math.min(lg.minW, cols) } : {}),
      ...(lg.minH != null ? { minH: lg.minH } : {}),
    });
    cursorX += w;
    rowHeight = Math.max(rowHeight, lg.h);
  }

  return { layouts, nextY: cursorY + rowHeight };
}

function deriveBreakpointLayouts(
  widgets: Array<{ widget: LayoutWidgetInput; lg: WidgetLayout }>,
  breakpoint: Exclude<LayoutBreakpoint, "lg">,
): Map<string, WidgetLayout> {
  const cols = BREAKPOINT_COLS[breakpoint];
  const rows = new Map<
    number,
    Array<{ widget: LayoutWidgetInput; lg: WidgetLayout }>
  >();

  for (const entry of widgets) {
    const row = rows.get(entry.lg.y) ?? [];
    row.push(entry);
    rows.set(entry.lg.y, row);
  }

  const layouts = new Map<string, WidgetLayout>();
  let cursorY = 0;

  for (const [, row] of [...rows.entries()].sort(([a], [b]) => a - b)) {
    row.sort((a, b) => a.lg.x - b.lg.x);
    const packed = row.every(entry => getWidgetType(entry.widget) === "kpi")
      ? packKpiRow(row, cols, cursorY)
      : packMixedRow(row, cols, cursorY);
    for (const [id, layout] of packed.layouts) {
      layouts.set(id, layout);
    }
    cursorY = packed.nextY;
  }

  return layouts;
}

function isUserAuthoredBreakpoint(
  rawLayout: WidgetLayout | undefined,
  lg: WidgetLayout,
  breakpoint: Exclude<LayoutBreakpoint, "lg">,
): rawLayout is WidgetLayout {
  if (!rawLayout) return false;
  if (rawLayout.custom === true) return true;
  const legacyDerived = deriveResponsiveLayouts(lg)[breakpoint];
  if (!legacyDerived) return true;
  return !layoutsMatch(rawLayout, legacyDerived);
}

function layoutsOverlap(a: WidgetLayout, b: WidgetLayout): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

function resolveBreakpointCollisions(
  entries: Array<{
    widget: LayoutWidgetInput;
    rawLayouts: Partial<Record<LayoutBreakpoint, WidgetLayout>>;
    lg: WidgetLayout;
  }>,
  generated: Map<string, WidgetLayout>,
  breakpoint: Exclude<LayoutBreakpoint, "lg">,
): Map<string, WidgetLayout> {
  const resolved = new Map<string, WidgetLayout>();
  const placed: WidgetLayout[] = [];
  const generatedEntries: Array<{ id: string; layout: WidgetLayout }> = [];

  for (const entry of entries) {
    const id = String(entry.widget.id);
    const rawLayout = entry.rawLayouts[breakpoint];
    if (isUserAuthoredBreakpoint(rawLayout, entry.lg, breakpoint)) {
      resolved.set(id, rawLayout);
      placed.push(rawLayout);
      continue;
    }

    const layout = generated.get(id);
    if (layout) {
      generatedEntries.push({ id, layout });
    }
  }

  generatedEntries.sort(
    (a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x,
  );

  for (const { id, layout } of generatedEntries) {
    const nextLayout = { ...layout };
    while (
      placed.some(placedLayout => layoutsOverlap(nextLayout, placedLayout))
    ) {
      nextLayout.y += 1;
    }
    resolved.set(id, nextLayout);
    placed.push(nextLayout);
  }

  return resolved;
}

/**
 * Normalize a full dashboard widget list while deriving responsive layouts from
 * row intent rather than scaling each widget independently. Explicit user
 * breakpoint layouts are preserved; missing or legacy auto-derived breakpoints
 * are synthesized.
 */
export function normalizeDashboardWidgetsLayouts<T extends LayoutWidgetInput>(
  widgets: T[],
): Array<T & { layouts: DashboardWidget["layouts"] }> {
  const entries = widgets.map(widget => {
    const rawLayouts = readRawLayouts(widget);
    const lg = withWidgetMinimums(
      widget,
      rawLayouts.lg ?? { ...DEFAULT_LAYOUT },
    );
    return { widget, rawLayouts, lg };
  });

  const generated = {
    md: deriveBreakpointLayouts(entries, "md"),
    sm: deriveBreakpointLayouts(entries, "sm"),
    xs: deriveBreakpointLayouts(entries, "xs"),
  };
  const derived = {
    md: resolveBreakpointCollisions(entries, generated.md, "md"),
    sm: resolveBreakpointCollisions(entries, generated.sm, "sm"),
    xs: resolveBreakpointCollisions(entries, generated.xs, "xs"),
  };

  return entries.map(({ widget, rawLayouts, lg }) => {
    const id = String(widget.id);
    const layouts: DashboardWidget["layouts"] = {
      lg,
      md: derived.md.get(id) ?? deriveResponsiveLayouts(lg).md,
      sm: derived.sm.get(id) ?? deriveResponsiveLayouts(lg).sm,
      xs: derived.xs.get(id) ?? deriveResponsiveLayouts(lg).xs,
    };
    const { layout: _removed, ...rest } = widget;
    return { ...rest, layouts } as T & { layouts: DashboardWidget["layouts"] };
  });
}

function safeLayout(raw: Record<string, unknown> | undefined): WidgetLayout {
  if (!raw) return { ...DEFAULT_LAYOUT };
  return {
    x: typeof raw.x === "number" ? raw.x : 0,
    y: typeof raw.y === "number" ? raw.y : 0,
    w: typeof raw.w === "number" ? raw.w : DEFAULT_LAYOUT.w,
    h: typeof raw.h === "number" ? raw.h : DEFAULT_LAYOUT.h,
    ...(typeof raw.minW === "number" ? { minW: raw.minW } : {}),
    ...(typeof raw.minH === "number" ? { minH: raw.minH } : {}),
    ...(typeof raw.custom === "boolean" ? { custom: raw.custom } : {}),
  };
}

/**
 * Normalize a widget that may have legacy `layout` (single) or new `layouts`
 * (per-breakpoint). Returns a widget guaranteed to have `layouts.lg` and
 * derived `md`/`sm`/`xs` breakpoints when they are missing.
 * Handles missing, partial, and corrupted data gracefully.
 */
export function normalizeWidgetLayouts<T extends Record<string, unknown>>(
  widget: T,
): T & { layouts: DashboardWidget["layouts"] } {
  const w = widget as Record<string, unknown>;

  if (w.layouts && typeof w.layouts === "object" && !Array.isArray(w.layouts)) {
    const raw = w.layouts as Record<string, unknown>;
    if (raw.lg && typeof raw.lg === "object") {
      const lg = safeLayout(raw.lg as Record<string, unknown>);
      const derived = deriveResponsiveLayouts(lg);
      const result: DashboardWidget["layouts"] = {
        lg,
        md:
          raw.md && typeof raw.md === "object"
            ? safeLayout(raw.md as Record<string, unknown>)
            : derived.md,
        sm:
          raw.sm && typeof raw.sm === "object"
            ? safeLayout(raw.sm as Record<string, unknown>)
            : derived.sm,
        xs:
          raw.xs && typeof raw.xs === "object"
            ? safeLayout(raw.xs as Record<string, unknown>)
            : derived.xs,
      };
      return { ...widget, layouts: result };
    }
    const firstBp = (["md", "sm", "xs"] as const).find(
      bp => raw[bp] && typeof raw[bp] === "object",
    );
    const lg = firstBp
      ? safeLayout(raw[firstBp] as Record<string, unknown>)
      : safeLayout(undefined);
    return { ...widget, layouts: deriveResponsiveLayouts(lg) };
  }

  if (w.layout && typeof w.layout === "object" && !Array.isArray(w.layout)) {
    const lg = safeLayout(w.layout as Record<string, unknown>);
    const { layout: _removed, ...rest } = widget;
    return { ...rest, layouts: deriveResponsiveLayouts(lg) } as T & {
      layouts: DashboardWidget["layouts"];
    };
  }

  return {
    ...widget,
    layouts: deriveResponsiveLayouts({ ...DEFAULT_LAYOUT }),
  };
}
