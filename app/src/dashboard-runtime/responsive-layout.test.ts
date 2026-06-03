import { describe, expect, it } from "vitest";
import { normalizeDashboardWidgetsLayouts } from "@mako/schemas";

function kpiWidget(id: string, x: number) {
  return {
    id,
    type: "kpi" as const,
    layouts: {
      lg: { x, y: 0, w: 3, h: 2 },
    },
  };
}

describe("normalizeDashboardWidgetsLayouts", () => {
  it("reflows a large-screen KPI row into balanced smaller rows", () => {
    const [first, second, third, fourth] = normalizeDashboardWidgetsLayouts([
      kpiWidget("visits", 0),
      kpiWidget("optins", 3),
      kpiWidget("quiz", 6),
      kpiWidget("demos", 9),
    ]);

    expect(first.layouts.md).toMatchObject({ x: 0, y: 0, w: 5, h: 2 });
    expect(second.layouts.md).toMatchObject({ x: 5, y: 0, w: 5, h: 2 });
    expect(third.layouts.md).toMatchObject({ x: 0, y: 2, w: 5, h: 2 });
    expect(fourth.layouts.md).toMatchObject({ x: 5, y: 2, w: 5, h: 2 });

    expect(first.layouts.sm).toMatchObject({ x: 0, y: 0, w: 3, h: 2 });
    expect(second.layouts.sm).toMatchObject({ x: 3, y: 0, w: 3, h: 2 });
    expect(third.layouts.sm).toMatchObject({ x: 0, y: 2, w: 3, h: 2 });
    expect(fourth.layouts.sm).toMatchObject({ x: 3, y: 2, w: 3, h: 2 });

    expect(first.layouts.xs).toMatchObject({ x: 0, y: 0, w: 4, h: 2 });
    expect(second.layouts.xs).toMatchObject({ x: 0, y: 2, w: 4, h: 2 });
    expect(third.layouts.xs).toMatchObject({ x: 0, y: 4, w: 4, h: 2 });
    expect(fourth.layouts.xs).toMatchObject({ x: 0, y: 6, w: 4, h: 2 });
  });

  it("preserves explicit user-authored breakpoint layouts", () => {
    const [first, second] = normalizeDashboardWidgetsLayouts([
      {
        ...kpiWidget("visits", 0),
        layouts: {
          lg: { x: 0, y: 0, w: 3, h: 2 },
          md: { x: 0, y: 8, w: 10, h: 2 },
        },
      },
      kpiWidget("optins", 3),
    ]);

    expect(first.layouts.md).toMatchObject({ x: 0, y: 8, w: 10, h: 2 });
    expect(second.layouts.md).toMatchObject({ x: 5, y: 0, w: 5, h: 2 });
  });

  it("replaces legacy auto-derived breakpoint layouts with smart fallbacks", () => {
    const [first, second, third, fourth] = normalizeDashboardWidgetsLayouts([
      {
        ...kpiWidget("visits", 0),
        layouts: {
          lg: { x: 0, y: 0, w: 3, h: 2 },
          md: { x: 0, y: 0, w: 3, h: 2 },
        },
      },
      {
        ...kpiWidget("optins", 3),
        layouts: {
          lg: { x: 3, y: 0, w: 3, h: 2 },
          md: { x: 3, y: 0, w: 3, h: 2 },
        },
      },
      {
        ...kpiWidget("quiz", 6),
        layouts: {
          lg: { x: 6, y: 0, w: 3, h: 2 },
          md: { x: 5, y: 0, w: 3, h: 2 },
        },
      },
      {
        ...kpiWidget("demos", 9),
        layouts: {
          lg: { x: 9, y: 0, w: 3, h: 2 },
          md: { x: 7, y: 0, w: 3, h: 2 },
        },
      },
    ]);

    expect(first.layouts.md).toMatchObject({ x: 0, y: 0, w: 5, h: 2 });
    expect(second.layouts.md).toMatchObject({ x: 5, y: 0, w: 5, h: 2 });
    expect(third.layouts.md).toMatchObject({ x: 0, y: 2, w: 5, h: 2 });
    expect(fourth.layouts.md).toMatchObject({ x: 5, y: 2, w: 5, h: 2 });
  });

  it("keeps generated layouts out of explicit breakpoint space", () => {
    const [first, second] = normalizeDashboardWidgetsLayouts([
      {
        ...kpiWidget("visits", 0),
        layouts: {
          lg: { x: 0, y: 0, w: 3, h: 2 },
          md: { x: 0, y: 0, w: 10, h: 2 },
        },
      },
      kpiWidget("optins", 3),
    ]);

    expect(first.layouts.md).toMatchObject({ x: 0, y: 0, w: 10, h: 2 });
    expect(second.layouts.md).toMatchObject({ x: 5, y: 2, w: 5, h: 2 });
  });

  it("preserves breakpoint layouts explicitly marked as custom", () => {
    const [first] = normalizeDashboardWidgetsLayouts([
      {
        ...kpiWidget("visits", 0),
        layouts: {
          lg: { x: 0, y: 0, w: 3, h: 2 },
          md: { x: 0, y: 0, w: 3, h: 2, custom: true },
        },
      },
    ]);

    expect(first.layouts.md).toMatchObject({
      x: 0,
      y: 0,
      w: 3,
      h: 2,
      custom: true,
    });
  });
});
