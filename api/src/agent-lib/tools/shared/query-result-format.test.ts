import { describe, expect, it } from "vitest";
import {
  QUERY_MAX_COLUMNS,
  QUERY_RESULT_DEFAULT_ROWS,
  QUERY_RESULT_MAX_ROWS,
  budgetDocumentsForModel,
  formatRowsForModel,
  isTabularRows,
} from "./query-result-format";

const rowsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `user ${i + 1}` }));

describe("formatRowsForModel", () => {
  it("renders a markdown table with column names once", () => {
    const result = formatRowsForModel(rowsOf(2));
    expect(result.table).toBe(
      "| id | name |\n|---|---|\n| 1 | user 1 |\n| 2 | user 2 |",
    );
    expect(result.columns).toEqual([{ name: "id" }, { name: "name" }]);
    expect(result).toMatchObject({ shownRows: 2, returnedRows: 2 });
    expect(result.truncated).toBeUndefined();
    expect(result.note).toBeUndefined();
  });

  it("follows driver field order and keeps types", () => {
    const result = formatRowsForModel([{ b: 2, a: 1 }], {
      fields: [
        { name: "a", type: "INT64" },
        { name: "b", dataTypeID: 23 },
      ],
    });
    expect(result.columns).toEqual([
      { name: "a", type: "INT64" },
      { name: "b" },
    ]);
    expect(result.table.split("\n")[2]).toBe("| 1 | 2 |");
  });

  it("unions keys across rows and tells NULL from a missing value", () => {
    const result = formatRowsForModel([{ a: null }, { a: 1, b: "x" }]);
    expect(result.table).toBe("| a | b |\n|---|---|\n| NULL |  |\n| 1 | x |");
  });

  it("escapes pipes and newlines so a cell cannot break the table", () => {
    const result = formatRowsForModel([{ note: "a|b\nc" }]);
    expect(result.table.split("\n")[2]).toBe("| a\\|b\\nc |");
  });

  it("shortens long cells, never drops the column", () => {
    const result = formatRowsForModel([
      { text: "t".repeat(1000), json: { blob: "j".repeat(2000) }, id: 1 },
    ]);
    const cells = result.table.split("\n")[2];
    expect(cells.length).toBeLessThan(900);
    expect(cells).toMatch(/\[\+800 chars\]/);
    expect(result.columns.map(c => c.name)).toEqual(["text", "json", "id"]);
    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/2 long cell value\(s\) shortened/);
  });

  it("formats dates, bigints, binary and BSON-like values readably", () => {
    const objectId = { _bsontype: "ObjectId", toString: () => "64f0c0ffee" };
    const result = formatRowsForModel([
      {
        at: new Date("2026-10-01T00:00:00Z"),
        big: 2n ** 70n,
        bin: new Uint8Array(3),
        id: objectId,
      },
    ]);
    expect(result.table.split("\n")[2]).toBe(
      "| 2026-10-01T00:00:00.000Z | 1180591620717411303424 | <binary 3 bytes> | 64f0c0ffee |",
    );
  });

  it("shows the default row count and points at more", () => {
    const result = formatRowsForModel(rowsOf(500), {
      moreHint: "Ask for more.",
    });
    expect(result.shownRows).toBe(QUERY_RESULT_DEFAULT_ROWS);
    expect(result.returnedRows).toBe(500);
    expect(result.note).toBe("Showing 50 of 500 rows. Ask for more.");
  });

  it("clamps maxRows and stops at the char budget", () => {
    expect(formatRowsForModel(rowsOf(500), { maxRows: 9999 }).shownRows).toBe(
      QUERY_RESULT_MAX_ROWS,
    );
    const wide = Array.from({ length: 50 }, () => ({ v: "x".repeat(150) }));
    const result = formatRowsForModel(wide, { maxChars: 1_000 });
    expect(result.table.length).toBeLessThanOrEqual(1_000);
    expect(result.shownRows).toBeGreaterThan(0);
    expect(result.shownRows).toBeLessThan(50);
  });

  it("always shows the first row, even past the budget", () => {
    const result = formatRowsForModel([{ v: "y".repeat(150) }], {
      maxChars: 10,
    });
    expect(result.shownRows).toBe(1);
  });

  it("says when the query produced more rows than were kept", () => {
    const result = formatRowsForModel(rowsOf(2), { totalRowCount: 9000 });
    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/produced 9000 rows; 2 were kept/);
  });

  it("lists columns beyond the column cap instead of dropping them silently", () => {
    const row = Object.fromEntries(
      Array.from({ length: QUERY_MAX_COLUMNS + 2 }, (_, i) => [`c${i}`, i]),
    );
    const result = formatRowsForModel([row]);
    expect(result.columns).toHaveLength(QUERY_MAX_COLUMNS);
    expect(result.note).toMatch(/2 more column\(s\) not shown: c100, c101/);
  });

  it("reports an empty result", () => {
    const result = formatRowsForModel([], { fields: [{ name: "id" }] });
    expect(result.table).toBe("| id |\n|---|");
    expect(result.note).toBe("No rows returned.");
  });

  it("is deterministic", () => {
    const rows = [{ a: { z: 1, y: [1, 2] }, b: "x" }];
    expect(formatRowsForModel(rows)).toEqual(formatRowsForModel(rows));
  });
});

describe("isTabularRows", () => {
  it("accepts arrays of plain objects only", () => {
    expect(isTabularRows([])).toBe(true);
    expect(isTabularRows([{ a: 1 }])).toBe(true);
    expect(isTabularRows([[1, 2]])).toBe(false);
    expect(isTabularRows([1])).toBe(false);
    expect(isTabularRows({ a: 1 })).toBe(false);
    expect(isTabularRows([new Date()])).toBe(false);
  });
});

describe("budgetDocumentsForModel", () => {
  it("keeps whole documents until the budget is spent", () => {
    const docs = Array.from({ length: 20 }, (_, i) => ({
      _id: i,
      body: "d".repeat(100),
    }));
    const result = budgetDocumentsForModel(docs, { maxChars: 500 });
    expect(result.documents[0]).toBe(docs[0]);
    expect(result.shown).toBeLessThan(20);
    expect(result.note).toBe(`Showing ${result.shown} of 20 documents.`);
  });

  it("returns everything that fits, with no note", () => {
    const result = budgetDocumentsForModel([{ a: 1 }, { a: 2 }]);
    expect(result.shown).toBe(2);
    expect(result.note).toBeUndefined();
  });
});
