import { describe, expect, it } from "vitest";
import { compile } from "vega-lite";
import { buildChartRenderPlan } from "./chart-render-planner";

describe("buildChartRenderPlan", () => {
  it("auto-enhances simple multi-series line charts", () => {
    const lineSpec = {
      mark: { type: "line" },
      encoding: {
        x: { field: "day", type: "temporal" },
        y: { field: "value", type: "quantitative" },
        color: { field: "country", type: "nominal" },
      },
    };

    const plan = buildChartRenderPlan({
      spec: lineSpec,
      data: [
        { day: "2026-01-01", country: "FR", value: 10 },
        { day: "2026-01-01", country: "ES", value: 7 },
      ],
      enableSelection: false,
      activeSelection: null,
    });

    expect(Array.isArray(plan.spec.layer)).toBe(true);
    expect(plan.tooltipMeta?.seriesFields).toEqual(["ES", "FR"]);
    expect(plan.tooltipMeta?.xField).toBe("day");
  });

  it("auto-enhances simple stacked bar charts with rich tooltip meta", () => {
    const barSpec = {
      mark: { type: "bar" },
      encoding: {
        x: { field: "step", type: "ordinal" },
        y: { field: "count", type: "quantitative", stack: "zero" },
        color: { field: "country", type: "nominal" },
      },
    };

    const plan = buildChartRenderPlan({
      spec: barSpec,
      data: [
        { step: "A", country: "FR", count: 10 },
        { step: "A", country: "ES", count: 8 },
      ],
      enableSelection: true,
      activeSelection: null,
    });

    expect(Array.isArray(plan.spec.layer)).toBe(true);
    const layers = plan.spec.layer as Array<Record<string, any>>;
    expect(layers[0].params?.some((p: any) => p.name === "crossfilter")).toBe(
      true,
    );
    expect(plan.tooltipMeta?.seriesFields).toEqual(["ES", "FR"]);
  });

  it("auto-enhances stacked bars when color is produced by fold transform", () => {
    const barSpec = {
      transform: [
        {
          fold: ["comparis", "agg", "ios"],
          as: ["client", "count"],
        },
      ],
      mark: { type: "bar" },
      encoding: {
        x: { field: "week", type: "ordinal" },
        y: { field: "count", type: "quantitative", stack: "zero" },
        color: { field: "client", type: "nominal" },
        tooltip: [
          { field: "week", type: "ordinal" },
          { field: "comparis", type: "quantitative" },
          { field: "agg", type: "quantitative" },
          { field: "ios", type: "quantitative" },
          { field: "total", type: "quantitative" },
        ],
      },
    };

    const plan = buildChartRenderPlan({
      spec: barSpec,
      data: [{ week: "2025-W50", comparis: 10, agg: 7, ios: 2, total: 19 }],
      enableSelection: false,
      activeSelection: null,
    });

    expect(Array.isArray(plan.spec.layer)).toBe(true);
    expect(plan.tooltipMeta?.seriesFields).toEqual(["comparis", "agg", "ios"]);
  });

  it("adds crossfilter opacity to layered bar target", () => {
    const barSpec = {
      transform: [{ fold: ["comparis", "agg"], as: ["client", "count"] }],
      mark: { type: "bar" },
      encoding: {
        x: { field: "week", type: "ordinal" },
        y: { field: "count", type: "quantitative", stack: "zero" },
        color: { field: "client", type: "nominal" },
      },
    };

    const plan = buildChartRenderPlan({
      spec: barSpec,
      data: [{ week: "2025-W50", comparis: 10, agg: 7 }],
      enableSelection: true,
      activeSelection: null,
    });

    const layers = (plan.spec.layer || []) as Array<Record<string, any>>;
    const selectableBar = layers.find(l =>
      l?.params?.some((p: any) => p.name === "crossfilter"),
    );
    expect(selectableBar).toBeDefined();
    expect(selectableBar?.encoding?.opacity?.condition?.param).toBe(
      "crossfilter",
    );
    expect(selectableBar?.encoding?.opacity?.value).toBe(0.3);
  });

  it("removes duplicate selection names to avoid signal collisions", () => {
    const spec = {
      params: [
        {
          name: "__mako_tooltip",
          select: { type: "point", fields: ["x"] },
        },
      ],
      layer: [
        {
          mark: { type: "bar" },
          params: [
            {
              name: "__mako_tooltip",
              select: { type: "point", fields: ["x"] },
            },
          ],
          encoding: {
            x: { field: "x", type: "ordinal" },
            y: { field: "y", type: "quantitative" },
          },
        },
      ],
    };

    const plan = buildChartRenderPlan({
      spec,
      data: [{ x: "A", y: 1 }],
      enableSelection: false,
      activeSelection: null,
    });

    const rootParams = (plan.spec.params || []) as Array<Record<string, any>>;
    const layerParams = (plan.spec.layer?.[0]?.params || []) as Array<
      Record<string, any>
    >;
    const tooltipParamCount =
      rootParams.filter(p => p.name === "__mako_tooltip").length +
      layerParams.filter(p => p.name === "__mako_tooltip").length;

    expect(tooltipParamCount).toBe(1);
  });

  it("produces a Vega-Lite spec that compiles", () => {
    const spec = {
      mark: { type: "bar" },
      encoding: {
        x: { field: "step", type: "ordinal" },
        y: { field: "count", type: "quantitative" },
        color: { field: "country", type: "nominal" },
      },
    };

    const plan = buildChartRenderPlan({
      spec,
      data: [
        { step: "A", country: "FR", count: 10 },
        { step: "A", country: "ES", count: 8 },
      ],
      enableSelection: true,
      activeSelection: null,
    });

    expect(() =>
      compile({
        ...plan.spec,
        $schema: "https://vega.github.io/schema/vega-lite/v6.json",
        data: { values: [] },
      } as any),
    ).not.toThrow();
  });
});
