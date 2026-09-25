import { describe, expect, it } from "vitest";
import {
  formatCostUsd,
  formatTokenCount,
  getResponseCostMetadata,
} from "./response-cost";

describe("formatCostUsd", () => {
  it("uses 2 decimals from a cent up, 4 below", () => {
    expect(formatCostUsd(0)).toBe("$0.00");
    expect(formatCostUsd(0.0132)).toBe("$0.01");
    expect(formatCostUsd(0.0032)).toBe("$0.0032");
    expect(formatCostUsd(1.5)).toBe("$1.50");
  });
});

describe("formatTokenCount", () => {
  it("abbreviates thousands and millions", () => {
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(12_400)).toBe("12.4k");
    expect(formatTokenCount(2_100_000)).toBe("2.1M");
  });
});

describe("getResponseCostMetadata", () => {
  it("rejects metadata carrying neither a cost nor token counts", () => {
    expect(getResponseCostMetadata({})).toBeNull();
    expect(getResponseCostMetadata({ metadata: { costUsd: "x" } })).toBeNull();
    expect(getResponseCostMetadata({ metadata: { costUsd: NaN } })).toBeNull();
    expect(getResponseCostMetadata({ metadata: { modelId: "m" } })).toBeNull();
  });

  it("accepts a priced turn", () => {
    expect(
      getResponseCostMetadata({ metadata: { costUsd: 0.01, modelId: "m" } }),
    ).toEqual({ costUsd: 0.01, modelId: "m" });
  });

  it("accepts a turn with tokens but no price", () => {
    // Server-side pricing lookup can fail while the token counts stay good;
    // the session total should still advance by the volume it saw.
    expect(
      getResponseCostMetadata({
        metadata: { inputTokens: 900, outputTokens: 100 },
      }),
    ).toEqual({ inputTokens: 900, outputTokens: 100 });
  });

  it("carries the cache and reasoning fields the stream now sends", () => {
    expect(
      getResponseCostMetadata({
        metadata: { costUsd: 0.2, cacheReadTokens: 700, reasoningTokens: 40 },
      }),
    ).toEqual({ costUsd: 0.2, cacheReadTokens: 700, reasoningTokens: 40 });
  });
});
