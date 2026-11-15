import { describe, expect, it } from "vitest";
import {
  buildGridModel,
  cardTitle,
  getFieldInfo,
  normalizeToArray,
  resultsToTsv,
  singleValueKpi,
  statusChipColor,
  type QueryResult,
} from "./grid-model";

const result = (over: Partial<QueryResult>): QueryResult => ({
  executedAt: "2026-01-01T00:00:00.000Z",
  resultCount: 0,
  ...over,
});

describe("normalizeToArray", () => {
  it("wraps primitives and objects", () => {
    expect(normalizeToArray(null)).toEqual([]);
    expect(normalizeToArray([1])).toEqual([1]);
    expect(normalizeToArray(5)).toEqual([{ value: 5 }]);
    expect(normalizeToArray({ a: 1 })).toEqual([{ a: 1 }]);
  });
});

describe("getFieldInfo", () => {
  it("de-duplicates repeated column names", () => {
    expect(getFieldInfo(["id", { name: "id" }, { name: "" }, "x"])).toEqual([
      { fieldId: "id", dataKey: "id", displayName: "id" },
      { fieldId: "id__1", dataKey: "id", displayName: "id" },
      { fieldId: "x", dataKey: "x", displayName: "x" },
    ]);
    expect(getFieldInfo(undefined)).toEqual([]);
  });
});

describe("buildGridModel", () => {
  it("returns nothing for no results", () => {
    expect(buildGridModel(null)).toEqual({
      columns: [],
      rows: [],
      hasFieldColumns: false,
    });
  });

  it("shows headers for an empty result with declared fields", () => {
    const model = buildGridModel(result({ results: [], fields: ["a", "b"] }));
    expect(model.hasFieldColumns).toBe(true);
    expect(model.columns.map(c => c.field)).toEqual(["__rowIndex", "a", "b"]);
    expect(model.rows).toEqual([]);
  });

  it("orders declared fields first, then extra keys", () => {
    const model = buildGridModel(
      result({ results: [{ b: 1, a: "x", extra: true }], fields: ["b", "a"] }),
    );
    expect(model.columns.map(c => c.field)).toEqual([
      "__rowIndex",
      "b",
      "a",
      "extra",
    ]);
    expect(model.columns[1].align).toBe("right"); // numeric
    expect(model.columns[2].align).toBe("left");
  });

  it("sorts digit-leading keys last without declared fields", () => {
    const model = buildGridModel(
      result({ results: [{ "2x": 1, b: 1, a: 1 }] }),
    );
    expect(model.columns.map(c => c.field)).toEqual([
      "__rowIndex",
      "b",
      "a",
      "2x",
    ]);
  });

  it("caps widths and keeps a 60px minimum", () => {
    const long = "y".repeat(100);
    const model = buildGridModel(result({ results: [{ s: long, n: 1 }] }));
    const byField = Object.fromEntries(model.columns.map(c => [c.field, c]));
    expect(byField.s.width).toBe(400);
    expect(byField.n.width).toBe(60);
  });

  it("makes row ids unique", () => {
    const model = buildGridModel(
      result({ results: [{ id: 1 }, { id: 1 }, { id: null }, { v: 2 }] }),
    );
    expect(model.rows.map(r => r.id)).toEqual([1, "1_1", "null", 3]);
  });

  it("wraps primitive rows as { value }", () => {
    const model = buildGridModel(result({ results: ["a"] }));
    expect(model.rows).toEqual([{ value: "a", id: 0 }]);
  });
});

describe("resultsToTsv", () => {
  it("serializes rows by header with tabs/newlines flattened", () => {
    const r = result({ results: [{ a: "x\ty", b: { k: 1 } }, { a: null }] });
    const { columns } = buildGridModel(r);
    expect(resultsToTsv(r, columns)).toBe(
      ["a\tb", 'x y\t{"k":1}', "\t"].join("\n"),
    );
  });

  it("returns null when there is nothing to copy", () => {
    expect(resultsToTsv(null, [])).toBeNull();
    expect(resultsToTsv(result({ results: [] }), [])).toBeNull();
  });
});

describe("card helpers", () => {
  it("maps status words to chip colors", () => {
    expect(statusChipColor(" Success ")).toBe("success");
    expect(statusChipColor("queued")).toBe("warning");
    expect(statusChipColor("hello")).toBeNull();
    expect(statusChipColor("")).toBeNull();
  });

  it("titles cards", () => {
    expect(cardTitle(undefined, 0)).toBe("Row 1");
    expect(cardTitle("", 2)).toBe("Row 3");
    expect(cardTitle({ a: 1 }, 0)).toBe('{"a":1}');
    expect(cardTitle(42, 0)).toBe("42");
  });

  it("detects a single-value KPI", () => {
    const cols = [{ field: "n", headerName: "Total" }];
    expect(singleValueKpi([{ n: 5 }], cols)).toEqual({
      label: "Total",
      value: "5",
    });
    expect(singleValueKpi([{ n: { x: 1 } }], cols)).toBeNull();
    expect(singleValueKpi([{ n: 1 }, { n: 2 }], cols)).toBeNull();
  });
});
