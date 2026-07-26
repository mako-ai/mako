import { describe, expect, it } from "vitest";
import { parseDbtShowPreview } from "./dbt-show";

const log = (line: string, level = "info") => ({
  ts: new Date(),
  level,
  line,
});

describe("parseDbtShowPreview", () => {
  it("extracts rows and column order from a ShowNode json event", () => {
    // dbt emits one info event whose msg is `{"node": ..., "show": [...]}`
    // (json.dumps(..., indent=2) — hence the embedded newlines).
    const preview = parseDbtShowPreview([
      log("Running with dbt=1.9.4"),
      log("Found 3 models, 1 test"),
      log(
        JSON.stringify(
          {
            node: "stg_orders",
            show: [
              { order_id: 1, customer: "acme", amount: 240.5 },
              { order_id: 2, customer: "globex", amount: 80 },
            ],
          },
          null,
          2,
        ),
      ),
    ]);

    expect(preview).not.toBeNull();
    expect(preview?.node).toBe("stg_orders");
    // Column order follows the warehouse's column order, not sorted keys.
    expect(preview?.columns).toEqual(["order_id", "customer", "amount"]);
    expect(preview?.rows).toEqual([
      { order_id: 1, customer: "acme", amount: 240.5 },
      { order_id: 2, customer: "globex", amount: 80 },
    ]);
  });

  it("unions columns across rows in first-seen order", () => {
    const preview = parseDbtShowPreview([
      log(JSON.stringify({ show: [{ a: 1 }, { a: 2, b: 3 }, { c: 4 }] })),
    ]);
    expect(preview?.columns).toEqual(["a", "b", "c"]);
  });

  it("returns an empty preview (not null) for a model with zero rows", () => {
    const preview = parseDbtShowPreview([
      log(JSON.stringify({ node: "empty_model", show: [] })),
    ]);
    expect(preview).toEqual({ node: "empty_model", columns: [], rows: [] });
  });

  it("returns null when no ShowNode event is present", () => {
    expect(parseDbtShowPreview([log("Nothing to do.")])).toBeNull();
    // A compile error run: only error lines, no preview payload.
    expect(
      parseDbtShowPreview([log("Compilation Error in model foo", "error")]),
    ).toBeNull();
  });

  it("ignores JSON log lines that are not a show payload", () => {
    const preview = parseDbtShowPreview([
      log(JSON.stringify({ node: "stg_orders", status: "success" })),
      log(JSON.stringify({ show: [{ id: 7 }] })),
    ]);
    expect(preview?.rows).toEqual([{ id: 7 }]);
  });

  it("keeps the last preview when a selector matched several nodes", () => {
    // `--select +model` previews each node; the UI shows one grid, and the
    // selected node is the last one dbt printed.
    const preview = parseDbtShowPreview([
      log(JSON.stringify({ node: "upstream", show: [{ a: 1 }] })),
      log(JSON.stringify({ node: "downstream", show: [{ b: 2 }] })),
    ]);
    expect(preview?.node).toBe("downstream");
    expect(preview?.rows).toEqual([{ b: 2 }]);
  });

  it("skips non-object rows rather than producing junk columns", () => {
    const preview = parseDbtShowPreview([
      log(JSON.stringify({ show: [{ a: 1 }, null, "oops", { a: 2 }] })),
    ]);
    expect(preview?.rows).toEqual([{ a: 1 }, { a: 2 }]);
  });
});
