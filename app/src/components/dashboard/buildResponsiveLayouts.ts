import {
  getWidgetSizeDefaults,
  reflowLayout,
  type ReflowItem,
} from "@mako/schemas";

export interface ResponsiveGridItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW: number;
  minH: number;
}

interface BreakpointLayout {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  minW?: number;
  minH?: number;
  custom?: boolean;
}

/**
 * Minimal structural widget shape needed to build responsive layouts. Both the
 * store `DashboardWidget` and the embed spec widget satisfy this.
 */
export interface ReflowableWidget {
  id: string;
  type: "chart" | "kpi" | "table";
  vegaLiteSpec?: Record<string, unknown>;
  layout?: BreakpointLayout;
  layouts?: {
    lg?: BreakpointLayout;
    md?: BreakpointLayout;
    sm?: BreakpointLayout;
    xs?: BreakpointLayout;
  };
}

const SMALL_BREAKPOINTS = { md: 10, sm: 6, xs: 4 } as const;

function resolveVegaMark(widget: ReflowableWidget): string | undefined {
  const mark = widget.vegaLiteSpec?.mark;
  if (typeof mark === "string") return mark;
  return (mark as Record<string, unknown> | undefined)?.type as
    | string
    | undefined;
}

/**
 * Build the full set of react-grid-layout breakpoint layouts for a dashboard's
 * widgets. The `lg` breakpoint is the authored source of truth; `md`/`sm`/`xs`
 * are deterministically reflowed from it (rows wrap and tile cleanly) unless the
 * user has explicitly arranged a given breakpoint (its widgets carry
 * `layouts[bp].custom === true`), in which case the stored arrangement is kept.
 */
export function buildResponsiveGridLayouts(
  widgets: ReflowableWidget[],
  lgCols: number,
): Record<string, ResponsiveGridItem[]> {
  const result: Record<string, ResponsiveGridItem[]> = {};
  if (widgets.length === 0) return result;

  const lgItems: ReflowItem[] = [];
  const minsById: Record<string, { minW: number; minH: number }> = {};
  for (const w of widgets) {
    const sizeDefaults = getWidgetSizeDefaults(w.type, resolveVegaMark(w));
    const raw = w.layouts?.lg ?? w.layout;
    const minW = raw?.minW ?? sizeDefaults.minW;
    const minH = raw?.minH ?? sizeDefaults.minH;
    lgItems.push({
      id: w.id,
      layout: {
        x: typeof raw?.x === "number" ? raw.x : 0,
        y: typeof raw?.y === "number" ? raw.y : 0,
        w: typeof raw?.w === "number" ? raw.w : sizeDefaults.w,
        h: typeof raw?.h === "number" ? raw.h : sizeDefaults.h,
        minW,
        minH,
      },
    });
    minsById[w.id] = { minW, minH };
  }

  result.lg = lgItems.map(it => ({
    i: it.id,
    x: it.layout.x,
    y: it.layout.y,
    w: it.layout.w,
    h: it.layout.h,
    minW: it.layout.minW ?? 1,
    minH: it.layout.minH ?? 1,
  }));

  for (const [bp, targetCols] of Object.entries(SMALL_BREAKPOINTS) as [
    keyof typeof SMALL_BREAKPOINTS,
    number,
  ][]) {
    const isCustomBp = widgets.some(w => w.layouts?.[bp]?.custom === true);
    const reflowed = reflowLayout(lgItems, lgCols, targetCols);

    result[bp] = widgets.map(w => {
      const mins = minsById[w.id];
      const stored = w.layouts?.[bp];
      const lay =
        isCustomBp && stored && typeof stored === "object"
          ? stored
          : reflowed[w.id];
      return {
        i: w.id,
        x: lay?.x ?? 0,
        y: lay?.y ?? 0,
        w: lay?.w ?? mins.minW,
        h: lay?.h ?? mins.minH,
        minW: lay?.minW ?? mins.minW,
        minH: lay?.minH ?? mins.minH,
      };
    });
  }

  return result;
}
