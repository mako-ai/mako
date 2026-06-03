import { describe, expect, it } from "vitest";
import { deriveResponsiveLayouts } from "@mako/schemas";
import { buildSmartResponsiveLayouts } from "./dashboard-responsive-layouts";

function kpiWidget(
  id: string,
  x: number,
  layoutOverrides?: {
    md?: { x: number; y: number; w: number; h: number; custom?: boolean };
  },
) {
  return {
    id,
    type: "kpi" as const,
    layouts: {
      lg: { x, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
      ...(layoutOverrides?.md ? { md: layoutOverrides.md } : {}),
    },
  };
}

describe("buildSmartResponsiveLayouts", () => {
  it("reflows fallback KPI rows into a balanced md grid", () => {
    const layouts = buildSmartResponsiveLayouts([
      kpiWidget("visits", 0),
      kpiWidget("optins", 3),
      kpiWidget("quiz", 6),
      kpiWidget("demos", 9),
    ]);

    expect(layouts.md.visits).toMatchObject({ x: 0, y: 0, w: 5, h: 2 });
    expect(layouts.md.optins).toMatchObject({ x: 5, y: 0, w: 5, h: 2 });
    expect(layouts.md.quiz).toMatchObject({ x: 0, y: 2, w: 5, h: 2 });
    expect(layouts.md.demos).toMatchObject({ x: 5, y: 2, w: 5, h: 2 });
  });

  it("preserves custom breakpoint layouts authored by the user", () => {
    const layouts = buildSmartResponsiveLayouts([
      kpiWidget("visits", 0, {
        md: { x: 0, y: 7, w: 10, h: 2, custom: true },
      }),
      kpiWidget("optins", 3),
    ]);

    expect(layouts.md.visits).toMatchObject({ x: 0, y: 7, w: 10, h: 2 });
    expect(layouts.md.optins).toMatchObject({ x: 3, y: 0, w: 3, h: 2 });
  });

  it("treats legacy proportional md layouts as fallback candidates", () => {
    const lg = { x: 6, y: 0, w: 3, h: 2, minW: 2, minH: 2 };
    const legacyMd = deriveResponsiveLayouts(lg).md;
    const layouts = buildSmartResponsiveLayouts([
      {
        id: "quiz",
        type: "kpi" as const,
        layouts: { lg, md: legacyMd },
      },
      kpiWidget("demos", 9),
      kpiWidget("optins", 0),
    ]);

    expect(layouts.md.quiz).toMatchObject({ x: 5, y: 0, w: 5, h: 2 });
  });
});
