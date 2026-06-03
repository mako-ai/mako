import { describe, it, expect } from "vitest";
import {
  reflowLayout,
  resolveLayoutCollisions,
  type ReflowItem,
} from "@mako/schemas";
import {
  buildResponsiveGridLayouts,
  type ReflowableWidget,
} from "./buildResponsiveLayouts";

type Rect = { x: number; y: number; w: number; h: number };

function hasOverlap(rects: Rect[]): boolean {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (
        a.x < b.x + b.w &&
        b.x < a.x + a.w &&
        a.y < b.y + b.h &&
        b.y < a.y + a.h
      ) {
        return true;
      }
    }
  }
  return false;
}

function kpis(): ReflowItem[] {
  return [0, 1, 2, 3].map(i => ({
    id: `k${i}`,
    type: "kpi" as const,
    layout: { x: i * 3, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
  }));
}

describe("reflowLayout", () => {
  it("turns a row of 4 KPIs into a clean 2×2 of half-width cards on md", () => {
    const r = reflowLayout(kpis(), 12, 10);
    expect(r.k0).toMatchObject({ x: 0, y: 0, w: 5 });
    expect(r.k1).toMatchObject({ x: 5, y: 0, w: 5 });
    expect(r.k2).toMatchObject({ x: 0, y: 2, w: 5 });
    expect(r.k3).toMatchObject({ x: 5, y: 2, w: 5 });
  });

  it("never overlaps or overflows for 4 KPIs at any breakpoint", () => {
    for (const cols of [10, 6, 4]) {
      const r = reflowLayout(kpis(), 12, cols);
      const rects = Object.values(r);
      expect(hasOverlap(rects)).toBe(false);
      expect(rects.every(c => c.x >= 0 && c.x + c.w <= cols)).toBe(true);
    }
  });

  it("keeps a wide + narrow chart side-by-side on md (type-aware widths)", () => {
    const items: ReflowItem[] = [
      {
        id: "wide",
        type: "chart",
        layout: { x: 0, y: 0, w: 8, h: 5, minW: 4 },
      },
      {
        id: "narrow",
        type: "chart",
        layout: { x: 8, y: 0, w: 4, h: 5, minW: 4 },
      },
    ];
    const r = reflowLayout(items, 12, 10);
    expect(r.wide.y).toBe(0);
    expect(r.narrow.y).toBe(0);
    expect(r.wide.x).toBe(0);
    expect(r.narrow.x).toBe(r.wide.w);
    expect(r.wide.w + r.narrow.w).toBeLessThanOrEqual(10);
  });

  it("stacks half-width charts full-width on the narrowest grid", () => {
    const items: ReflowItem[] = [0, 1].map(i => ({
      id: `c${i}`,
      type: "chart" as const,
      layout: { x: i * 6, y: 0, w: 6, h: 5, minW: 4, minH: 3 },
    }));
    const r = reflowLayout(items, 12, 4);
    expect(r.c0).toMatchObject({ x: 0, y: 0, w: 4 });
    expect(r.c1).toMatchObject({ x: 0, w: 4 });
    expect(r.c1.y).toBeGreaterThan(r.c0.y);
  });

  it("forces tables to full width", () => {
    const items: ReflowItem[] = [
      { id: "t", type: "table", layout: { x: 0, y: 0, w: 8, h: 5, minW: 4 } },
    ];
    expect(reflowLayout(items, 12, 10).t.w).toBe(10);
  });

  it("returns the layout unchanged when the target grid is not narrower", () => {
    const r = reflowLayout(kpis(), 12, 12);
    expect(r.k3).toMatchObject({ x: 9, y: 0, w: 3 });
  });
});

describe("resolveLayoutCollisions", () => {
  it("pushes a colliding item straight down", () => {
    const out = resolveLayoutCollisions([
      { id: "a", layout: { x: 0, y: 0, w: 4, h: 2 } },
      { id: "b", layout: { x: 0, y: 0, w: 4, h: 2 } },
    ]);
    expect(out.a).toMatchObject({ x: 0, y: 0 });
    expect(out.b.y).toBeGreaterThanOrEqual(2);
  });

  it("leaves a non-overlapping layout untouched", () => {
    const out = resolveLayoutCollisions([
      { id: "a", layout: { x: 0, y: 0, w: 4, h: 2 } },
      { id: "b", layout: { x: 4, y: 0, w: 4, h: 2 } },
    ]);
    expect(out.b).toMatchObject({ x: 4, y: 0 });
  });
});

describe("buildResponsiveGridLayouts", () => {
  const kpiWidgets: ReflowableWidget[] = [0, 1, 2, 3].map(i => ({
    id: `k${i}`,
    type: "kpi",
    layouts: { lg: { x: i * 3, y: 0, w: 3, h: 2, minW: 2, minH: 2 } },
  }));

  it("reflows md/sm/xs from lg without overlaps", () => {
    const layouts = buildResponsiveGridLayouts(kpiWidgets, 12);
    for (const bp of ["md", "sm", "xs"]) {
      expect(hasOverlap(layouts[bp])).toBe(false);
    }
    // lg is the authored source of truth, kept as-is.
    expect(layouts.lg.map(i => i.x)).toEqual([0, 3, 6, 9]);
  });

  it("honors a user-customized breakpoint and resolves collisions for new widgets", () => {
    const widgets: ReflowableWidget[] = [
      {
        id: "a",
        type: "kpi",
        layouts: {
          lg: { x: 0, y: 0, w: 3, h: 2 },
          md: { x: 0, y: 0, w: 10, h: 2, custom: true },
        },
      },
      // Added later (e.g. by the agent): only has lg, must not overlap "a" on md.
      { id: "b", type: "kpi", layouts: { lg: { x: 3, y: 0, w: 3, h: 2 } } },
    ];
    const layouts = buildResponsiveGridLayouts(widgets, 12);
    const md = layouts.md;
    expect(hasOverlap(md)).toBe(false);
    expect(md.find(i => i.i === "a")).toMatchObject({ x: 0, y: 0, w: 10 });
  });

  it("respects a custom lg column count", () => {
    const widgets: ReflowableWidget[] = [
      { id: "a", type: "kpi", layouts: { lg: { x: 0, y: 0, w: 12, h: 2 } } },
      { id: "b", type: "kpi", layouts: { lg: { x: 12, y: 0, w: 12, h: 2 } } },
    ];
    const layouts = buildResponsiveGridLayouts(widgets, 24);
    expect(layouts.lg.map(i => i.x)).toEqual([0, 12]);
    expect(hasOverlap(layouts.md)).toBe(false);
  });
});
