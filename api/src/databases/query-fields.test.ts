import { describe, expect, it } from "vitest";
import { normalizeQueryFields, resultRows } from "./query-fields";

describe("resultRows", () => {
  it("keeps a list, wraps one document, and makes nothing an empty list", () => {
    const rows = [{ a: 1 }];
    expect(resultRows(rows)).toBe(rows);
    expect(resultRows({ a: 1 })).toEqual([{ a: 1 }]);
    expect(resultRows(null)).toEqual([]);
    expect(resultRows(undefined)).toEqual([]);
  });
});

describe("normalizeQueryFields", () => {
  it("reads each engine's descriptor", () => {
    expect(
      normalizeQueryFields(
        [
          "bare",
          { name: "pg", dataTypeID: 23 },
          { name: "mysql", columnType: 253 },
          { columnName: "aliased", dataType: "text" },
          { originalName: "orig" },
          { type: "nameless" },
          null,
        ],
        [],
      ),
    ).toEqual([
      { name: "bare" },
      { name: "pg", type: "INTEGER" },
      { name: "mysql", type: "253" },
      { name: "aliased", type: "text" },
      { name: "orig", type: undefined },
    ]);
  });

  it("infers fields from the rows when the engine gave none", () => {
    const fields = normalizeQueryFields(undefined, [{ id: 1, name: "a" }]);
    expect(fields.map(field => field.name)).toEqual(["id", "name"]);
  });
});
