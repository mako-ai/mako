import { describe, expect, it } from "vitest";
import {
  buildNameMatchColumnEdges,
  mergeCatalogColumns,
} from "./column-lineage";

describe("mergeCatalogColumns", () => {
  it("fills missing types from the catalog and appends undocumented columns", () => {
    expect(
      mergeCatalogColumns(
        [
          { name: "id", description: "pk" },
          { name: "status", type: "text" },
        ],
        {
          columns: {
            id: { type: "integer" },
            created_at: { type: "timestamp", comment: "when" },
          },
        },
      ),
    ).toEqual([
      { name: "id", description: "pk", type: "integer" },
      { name: "status", type: "text" },
      { name: "created_at", type: "timestamp", description: "when" },
    ]);
  });
});

describe("buildNameMatchColumnEdges", () => {
  it("matches columns case-insensitively across table edges", () => {
    const edges = buildNameMatchColumnEdges(
      [
        {
          id: "source.raw.orders",
          columns: [{ name: "ID" }, { name: "amount" }],
        },
        {
          id: "model.jaffle.stg_orders",
          columns: [{ name: "id" }, { name: "status" }],
        },
        {
          id: "model.jaffle.fct_orders",
          columns: [{ name: "id" }, { name: "status" }],
        },
      ],
      [
        { source: "source.raw.orders", target: "model.jaffle.stg_orders" },
        {
          source: "model.jaffle.stg_orders",
          target: "model.jaffle.fct_orders",
        },
      ],
    );
    expect(edges).toEqual([
      {
        sourceNodeId: "source.raw.orders",
        sourceColumn: "ID",
        targetNodeId: "model.jaffle.stg_orders",
        targetColumn: "id",
        confidence: "name_match",
      },
      {
        sourceNodeId: "model.jaffle.stg_orders",
        sourceColumn: "id",
        targetNodeId: "model.jaffle.fct_orders",
        targetColumn: "id",
        confidence: "name_match",
      },
      {
        sourceNodeId: "model.jaffle.stg_orders",
        sourceColumn: "status",
        targetNodeId: "model.jaffle.fct_orders",
        targetColumn: "status",
        confidence: "name_match",
      },
    ]);
  });

  it("returns no edges when columns do not overlap", () => {
    expect(
      buildNameMatchColumnEdges(
        [
          { id: "a", columns: [{ name: "x" }] },
          { id: "b", columns: [{ name: "y" }] },
        ],
        [{ source: "a", target: "b" }],
      ),
    ).toEqual([]);
  });
});
