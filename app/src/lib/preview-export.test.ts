import { describe, expect, it } from "vitest";
import { previewFilename, rowsToCsv, rowsToNdjson } from "./preview-export";

describe("rowsToCsv", () => {
  it("writes a header row then one line per row, in column order", () => {
    const csv = rowsToCsv(
      ["order_id", "customer"],
      [
        { order_id: 1, customer: "Acme" },
        { order_id: 2, customer: "Globex" },
      ],
    );
    expect(csv).toBe("order_id,customer\n1,Acme\n2,Globex\n");
  });

  it("quotes cells containing a comma, quote or newline, doubling quotes", () => {
    const csv = rowsToCsv(
      ["a"],
      [
        { a: "x,y" },
        { a: 'say "hi"' },
        { a: "line1\nline2" },
        { a: "carriage\rreturn" },
      ],
    );
    expect(csv).toBe(
      'a\n"x,y"\n"say ""hi"""\n"line1\nline2"\n"carriage\rreturn"\n',
    );
  });

  it("renders null and undefined as empty, and keeps false/0", () => {
    const csv = rowsToCsv(
      ["a", "b", "c", "d"],
      [{ a: null, b: undefined, c: false, d: 0 }],
    );
    expect(csv).toBe("a,b,c,d\n,,false,0\n");
  });

  it("JSON-encodes object and array cells", () => {
    const csv = rowsToCsv(["meta"], [{ meta: { k: 1 } }, { meta: [1, 2] }]);
    expect(csv).toBe('meta\n"{""k"":1}"\n"[1,2]"\n');
  });

  it("emits a cell for a column missing from a row", () => {
    const csv = rowsToCsv(["a", "b"], [{ a: 1 }]);
    expect(csv).toBe("a,b\n1,\n");
  });

  it("falls back to the union of row keys when no columns are given", () => {
    const csv = rowsToCsv([], [{ a: 1 }, { b: 2 }]);
    expect(csv).toBe("a,b\n1,\n,2\n");
  });

  it("returns an empty string when there is nothing to export", () => {
    expect(rowsToCsv([], [])).toBe("");
    expect(rowsToCsv(["a"], [])).toBe("a\n");
  });
});

describe("rowsToNdjson", () => {
  it("writes one JSON object per line, newline-terminated", () => {
    expect(rowsToNdjson([{ a: 1 }, { b: "x" }])).toBe('{"a":1}\n{"b":"x"}\n');
  });

  it("returns an empty string for no rows", () => {
    expect(rowsToNdjson([])).toBe("");
  });
});

describe("previewFilename", () => {
  it("names the file after the model and format", () => {
    expect(previewFilename("stg_orders", "csv")).toBe("stg_orders.csv");
    expect(previewFilename("stg_orders", "ndjson")).toBe("stg_orders.ndjson");
  });

  it("sanitises anything that isn't filename-safe", () => {
    expect(previewFilename("../../etc/passwd", "csv")).toBe("etc_passwd.csv");
    expect(previewFilename("a b/c:d", "csv")).toBe("a_b_c_d.csv");
  });

  it("falls back when there is no usable model name", () => {
    expect(previewFilename(undefined, "csv")).toBe("preview.csv");
    expect(previewFilename("", "csv")).toBe("preview.csv");
    expect(previewFilename("///", "csv")).toBe("preview.csv");
  });
});
