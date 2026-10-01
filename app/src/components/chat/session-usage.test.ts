import { describe, it, expect } from "vitest";
import {
  addUsage,
  displayedTokenTotal,
  EMPTY_SESSION_USAGE,
  readPersistedUsageTotals,
  turnUsageKey,
  usageDeltaFromMetadata,
  type SessionUsage,
} from "./session-usage";

describe("readPersistedUsageTotals", () => {
  it("returns empty totals for anything that is not a usage object", () => {
    for (const bad of [undefined, null, "nope", 42, []]) {
      expect(readPersistedUsageTotals(bad)).toEqual(EMPTY_SESSION_USAGE);
    }
  });

  it("reads the server's running totals off a chat payload", () => {
    // Shape taken from a real GET /chats/{id} response.
    const usage = readPersistedUsageTotals({
      promptTokens: 2_000_083,
      completionTokens: 71_700,
      totalTokens: 2_071_783,
      cacheReadTokens: 1_738_619,
      cacheWriteTokens: 0,
      reasoningTokens: 55_282,
      costUsd: 0.92493626,
      history: [{ messageIndex: 0 }],
    });
    expect(usage.inputTokens).toBe(2_000_083);
    expect(usage.outputTokens).toBe(71_700);
    expect(usage.cacheReadTokens).toBe(1_738_619);
    expect(usage.reasoningTokens).toBe(55_282);
    expect(usage.costUsd).toBeCloseTo(0.92493626);
    expect(usage.hasCost).toBe(true);
  });

  it("ignores garbage and negative field values", () => {
    const usage = readPersistedUsageTotals({
      promptTokens: "1000",
      completionTokens: -5,
      costUsd: Number.NaN,
    });
    expect(usage).toEqual(EMPTY_SESSION_USAGE);
  });

  it("never folds cache or reasoning into the displayed total", () => {
    // Cache reads are a SUBSET of prompt tokens and reasoning a subset of
    // completion tokens. Adding them would double count — in the real session
    // above that would have reported 3.8M instead of 2.07M.
    const usage = readPersistedUsageTotals({
      promptTokens: 10_000,
      completionTokens: 2_400,
      cacheReadTokens: 8_000,
      reasoningTokens: 1_200,
      costUsd: 0.5,
    });
    expect(displayedTokenTotal(usage)).toBe(12_400);
  });
});

describe("usageDeltaFromMetadata", () => {
  it("returns null when there is no metadata or no tokens", () => {
    expect(usageDeltaFromMetadata(null)).toBeNull();
    expect(usageDeltaFromMetadata(undefined)).toBeNull();
    // A Local ACP turn reports nothing at all.
    expect(usageDeltaFromMetadata({ modelId: "claude-code" })).toBeNull();
  });

  it("reads the cache and reasoning fields the stream now sends", () => {
    const delta = usageDeltaFromMetadata({
      costUsd: 0.16,
      modelId: "claude-fable-5",
      inputTokens: 900,
      outputTokens: 100,
      cacheReadTokens: 700,
      cacheWriteTokens: 50,
      reasoningTokens: 40,
    });
    expect(delta).toMatchObject({
      inputTokens: 900,
      outputTokens: 100,
      cacheReadTokens: 700,
      cacheWriteTokens: 50,
      reasoningTokens: 40,
      hasCost: true,
    });
  });

  it("still counts tokens when server-side pricing failed", () => {
    const delta = usageDeltaFromMetadata({
      inputTokens: 900,
      outputTokens: 100,
    });
    expect(delta?.costUsd).toBe(0);
    expect(delta?.hasCost).toBe(false);
    expect(displayedTokenTotal(delta as SessionUsage)).toBe(1000);
  });
});

describe("addUsage", () => {
  it("sums every dimension and latches hasCost", () => {
    const a = usageDeltaFromMetadata({ inputTokens: 100, outputTokens: 10 })!;
    const b = usageDeltaFromMetadata({
      inputTokens: 200,
      outputTokens: 20,
      costUsd: 0.02,
    })!;
    const sum = addUsage(a, b);
    expect(displayedTokenTotal(sum)).toBe(330);
    expect(sum.costUsd).toBeCloseTo(0.02);
    expect(sum.hasCost).toBe(true);
  });
});

describe("turnUsageKey", () => {
  it("is stable for a replayed identical finish part", () => {
    const delta = usageDeltaFromMetadata({
      inputTokens: 900,
      outputTokens: 100,
      costUsd: 0.16,
    })!;
    expect(turnUsageKey("msg-1", delta)).toBe(turnUsageKey("msg-1", delta));
  });

  it("differs when the turn or its token counts differ", () => {
    const one = usageDeltaFromMetadata({
      inputTokens: 900,
      outputTokens: 100,
    })!;
    const two = usageDeltaFromMetadata({
      inputTokens: 901,
      outputTokens: 100,
    })!;
    expect(turnUsageKey("msg-1", one)).not.toBe(turnUsageKey("msg-2", one));
    expect(turnUsageKey("msg-1", one)).not.toBe(turnUsageKey("msg-1", two));
  });
});
