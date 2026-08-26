import { describe, expect, it } from "vitest";
import {
  buildCostByAssistantOrdinal,
  formatCostUsd,
  formatTokenCount,
  getResponseCostMetadata,
} from "./response-cost";
import { convertStoredMessages } from "./convert-stored-messages";

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
  it("requires a finite numeric costUsd", () => {
    expect(getResponseCostMetadata({})).toBeNull();
    expect(getResponseCostMetadata({ metadata: { costUsd: "x" } })).toBeNull();
    expect(getResponseCostMetadata({ metadata: { costUsd: NaN } })).toBeNull();
    expect(
      getResponseCostMetadata({ metadata: { costUsd: 0.01, modelId: "m" } }),
    ).toEqual({ costUsd: 0.01, modelId: "m" });
  });
});

describe("buildCostByAssistantOrdinal", () => {
  it("maps usage.history entries by messageIndex", () => {
    const map = buildCostByAssistantOrdinal({
      history: [
        {
          messageIndex: 0,
          costUsd: 0.002,
          model: "openai/gpt-5.4-mini",
          promptTokens: 1200,
          completionTokens: 300,
        },
        { messageIndex: 2, costUsd: 0.01 },
        { messageIndex: 3 }, // no cost — skipped
      ],
    });
    expect(map.get(0)).toEqual({
      costUsd: 0.002,
      modelId: "openai/gpt-5.4-mini",
      inputTokens: 1200,
      outputTokens: 300,
    });
    expect(map.get(2)?.costUsd).toBe(0.01);
    expect(map.has(3)).toBe(false);
  });

  it("tolerates missing/invalid usage", () => {
    expect(buildCostByAssistantOrdinal(undefined).size).toBe(0);
    expect(buildCostByAssistantOrdinal({}).size).toBe(0);
    expect(buildCostByAssistantOrdinal({ history: "nope" }).size).toBe(0);
  });
});

describe("convertStoredMessages cost attachment", () => {
  it("attaches metadata to assistant messages by ordinal, skipping users", () => {
    const messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "yo" }] },
      { id: "u2", role: "user", parts: [{ type: "text", text: "more" }] },
      { id: "a2", role: "assistant", parts: [{ type: "text", text: "sure" }] },
    ];
    const converted = convertStoredMessages(messages, {
      costByAssistantOrdinal: new Map([
        [0, { costUsd: 0.001 }],
        [1, { costUsd: 0.002 }],
      ]),
    });
    expect(converted[0].metadata).toBeUndefined();
    expect(converted[1].metadata).toEqual({ costUsd: 0.001 });
    expect(converted[2].metadata).toBeUndefined();
    expect(converted[3].metadata).toEqual({ costUsd: 0.002 });
  });

  it("leaves messages untouched without a cost map", () => {
    const converted = convertStoredMessages([
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "yo" }] },
    ]);
    expect(converted[0].metadata).toBeUndefined();
  });
});
