import { describe, expect, it } from "vitest";
import { ensureShowJsonOutput, parseShowPreview } from "./show-preview";

describe("ensureShowJsonOutput", () => {
  it("appends --output json for show when missing", () => {
    expect(
      ensureShowJsonOutput(["show", "--select", "stg_orders", "--limit", "5"]),
    ).toEqual([
      "show",
      "--select",
      "stg_orders",
      "--limit",
      "5",
      "--output",
      "json",
    ]);
  });

  it("leaves an explicit --output alone", () => {
    expect(
      ensureShowJsonOutput(["show", "--select", "x", "--output", "table"]),
    ).toEqual(["show", "--select", "x", "--output", "table"]);
  });

  it("does not modify non-show commands", () => {
    expect(ensureShowJsonOutput(["run", "--select", "x"])).toEqual([
      "run",
      "--select",
      "x",
    ]);
  });
});

describe("parseShowPreview", () => {
  it("parses ShowNode row objects into columns/rows", () => {
    const preview = parseShowPreview([
      {
        line: "Previewing node 'model.jaffle.stg_orders'",
        showPreview: JSON.stringify([
          { id: 1, status: "completed" },
          { id: 2, status: "pending", extra: true },
        ]),
      },
    ]);
    expect(preview).toEqual({
      columns: ["id", "status", "extra"],
      rows: [
        [1, "completed", null],
        [2, "pending", true],
      ],
    });
  });

  it("returns empty columns/rows for an empty preview array", () => {
    expect(
      parseShowPreview([{ line: "Previewing", showPreview: "[]" }]),
    ).toEqual({ columns: [], rows: [] });
  });

  it("falls back to a JSON array embedded in the log line", () => {
    expect(
      parseShowPreview([
        { line: `Previewing stg_orders [{"a": 1}, {"a": 2, "b": "z"}]` },
      ]),
    ).toEqual({
      columns: ["a", "b"],
      rows: [
        [1, null],
        [2, "z"],
      ],
    });
  });

  it("returns undefined when nothing parseable is present", () => {
    expect(
      parseShowPreview([{ line: "Running with dbt=1.9.0" }]),
    ).toBeUndefined();
  });
});
