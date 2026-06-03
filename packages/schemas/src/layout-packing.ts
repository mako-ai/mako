import type { WidgetLayout } from "./dashboard.schema";

export const BREAKPOINT_COLS = { lg: 12, md: 10, sm: 6, xs: 4 } as const;
export type BreakpointKey = keyof typeof BREAKPOINT_COLS;

export const RESPONSIVE_BREAKPOINTS = ["lg", "md", "sm", "xs"] as const;

export type LayoutItem = {
  id: string;
  layout: WidgetLayout;
};

export type GridLayoutItem = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  static?: boolean;
};

type WidgetLayoutsInput = {
  lg?: WidgetLayout;
  md?: WidgetLayout;
  sm?: WidgetLayout;
  xs?: WidgetLayout;
};

export type WidgetForGridLayout = {
  id: string;
  type?: "chart" | "kpi" | "table";
  layouts?: WidgetLayoutsInput;
  layout?: WidgetLayout;
  vegaLiteSpec?: { mark?: string | Record<string, unknown> };
};

function effectiveMinW(layout: WidgetLayout, cols: number): number {
  return Math.min(Math.max(layout.minW ?? 1, 1), cols);
}

function scaledWidth(layout: WidgetLayout, cols: number, lgCols: number): number {
  const minW = effectiveMinW(layout, cols);
  const scale = cols / lgCols;
  return Math.min(Math.max(Math.round(layout.w * scale), minW), cols);
}

/**
 * Detect layouts produced by the legacy proportional scaler (same row y, scaled x/w).
 * These should be replaced by row packing so existing dashboards reflow correctly.
 */
export function isLegacyProportionalLayout(
  lg: WidgetLayout,
  bp: WidgetLayout,
  cols: number,
  lgCols: number = BREAKPOINT_COLS.lg,
): boolean {
  if (bp.userSet) return false;
  const expectedW = scaledWidth(lg, cols, lgCols);
  const expectedX = Math.min(
    Math.round(lg.x * (cols / lgCols)),
    Math.max(0, cols - expectedW),
  );
  return bp.y === lg.y && bp.w === expectedW && bp.x === expectedX;
}

export function shouldAutoPackBreakpoint(
  lg: WidgetLayout,
  bp: WidgetLayout | undefined,
  cols: number,
): boolean {
  if (!bp) return true;
  if (bp.userSet) return false;
  return isLegacyProportionalLayout(lg, bp, cols);
}

/**
 * Pack widgets into rows for a target column count, preserving lg row bands.
 * KPI-style strips on the same lg y get equal column widths when possible.
 */
export function packLayoutsForBreakpoint(
  items: LayoutItem[],
  cols: number,
  lgCols: number = BREAKPOINT_COLS.lg,
): Map<string, WidgetLayout> {
  const result = new Map<string, WidgetLayout>();
  if (items.length === 0) return result;

  const sorted = [...items].sort((a, b) => {
    const dy = a.layout.y - b.layout.y;
    if (dy !== 0) return dy;
    return a.layout.x - b.layout.x;
  });

  const rowGroups: LayoutItem[][] = [];
  for (const item of sorted) {
    const last = rowGroups[rowGroups.length - 1];
    if (!last || last[0].layout.y !== item.layout.y) {
      rowGroups.push([item]);
    } else {
      last.push(item);
    }
  }

  let globalY = 0;

  for (const row of rowGroups) {
    const rowHeight = Math.max(...row.map(i => i.layout.h));
    const totalLgW = row.reduce((sum, i) => sum + i.layout.w, 0);
    const sameHeight = row.every(i => i.layout.h === row[0].layout.h);
    const isStrip =
      row.length > 1 && sameHeight && totalLgW <= lgCols && rowHeight <= 4;

    if (isStrip) {
      packUniformStripRow(row, cols, globalY, result);
      globalY += rowHeight;
      continue;
    }

    globalY += packGreedyRow(row, cols, lgCols, globalY, result);
  }

  return result;
}

function bestStripItemsPerRow(n: number, cols: number, minW: number): number {
  const maxPerRow = Math.min(n, Math.floor(cols / minW));
  let best = 1;
  let bestScore = -Infinity;

  for (let perRow = maxPerRow; perRow >= 1; perRow -= 1) {
    const w = Math.floor(cols / perRow);
    if (w < minW) continue;
    const rows = Math.ceil(n / perRow);
    const lastRowCount = n % perRow || perRow;
    const unevenLastRow = lastRowCount !== perRow && lastRowCount !== 1 ? 1 : 0;
    const score = -rows * 1_000 - unevenLastRow * 100 + w;
    if (score > bestScore) {
      bestScore = score;
      best = perRow;
    }
  }

  return best;
}

function packUniformStripRow(
  row: LayoutItem[],
  cols: number,
  globalY: number,
  result: Map<string, WidgetLayout>,
): void {
  const rowHeight = row[0].layout.h;
  const minW = Math.max(...row.map(i => effectiveMinW(i.layout, cols)));
  const n = row.length;

  const perRow = bestStripItemsPerRow(n, cols, minW);

  let itemIndex = 0;
  let subRowY = 0;

  while (itemIndex < n) {
    const count = Math.min(perRow, n - itemIndex);
    const baseW = Math.floor(cols / count);
    const remainder = cols % count;
    let x = 0;

    for (let i = 0; i < count; i++) {
      const item = row[itemIndex + i];
      const w = Math.min(
        Math.max(baseW + (i < remainder ? 1 : 0), effectiveMinW(item.layout, cols)),
        cols,
      );
      result.set(item.id, layoutWithMeta(item.layout, x, globalY + subRowY, w, rowHeight));
      x += w;
    }

    itemIndex += count;
    subRowY += rowHeight;
  }
}

function packGreedyRow(
  row: LayoutItem[],
  cols: number,
  lgCols: number,
  globalY: number,
  result: Map<string, WidgetLayout>,
): number {
  let x = 0;
  let subRowY = 0;
  let subRowHeight = 0;

  for (const item of row) {
    const w = scaledWidth(item.layout, cols, lgCols);
    const h = item.layout.h;

    if (x > 0 && x + w > cols) {
      subRowY += subRowHeight;
      x = 0;
      subRowHeight = 0;
    }

    result.set(
      item.id,
      layoutWithMeta(item.layout, x, globalY + subRowY, w, h),
    );
    x += w;
    subRowHeight = Math.max(subRowHeight, h);
  }

  return subRowY + subRowHeight;
}

function layoutWithMeta(
  source: WidgetLayout,
  x: number,
  y: number,
  w: number,
  h: number,
): WidgetLayout {
  return {
    x,
    y,
    w,
    h,
    ...(source.minW != null ? { minW: Math.min(source.minW, w) } : {}),
    ...(source.minH != null ? { minH: source.minH } : {}),
  };
}

export function resolveLgLayout(widget: WidgetForGridLayout): WidgetLayout {
  const legacy = widget.layout;
  const lg = widget.layouts?.lg ?? legacy;
  if (!lg) return { x: 0, y: 0, w: 6, h: 4 };
  return lg;
}

/**
 * Build react-grid-layout `layouts` from dashboard widgets.
 * Uses explicit per-breakpoint layouts when userSet; otherwise packs from lg.
 */
export function buildGridLayoutsFromWidgets(
  widgets: WidgetForGridLayout[],
  options?: {
    static?: boolean;
    getMinSize?: (
      widget: WidgetForGridLayout,
    ) => { minW: number; minH: number };
  },
): Record<string, GridLayoutItem[]> {
  const lgItems: LayoutItem[] = widgets.map(w => ({
    id: w.id,
    layout: resolveLgLayout(w),
  }));

  const result: Record<string, GridLayoutItem[]> = {};

  for (const bp of RESPONSIVE_BREAKPOINTS) {
    const cols = BREAKPOINT_COLS[bp];
    const packed =
      bp === "lg"
        ? new Map(lgItems.map(i => [i.id, i.layout]))
        : packLayoutsForBreakpoint(lgItems, cols);

    const items: GridLayoutItem[] = [];

    for (const widget of widgets) {
      const lg = resolveLgLayout(widget);
      const mins = options?.getMinSize?.(widget);
      const explicit = widget.layouts?.[bp];
      const usePacked = shouldAutoPackBreakpoint(lg, explicit, cols);
      const layout = usePacked
        ? packed.get(widget.id)
        : explicit;
      if (!layout) continue;

      items.push({
        i: widget.id,
        x: layout.x ?? 0,
        y: layout.y ?? 0,
        w: layout.w ?? lg.w,
        h: layout.h ?? lg.h,
        minW: layout.minW ?? mins?.minW,
        minH: layout.minH ?? mins?.minH,
        ...(options?.static ? { static: true } : {}),
      });
    }

    if (items.length > 0) result[bp] = items;
  }

  if (!result.lg) {
    result.lg = widgets.map(w => {
      const lg = resolveLgLayout(w);
      const mins = options?.getMinSize?.(w);
      return {
        i: w.id,
        x: lg.x ?? 0,
        y: lg.y ?? 0,
        w: lg.w ?? 6,
        h: lg.h ?? 4,
        minW: lg.minW ?? mins?.minW,
        minH: lg.minH ?? mins?.minH,
        ...(options?.static ? { static: true } : {}),
      };
    });
  }

  return result;
}

/**
 * Derive all breakpoints for a single widget (e.g. new widget defaults).
 * Only lg is meaningful for persistence; smaller breakpoints are packed at render.
 */
export function deriveResponsiveLayouts(
  lgLayout: WidgetLayout,
): WidgetLayoutsInput & { lg: WidgetLayout } {
  return { lg: lgLayout };
}
