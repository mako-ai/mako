/**
 * The semantic catalog against the semantic manifest a real dbt-core 1.12.7
 * parse wrote (test-support/semantic-manifest.fixture.json): simple, ratio,
 * derived, cumulative and filtered metrics over two joined semantic models.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSemanticCatalog,
  findMetricByPhrase,
  metricKey,
  searchMetrics,
  unknownMetrics,
  type RawSemanticManifest,
} from "./semantic-manifest";

const FIXTURE = JSON.parse(
  readFileSync(
    join(__dirname, "..", "test-support", "semantic-manifest.fixture.json"),
    "utf8",
  ),
) as RawSemanticManifest;

const catalog = buildSemanticCatalog(FIXTURE);
const metric = (name: string) => catalog.metrics.find(m => m.name === name);

describe("buildSemanticCatalog", () => {
  it("lists every metric, sorted by name", () => {
    expect(catalog.metrics.map(m => m.name)).toEqual([
      "active_customers",
      "average_order_value",
      "cumulative_revenue",
      "enterprise_revenue",
      "orders",
      "revenue",
      "revenue_last_7_days",
      "revenue_per_customer",
    ]);
  });

  it("keeps what defines each type of metric", () => {
    expect(metric("revenue")).toEqual({
      name: "revenue",
      label: "Revenue",
      description: "Sum of order amounts.",
      type: "simple",
      measure: "order_total",
      filtered: false,
    });
    expect(metric("average_order_value")).toMatchObject({
      type: "ratio",
      numerator: "revenue",
      denominator: "orders",
    });
    expect(metric("revenue_per_customer")).toMatchObject({
      type: "derived",
      expr: "revenue / active_customers",
      inputMetrics: ["revenue", "active_customers"],
    });
    expect(metric("cumulative_revenue")).toMatchObject({ type: "cumulative" });
  });

  it("says when a definition carries its own filter", () => {
    expect(metric("enterprise_revenue")?.filtered).toBe(true);
    expect(metric("revenue")?.filtered).toBe(false);
  });

  it("names the semantic models and the relations they read", () => {
    expect(catalog.semanticModels).toEqual([
      {
        name: "orders",
        description: "One row per order.",
        relation: '"probe"."main"."orders"',
        database: "probe",
      },
      {
        name: "customers",
        description: "One row per customer.",
        relation: '"probe"."main"."customers"',
        database: "probe",
      },
    ]);
  });

  it("sees the time spine", () => {
    expect(catalog.hasTimeSpine).toBe(true);
    expect(
      buildSemanticCatalog({ ...FIXTURE, project_configuration: {} })
        .hasTimeSpine,
    ).toBe(false);
  });

  it("leaves private metrics out", () => {
    const metrics = (FIXTURE.metrics ?? []).map(raw =>
      raw.name === "orders"
        ? { ...raw, type_params: { ...raw.type_params, is_private: true } }
        : raw,
    );
    expect(
      buildSemanticCatalog({ ...FIXTURE, metrics }).metrics.map(m => m.name),
    ).not.toContain("orders");
  });

  it("survives an empty or partial manifest", () => {
    expect(buildSemanticCatalog({})).toEqual({
      metrics: [],
      semanticModels: [],
      savedQueries: [],
      hasTimeSpine: false,
    });
    expect(
      buildSemanticCatalog({ metrics: [{ description: "no name" }] }).metrics,
    ).toEqual([]);
  });
});

describe("lookup", () => {
  it("normalizes names and labels to one key", () => {
    expect(metricKey("Average Order Value")).toBe("average order value");
    expect(metricKey("average_order_value")).toBe("average order value");
  });

  it("searches name, label and description, every word required", () => {
    expect(searchMetrics(catalog, "revenue").map(m => m.name)).toEqual([
      "average_order_value",
      "cumulative_revenue",
      "enterprise_revenue",
      "revenue",
      "revenue_last_7_days",
      "revenue_per_customer",
    ]);
    expect(
      searchMetrics(catalog, "revenue enterprise").map(m => m.name),
    ).toEqual(["enterprise_revenue"]);
    expect(searchMetrics(catalog, "churn")).toEqual([]);
    expect(searchMetrics(catalog, undefined)).toHaveLength(8);
    expect(searchMetrics(catalog, "  ")).toHaveLength(8);
  });

  it("finds the metric a phrase names exactly, by name or label", () => {
    expect(findMetricByPhrase(catalog, ["Average order value"])?.name).toBe(
      "average_order_value",
    );
    expect(findMetricByPhrase(catalog, ["mrr", "REVENUE"])?.name).toBe(
      "revenue",
    );
    // A near miss is not a definition.
    expect(findMetricByPhrase(catalog, ["revenues"])).toBeUndefined();
    expect(findMetricByPhrase(catalog, [])).toBeUndefined();
  });

  it("reports the metrics a catalog does not define", () => {
    expect(unknownMetrics(catalog, ["revenue", "churn", "nps"])).toEqual([
      "churn",
      "nps",
    ]);
  });
});
