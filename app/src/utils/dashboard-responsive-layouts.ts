import {
  deriveResponsiveLayouts,
  getWidgetSizeDefaults,
  type WidgetLayout,
} from "@mako/schemas";

type DashboardBreakpoint = "lg" | "md" | "sm" | "xs";

const BREAKPOINTS: DashboardBreakpoint[] = ["lg", "md", "sm", "xs"];
const BREAKPOINT_COLS: Record<DashboardBreakpoint, number> = {
  lg: 12,
  md: 10,
  sm: 6,
  xs: 4,
};

interface ResponsiveWidgetInput {
  id: string;
  type: "chart" | "kpi" | "table";
  vegaLiteSpec?: Record<string, unknown>;
  layouts?: Partial<Record<DashboardBreakpoint, Partial<WidgetLayout>>>;
  layout?: Partial<WidgetLayout>;
}

interface WidgetModel {
  id: string;
  type: ResponsiveWidgetInput["type"];
  lg: WidgetLayout;
  explicitLayouts?: ResponsiveWidgetInput["layouts"];
}

type LayoutByWidgetId = Record<string, WidgetLayout>;
type AutoDerivedByWidgetId = Record<string, boolean>;
type LayoutsByBreakpoint = Record<DashboardBreakpoint, LayoutByWidgetId>;

export function buildSmartResponsiveLayouts(
  widgets: ResponsiveWidgetInput[],
): LayoutsByBreakpoint {
  const models = widgets.map(buildWidgetModel);

  const layoutsByBreakpoint: LayoutsByBreakpoint = {
    lg: {},
    md: {},
    sm: {},
    xs: {},
  };
  const autoDerivedByBreakpoint: Record<
    Exclude<DashboardBreakpoint, "lg">,
    AutoDerivedByWidgetId
  > = {
    md: {},
    sm: {},
    xs: {},
  };

  for (const model of models) {
    layoutsByBreakpoint.lg[model.id] = model.lg;
    const derived = deriveResponsiveLayouts(model.lg);
    for (const bp of BREAKPOINTS) {
      if (bp === "lg") continue;

      const explicit = model.explicitLayouts?.[bp];
      const derivedBp = derived[bp] ?? model.lg;
      if (explicit && typeof explicit === "object") {
        const normalized = normalizeLayout(explicit, derivedBp);
        layoutsByBreakpoint[bp][model.id] = normalized;
        autoDerivedByBreakpoint[bp][model.id] =
          normalized.custom === true
            ? false
            : isLegacyProportionalLayout(
                model.lg,
                normalized,
                BREAKPOINT_COLS[bp],
              ) || areLayoutsEqual(normalized, derivedBp);
      } else {
        layoutsByBreakpoint[bp][model.id] = derivedBp;
        autoDerivedByBreakpoint[bp][model.id] = true;
      }
    }
  }

  applySmartKpiFallback(
    "md",
    models,
    layoutsByBreakpoint.md,
    autoDerivedByBreakpoint.md,
  );
  applySmartKpiFallback(
    "sm",
    models,
    layoutsByBreakpoint.sm,
    autoDerivedByBreakpoint.sm,
  );
  applySmartKpiFallback(
    "xs",
    models,
    layoutsByBreakpoint.xs,
    autoDerivedByBreakpoint.xs,
  );

  return layoutsByBreakpoint;
}

function buildWidgetModel(widget: ResponsiveWidgetInput): WidgetModel {
  const vegaMark =
    typeof widget.vegaLiteSpec?.mark === "string"
      ? widget.vegaLiteSpec.mark
      : ((widget.vegaLiteSpec?.mark as Record<string, unknown> | undefined)
          ?.type as string | undefined);
  const defaults = getWidgetSizeDefaults(widget.type, vegaMark);
  const fallbackLg: WidgetLayout = {
    x: 0,
    y: 0,
    w: defaults.w,
    h: defaults.h,
    minW: defaults.minW,
    minH: defaults.minH,
  };
  const lg = normalizeLayout(widget.layouts?.lg ?? widget.layout, fallbackLg);
  return {
    id: widget.id,
    type: widget.type,
    lg,
    explicitLayouts: widget.layouts,
  };
}

function normalizeLayout(
  raw: Partial<WidgetLayout> | undefined,
  fallback: WidgetLayout,
): WidgetLayout {
  return {
    x: typeof raw?.x === "number" ? raw.x : fallback.x,
    y: typeof raw?.y === "number" ? raw.y : fallback.y,
    w: typeof raw?.w === "number" ? raw.w : fallback.w,
    h: typeof raw?.h === "number" ? raw.h : fallback.h,
    minW: typeof raw?.minW === "number" ? raw.minW : fallback.minW,
    minH: typeof raw?.minH === "number" ? raw.minH : fallback.minH,
    custom: raw?.custom === true ? true : undefined,
  };
}

function areLayoutsEqual(a: WidgetLayout, b: WidgetLayout): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.w === b.w &&
    a.h === b.h &&
    (a.minW ?? null) === (b.minW ?? null) &&
    (a.minH ?? null) === (b.minH ?? null)
  );
}

function scaledWidth(
  layout: WidgetLayout,
  cols: number,
  lgCols: number = BREAKPOINT_COLS.lg,
): number {
  const minW = Math.min(Math.max(layout.minW ?? 1, 1), cols);
  const scale = cols / lgCols;
  return Math.min(Math.max(Math.round(layout.w * scale), minW), cols);
}

function isLegacyProportionalLayout(
  lg: WidgetLayout,
  bp: WidgetLayout,
  cols: number,
): boolean {
  const expectedW = scaledWidth(lg, cols);
  const expectedX = Math.min(
    Math.round(lg.x * (cols / BREAKPOINT_COLS.lg)),
    Math.max(0, cols - expectedW),
  );
  return bp.y === lg.y && bp.w === expectedW && bp.x === expectedX;
}

function applySmartKpiFallback(
  breakpoint: Exclude<DashboardBreakpoint, "lg">,
  models: WidgetModel[],
  layoutsForBreakpoint: LayoutByWidgetId,
  autoDerivedFlags: AutoDerivedByWidgetId,
) {
  const preferredPerRow = breakpoint === "md" ? 2 : breakpoint === "sm" ? 2 : 1;

  const cols = BREAKPOINT_COLS[breakpoint];

  const modelsByLgY = new Map<number, WidgetModel[]>();
  for (const model of models) {
    const row = model.lg.y;
    const existing = modelsByLgY.get(row);
    if (existing) {
      existing.push(model);
    } else {
      modelsByLgY.set(row, [model]);
    }
  }

  for (const bandModels of modelsByLgY.values()) {
    if (bandModels.length < 3) continue;
    if (!bandModels.every(model => model.type === "kpi")) continue;
    if (!bandModels.every(model => autoDerivedFlags[model.id])) continue;

    const sorted = [...bandModels].sort((a, b) => a.lg.x - b.lg.x);
    const perRow = resolvePerRow(sorted, cols, preferredPerRow);
    if (perRow < 1) continue;
    const spans = splitColumns(cols, perRow);
    if (spans.length === 0) continue;

    const baseY = Math.min(
      ...sorted.map(model => layoutsForBreakpoint[model.id]?.y ?? 0),
    );
    const rowHeight = Math.max(
      ...sorted.map(model => layoutsForBreakpoint[model.id]?.h ?? model.lg.h),
      1,
    );

    sorted.forEach((model, index) => {
      const existing = layoutsForBreakpoint[model.id];
      if (!existing) return;

      const col = index % perRow;
      const row = Math.floor(index / perRow);
      const targetSpan = spans[col];
      layoutsForBreakpoint[model.id] = {
        ...existing,
        x: targetSpan.x,
        y: baseY + row * rowHeight,
        w: Math.max(existing.minW ?? 1, targetSpan.w),
      };
    });
  }
}

function splitColumns(
  cols: number,
  count: number,
): Array<{ x: number; w: number }> {
  if (cols <= 0 || count <= 0) return [];
  const base = Math.floor(cols / count);
  const remainder = cols % count;
  const spans: Array<{ x: number; w: number }> = [];
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    const width = base + (i < remainder ? 1 : 0);
    spans.push({ x: cursor, w: width });
    cursor += width;
  }
  return spans;
}

function resolvePerRow(
  models: WidgetModel[],
  cols: number,
  preferredPerRow: number,
): number {
  for (
    let perRow = Math.min(models.length, preferredPerRow);
    perRow >= 1;
    perRow -= 1
  ) {
    const spans = splitColumns(cols, perRow);
    const minWViolation = models.some((model, index) => {
      const targetSpan = spans[index % perRow];
      return (model.lg.minW ?? 1) > targetSpan.w;
    });
    if (!minWViolation) return perRow;
  }

  return 1;
}
