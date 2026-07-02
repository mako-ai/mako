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
  /**
   * The agent toolCallId that created this data source (creation idempotency:
   * multiple windows attached to the same chat stream dispatch the same
   * create call; the duplicate finds this stamp and returns the existing
   * data source instead of adding another).
   */
  createdByToolCallId: z.string().optional(),
});

/**
 * How a dashboard data source's data reaches the widgets — mirrors app data
 * bindings:
 * - `parquet` (default): the query is materialized to a Parquet artifact and
 *   loaded into DuckDB-WASM. Fast for aggregation; served to public shares.
 * - `live`: the query is streamed server-side into the DuckDB table on every
 *   load (no cache). Always fresh; not available in anonymous public shares.
 */
export const DashboardDataSourceMaterializationSchema = z.enum([
  "live",
  "parquet",
]);
export type DashboardDataSourceMaterialization = z.infer<
  typeof DashboardDataSourceMaterializationSchema
>;

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
  materialization: DashboardDataSourceMaterializationSchema.default("parquet"),
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
  /**
   * Marks a breakpoint layout as explicitly arranged by the user. When set on a
   * non-`lg` breakpoint, the responsive auto-reflow leaves that breakpoint alone
   * so the user stays in control. `lg` is always the authored source of truth and
   * never carries this flag.
   */
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

/**
 * Returns recommended size and enforced minimums for a widget based on its
 * type and (for charts) the Vega-Lite mark type.
 */
export function getWidgetSizeDefaults(
  type: "chart" | "kpi" | "table",
  vegaMark?: string,
): { w: number; h: number; minW: number; minH: number } {
  if (type === "kpi") return { w: 3, h: 2, minW: 2, minH: 1 };
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

export interface ReflowItem {
  id: string;
  layout: WidgetLayout;
  /**
   * Widget kind. Used to pick a more natural width when reflowing: tables and
   * very wide charts go full-width, half-width charts stay roughly half on wide
   * breakpoints, while KPIs and small widgets scale proportionally.
   */
  type?: "chart" | "kpi" | "table";
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Choose a widget's target width for a breakpoint. Proportional scaling is the
 * baseline, but charts and tables get type-aware treatment so they don't end up
 * awkwardly narrow on smaller grids.
 */
function preferredWidth(
  item: ReflowItem,
  sourceCols: number,
  targetCols: number,
): number {
  const { w, minW } = item.layout;
  const minWidth = clampInt(minW ?? 1, 1, targetCols);
  const proportional = clampInt(
    Math.round((w / sourceCols) * targetCols),
    minWidth,
    targetCols,
  );

  if (item.type === "table") return targetCols;

  if (item.type === "chart") {
    // A near-full-width chart stays full-width; a half-width chart stays ~half
    // on roomy grids but goes full-width once the grid gets very narrow.
    if (w >= sourceCols * 0.75) return targetCols;
    if (w >= sourceCols * 0.5) {
      return targetCols >= 10
        ? clampInt(Math.floor(targetCols / 2), minWidth, targetCols)
        : targetCols;
    }
    if (targetCols <= 4) return targetCols;
  }

  return proportional;
}

/**
 * Group widgets into visual rows based on their `lg` placement. Items whose
 * vertical spans overlap are considered part of the same row (e.g. a row of KPI
 * cards all at y=0). Rows are returned top-to-bottom, items left-to-right.
 */
function groupIntoRows(items: ReflowItem[]): ReflowItem[][] {
  const sorted = [...items].sort(
    (a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x,
  );
  const rows: ReflowItem[][] = [];
  let current: ReflowItem[] = [];
  let rowBottom = -Infinity;
  for (const item of sorted) {
    const top = item.layout.y;
    const bottom = item.layout.y + item.layout.h;
    if (current.length === 0 || top < rowBottom) {
      current.push(item);
      rowBottom = current.length === 1 ? bottom : Math.max(rowBottom, bottom);
    } else {
      rows.push(current);
      current = [item];
      rowBottom = bottom;
    }
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

type PlacedCell = { item: ReflowItem; x: number; w: number; ry: number };

/**
 * Reflow a single visual row of widgets into `targetCols`, wrapping onto extra
 * rows when they no longer fit and snapping widths so each packed sub-row is
 * flush (no floating gaps or staircases). Returns each item's position relative
 * to the top of this row group (`ry`).
 */
function reflowRow(
  row: ReflowItem[],
  sourceCols: number,
  targetCols: number,
): PlacedCell[] {
  const sorted = [...row].sort(
    (a, b) => a.layout.x - b.layout.x || a.layout.y - b.layout.y,
  );
  const n = sorted.length;

  const targetW = sorted.map(it => preferredWidth(it, sourceCols, targetCols));

  const widths = sorted.map(it => it.layout.w);
  const allEqual = widths.every(w => w === widths[0]);
  const sumW = widths.reduce((a, b) => a + b, 0);
  const tilesFullRow = Math.abs(sumW - sourceCols) <= 1;

  let perRow: number | null = null;
  if (n > 1 && allEqual && tilesFullRow) {
    const baseW = Math.max(1, targetW[0]);
    const maxPerRow = Math.max(1, Math.floor(targetCols / baseW));
    const numRows = Math.ceil(n / maxPerRow);
    perRow = Math.ceil(n / numRows);
  }

  const subRows: { item: ReflowItem; w: number }[][] = [];
  if (perRow != null) {
    for (let i = 0; i < n; i += perRow) {
      subRows.push(
        sorted
          .slice(i, i + perRow)
          .map((item, j) => ({ item, w: targetW[i + j] })),
      );
    }
  } else {
    let cur: { item: ReflowItem; w: number }[] = [];
    let curW = 0;
    sorted.forEach((item, i) => {
      const w = Math.min(targetW[i], targetCols);
      if (cur.length > 0 && curW + w > targetCols) {
        subRows.push(cur);
        cur = [];
        curW = 0;
      }
      cur.push({ item, w });
      curW += w;
    });
    if (cur.length > 0) subRows.push(cur);
  }

  const placed: PlacedCell[] = [];
  let ry = 0;
  for (const sub of subRows) {
    let sum = sub.reduce((a, b) => a + b.w, 0);
    let leftover = targetCols - sum;
    for (let i = 0; leftover > 0; i++, leftover--) {
      sub[i % sub.length].w += 1;
    }
    while (sum > targetCols) {
      const widest = sub.reduce((a, b) => (b.w > a.w ? b : a), sub[0]);
      const minW = clampInt(widest.item.layout.minW ?? 1, 1, targetCols);
      if (widest.w <= minW) break;
      widest.w -= 1;
      sum -= 1;
    }
    let x = 0;
    let maxH = 0;
    for (const cell of sub) {
      placed.push({ item: cell.item, x, w: cell.w, ry });
      x += cell.w;
      maxH = Math.max(maxH, cell.item.layout.h);
    }
    ry += maxH;
  }
  return placed;
}

/**
 * Deterministically reflow a set of widgets (positioned for `sourceCols`) into a
 * narrower `targetCols` grid. Rows of widgets wrap and tile cleanly instead of
 * proportionally shrinking into overlapping "staircase" positions.
 *
 * When `targetCols >= sourceCols` the layout is returned unchanged (no narrowing
 * needed). The result maps widget id → layout for the target breakpoint.
 */
export function reflowLayout(
  items: ReflowItem[],
  sourceCols: number,
  targetCols: number,
): Record<string, WidgetLayout> {
  const result: Record<string, WidgetLayout> = {};
  if (items.length === 0) return result;

  if (targetCols >= sourceCols) {
    for (const it of items) {
      const w = Math.min(it.layout.w, targetCols);
      result[it.id] = {
        ...it.layout,
        w,
        x: Math.min(it.layout.x, targetCols - w),
      };
    }
    return result;
  }

  const rows = groupIntoRows(items);
  let cursorY = 0;
  for (const row of rows) {
    const placed = reflowRow(row, sourceCols, targetCols);
    let rowBottom = 0;
    for (const cell of placed) {
      const { minW, minH } = cell.item.layout;
      result[cell.item.id] = {
        x: cell.x,
        y: cursorY + cell.ry,
        w: cell.w,
        h: cell.item.layout.h,
        ...(minW != null ? { minW: clampInt(minW, 1, targetCols) } : {}),
        ...(minH != null ? { minH } : {}),
      };
      rowBottom = Math.max(rowBottom, cell.ry + cell.item.layout.h);
    }
    cursorY += rowBottom;
  }
  return result;
}

function rectsOverlap(a: WidgetLayout, b: WidgetLayout): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

/**
 * Safety net: given a set of placed layouts (keyed by id, in placement order),
 * push any overlapping item straight down until it no longer collides. Already
 * collision-free layouts are returned unchanged. This guarantees the grid never
 * renders overlapping widgets even when reflowed items are mixed with
 * user-arranged ones.
 */
export function resolveLayoutCollisions(
  ordered: Array<{ id: string; layout: WidgetLayout }>,
): Record<string, WidgetLayout> {
  const placed: WidgetLayout[] = [];
  const result: Record<string, WidgetLayout> = {};
  for (const { id, layout } of ordered) {
    const next = { ...layout };
    while (placed.some(p => rectsOverlap(next, p))) {
      next.y += 1;
    }
    placed.push(next);
    result[id] = next;
  }
  return result;
}

/**
 * Build the full set of auto-derived responsive breakpoints (`md`/`sm`/`xs`)
 * for a collection of widgets using the row-aware {@link reflowLayout}. The `lg`
 * breakpoint is the source of truth and is not included in the output.
 */
export function reflowResponsiveLayouts(
  items: ReflowItem[],
  sourceCols: number = BREAKPOINT_COLS.lg,
): Record<"md" | "sm" | "xs", Record<string, WidgetLayout>> {
  return {
    md: reflowLayout(items, sourceCols, BREAKPOINT_COLS.md),
    sm: reflowLayout(items, sourceCols, BREAKPOINT_COLS.sm),
    xs: reflowLayout(items, sourceCols, BREAKPOINT_COLS.xs),
  };
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
    ...(raw.custom === true ? { custom: true } : {}),
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
      const lg = onlyBaseLayout(safeLayout(raw.lg as Record<string, unknown>));
      const result: DashboardWidget["layouts"] = { lg };
      // Only retain smaller breakpoints the user explicitly arranged. Non-custom
      // breakpoints are intentionally dropped so the responsive reflow governs
      // them at render time (avoids "frozen" stale layouts on resize).
      for (const bp of ["md", "sm", "xs"] as const) {
        const value = raw[bp];
        if (value && typeof value === "object") {
          const safe = safeLayout(value as Record<string, unknown>);
          if (safe.custom === true) result[bp] = safe;
        }
      }
      return { ...widget, layouts: result };
    }
    const firstBp = (["md", "sm", "xs"] as const).find(
      bp => raw[bp] && typeof raw[bp] === "object",
    );
    const lg = firstBp
      ? onlyBaseLayout(safeLayout(raw[firstBp] as Record<string, unknown>))
      : safeLayout(undefined);
    return { ...widget, layouts: { lg } };
  }

  if (w.layout && typeof w.layout === "object" && !Array.isArray(w.layout)) {
    const lg = onlyBaseLayout(safeLayout(w.layout as Record<string, unknown>));
    const { layout: _removed, ...rest } = widget;
    return { ...rest, layouts: { lg } } as T & {
      layouts: DashboardWidget["layouts"];
    };
  }

  return {
    ...widget,
    layouts: { lg: { ...DEFAULT_LAYOUT } },
  };
}

/** Strip the `custom` flag — `lg` is always the authored base, never an override. */
function onlyBaseLayout(layout: WidgetLayout): WidgetLayout {
  const { custom: _custom, ...base } = layout;
  return base;
}
