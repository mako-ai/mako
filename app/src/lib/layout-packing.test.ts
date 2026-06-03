import { describe, expect, it } from "vitest";
import {
  BREAKPOINT_COLS,
  buildGridLayoutsFromWidgets,
  isLegacyProportionalLayout,
  packLayoutsForBreakpoint,
} from "@mako/schemas";

describe("packLayoutsForBreakpoint", () => {
  it("packs four KPIs in one lg row without overlapping on md", () => {
    const items = [0, 1, 2, 3].map(i => ({
      id: `kpi-${i}`,
      type: "kpi" as const,
      layout: { x: i * 3, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
    }));
    const packed = packLayoutsForBreakpoint(items, BREAKPOINT_COLS.md);
    const layouts = items.map(i => {
      const layout = packed.get(i.id);
      if (!layout) throw new Error(`missing layout for ${i.id}`);
      return layout;
    });

    for (const layout of layouts) {
      expect(layout.x + layout.w).toBeLessThanOrEqual(BREAKPOINT_COLS.md);
    }
    expect(layouts.every(l => l.y === 0)).toBe(true);
  });

  it("wraps four KPIs into two rows of two on sm", () => {
    const items = [0, 1, 2, 3].map(i => ({
      id: `kpi-${i}`,
      type: "kpi" as const,
      layout: { x: i * 3, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
    }));
    const packed = packLayoutsForBreakpoint(items, BREAKPOINT_COLS.sm);
    const layouts = items.map(i => {
      const layout = packed.get(i.id);
      if (!layout) throw new Error(`missing layout for ${i.id}`);
      return layout;
    });
    expect(layouts[0]).toMatchObject({ x: 0, y: 0, w: 3 });
    expect(layouts[1]).toMatchObject({ x: 3, y: 0, w: 3 });
    expect(layouts[2]).toMatchObject({ x: 0, y: 2, w: 3 });
    expect(layouts[3]).toMatchObject({ x: 3, y: 2, w: 3 });
  });

  it("keeps full-width chart on its own row", () => {
    const items = [
      {
        id: "kpi",
        type: "kpi" as const,
        layout: { x: 0, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
      },
      {
        id: "chart",
        type: "chart" as const,
        layout: { x: 0, y: 2, w: 12, h: 5, minW: 4, minH: 3 },
      },
    ];
    const packed = packLayoutsForBreakpoint(items, BREAKPOINT_COLS.sm);
    expect(packed.get("chart")).toMatchObject({ x: 0, w: 6 });
    const chart = packed.get("chart");
    const kpi = packed.get("kpi");
    expect(chart).toBeDefined();
    expect(kpi).toBeDefined();
    if (chart && kpi) {
      expect(chart.y).toBeGreaterThanOrEqual(kpi.y);
    }
  });
});

describe("isLegacyProportionalLayout", () => {
  it("detects old scaled layouts", () => {
    const lg = { x: 6, y: 0, w: 3, h: 2, minW: 2 };
    const md = { x: 5, y: 0, w: 3, h: 2, minW: 2 };
    expect(isLegacyProportionalLayout(lg, md, BREAKPOINT_COLS.md)).toBe(true);
  });

  it("respects userSet overrides", () => {
    const lg = { x: 0, y: 0, w: 3, h: 2 };
    const md = { x: 0, y: 4, w: 10, h: 2, userSet: true };
    expect(isLegacyProportionalLayout(lg, md, BREAKPOINT_COLS.md)).toBe(false);
  });
});

describe("buildGridLayoutsFromWidgets", () => {
  it("uses userSet md layout instead of packed layout", () => {
    const widgets = [
      {
        id: "a",
        layouts: {
          lg: { x: 0, y: 0, w: 3, h: 2 },
          md: { x: 0, y: 10, w: 10, h: 2, userSet: true },
        },
      },
      {
        id: "b",
        layouts: {
          lg: { x: 3, y: 0, w: 3, h: 2 },
        },
      },
    ];
    const grids = buildGridLayoutsFromWidgets(widgets);
    expect(grids.md?.find(i => i.i === "a")).toMatchObject({ y: 10, w: 10 });
  });
});
