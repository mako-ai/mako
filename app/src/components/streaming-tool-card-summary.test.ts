import { describe, expect, it } from "vitest";
import { getOutputSummary } from "./streaming-tool-card-summary";

describe("StreamingToolCard getOutputSummary", () => {
  it("summarizes a dbt run-status output with its lifecycle status", () => {
    expect(
      getOutputSummary({
        success: true,
        runId: "6a425cd21f3df656858dd1ff",
        status: "success",
      }),
    ).toBe("success");
  });

  it("includes step count when the dbt run reports step results", () => {
    expect(
      getOutputSummary({
        success: true,
        runId: "6a425cd21f3df656858dd1ff",
        status: "error",
        stepResults: [{ name: "a" }, { name: "b" }],
      }),
    ).toBe("error · 2 steps");
  });

  it("prefers the error message over the run status when the tool failed", () => {
    expect(
      getOutputSummary({
        success: false,
        error: "boom",
        runId: "6a425cd21f3df656858dd1ff",
        status: "error",
      }),
    ).toBe("boom");
  });

  it("falls back to row counts for non-dbt outputs", () => {
    expect(getOutputSummary({ data: [1, 2, 3] })).toBe("3 rows");
    expect(getOutputSummary(null)).toBeNull();
  });
});
