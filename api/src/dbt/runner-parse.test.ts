import { describe, expect, it } from "vitest";
import { parseSourceFreshness, parseStepResults } from "./runner.service";

describe("parseStepResults", () => {
  it("returns [] for missing/empty artifacts", () => {
    expect(parseStepResults(undefined)).toEqual([]);
    expect(parseStepResults({ results: [] })).toEqual([]);
  });

  it("maps run_results.json into the run-detail row shape", () => {
    const rows = parseStepResults({
      results: [
        {
          unique_id: "model.jaffle_shop.customers",
          status: "success",
          execution_time: 1.234,
          adapter_response: { rows_affected: 42 },
          message: "OK",
        },
        {
          unique_id: "test.jaffle_shop.not_null_customers_id.abc123",
          status: "fail",
          execution_time: 0.5,
        },
      ],
    });

    expect(rows).toEqual([
      {
        uniqueId: "model.jaffle_shop.customers",
        name: "customers",
        resourceType: "model",
        status: "success",
        executionTimeMs: 1234,
        rowsAffected: 42,
        message: "OK",
      },
      {
        uniqueId: "test.jaffle_shop.not_null_customers_id.abc123",
        name: "abc123",
        resourceType: "test",
        status: "fail",
        executionTimeMs: 500,
        rowsAffected: undefined,
        message: undefined,
      },
    ]);
  });
});

describe("parseSourceFreshness", () => {
  it("returns [] for undefined or invalid JSON", () => {
    expect(parseSourceFreshness(undefined)).toEqual([]);
    expect(parseSourceFreshness(Buffer.from("not json"))).toEqual([]);
    expect(parseSourceFreshness(Buffer.from("{}"))).toEqual([]);
  });

  it("maps sources.json into source rows with a human age label", () => {
    const buf = Buffer.from(
      JSON.stringify({
        results: [
          {
            unique_id: "source.jaffle_shop.raw.orders",
            status: "pass",
            execution_time: 0.2,
            max_loaded_at_time_ago_in_s: 600,
          },
        ],
      }),
    );
    expect(parseSourceFreshness(buf)).toEqual([
      {
        uniqueId: "source.jaffle_shop.raw.orders",
        name: "raw.orders",
        resourceType: "source",
        status: "pass",
        executionTimeMs: 200,
        message: "loaded 10m ago",
      },
    ]);
  });
});
