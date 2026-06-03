import type { WidgetLayout } from "./dashboard.schema";

export const BREAKPOINT_COLS = { lg: 12, md: 10, sm: 6, xs: 4 } as const;
export type BreakpointKey = keyof typeof BREAKPOINT_COLS;

export const RESPONSIVE_BREAKPOINTS = ["lg", "md", "sm", "xs"] as const;

export type LayoutItem = {
  id: string;
  layout: WidgetLayout;
  type?: "chart" | "kpi" | "table";
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
function isUserAuthoredLayout(bp: WidgetLayout | undefined): boolean {
  if (!bp) return false;
  if (bp.userSet === true) return true;
  return (bp as WidgetLayout & { custom?: boolean }).custom === true;
}

export function isLegacyProportionalLayout(
  lg: WidgetLayout,
  bp: WidgetLayout,
  cols: number,
  lgCols: number = BREAKPOINT_COLS.lg,
): boolean {
  if (isUserAuthoredLayout(bp)) return false;
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
  if (isUserAuthoredLayout(bp)) return false;
  return isLegacyProportionalLayout(lg, bp, cols);
}

/** Group widgets into visual rows when their vertical spans overlap on `lg`. */
function groupIntoRows(items: LayoutItem[]): LayoutItem[][] {
  const sorted = [...items].sort(
    (a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x,
  );
  const rows: LayoutItem[][] = [];
  let current: LayoutItem[] = [];
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

function preferredWidgetWidth(
  item: LayoutItem,
  cols: number,
  lgCols: number = BREAKPOINT_COLS.lg,
): number {
  const layout = item.layout;
  const minW = effectiveMinW(layout, cols);
  const type = item.type;

  if (type === "table") return cols;

  if (type === "chart") {
    if (layout.w >= 9) return cols;
    if (layout.w >= 6) {
      return cols >= 10 ? Math.max(Math.floor(cols / 2), minW) : cols;
    }
    if (cols <= 4) return cols;
  }

  return scaledWidth(layout, cols, lgCols);
}

function distributeRowWidths(
  cells: Array<{ id: string; w: number; layout: WidgetLayout }>,
  cols: number,
): void {
  let sum = cells.reduce((acc, cell) => acc + cell.w, 0);
  let leftover = cols - sum;
  for (let i = 0; leftover > 0; i += 1, leftover -= 1) {
    cells[i % cells.length].w += 1;
  }
  while (sum > cols) {
    const widest = cells.reduce((a, b) => (b.w > a.w ? b : a), cells[0]);
    const minW = effectiveMinW(widest.layout, cols);
    if (widest.w <= minW) break;
    widest.w -= 1;
    sum -= 1;
  }
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

  const rowGroups = groupIntoRows(items);
  let globalY = 0;

  for (const row of rowGroups) {
    const rowHeight = Math.max(...row.map(i => i.layout.h));
    const totalLgW = row.reduce((sum, i) => sum + i.layout.w, 0);
    const sameHeight = row.every(i => i.layout.h === row[0].layout.h);
    const isKpiStrip =
      row.length > 1 &&
      row.every(i => i.type === "kpi") &&
      sameHeight &&
      totalLgW <= lgCols &&
      rowHeight <= 4;

    if (isKpiStrip) {
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

    const cells: Array<{ id: string; w: number; layout: WidgetLayout }> = [];
    for (let i = 0; i < count; i++) {
      const item = row[itemIndex + i];
      cells.push({
        id: item.id,
        layout: item.layout,
        w: Math.max(baseW + (i < remainder ? 1 : 0), effectiveMinW(item.layout, cols)),
      });
    }
    distributeRowWidths(cells, cols);
    let rowX = 0;
    for (const cell of cells) {
      result.set(
        cell.id,
        layoutWithMeta(cell.layout, rowX, globalY + subRowY, cell.w, rowHeight),
      );
      rowX += cell.w;
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
  const subRows: Array<Array<{ item: LayoutItem; w: number }>> = [];
  let cur: Array<{ item: LayoutItem; w: number }> = [];
  let curW = 0;

  for (const item of row) {
    const w = Math.min(preferredWidgetWidth(item, cols, lgCols), cols);
    if (cur.length > 0 && curW + w > cols) {
      subRows.push(cur);
      cur = [];
      curW = 0;
    }
    cur.push({ item, w });
    curW += w;
  }
  if (cur.length > 0) subRows.push(cur);

  let subRowY = 0;
  for (const sub of subRows) {
    const cells = sub.map(cell => ({
      id: cell.item.id,
      w: cell.w,
      layout: cell.item.layout,
    }));
    distributeRowWidths(cells, cols);
    let x = 0;
    let subRowHeight = 0;
    for (const cell of cells) {
      const item = sub.find(s => s.item.id === cell.id)?.item;
      if (!item) continue;
      result.set(
        cell.id,
        layoutWithMeta(item.layout, x, globalY + subRowY, cell.w, item.layout.h),
      );
      x += cell.w;
      subRowHeight = Math.max(subRowHeight, item.layout.h);
    }
    subRowY += subRowHeight;
  }

  return subRowY;
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
    type: w.type,
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
