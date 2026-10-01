import { describe, it, expect, beforeEach } from "vitest";
import { getSessionUsage, useChatUsageStore } from "./chatUsageStore";
import {
  displayedTokenTotal,
  readPersistedUsageTotals,
  usageDeltaFromMetadata,
} from "../components/chat/session-usage";

const seeded = readPersistedUsageTotals({
  promptTokens: 1000,
  completionTokens: 200,
  costUsd: 0.5,
});

const turn = usageDeltaFromMetadata({
  inputTokens: 300,
  outputTokens: 50,
  costUsd: 0.1,
})!;

describe("chatUsageStore", () => {
  beforeEach(() => {
    useChatUsageStore.setState({ byChatId: {} });
  });

  it("reports zeros for a chat it has never seen", () => {
    expect(displayedTokenTotal(getSessionUsage("nope"))).toBe(0);
  });

  it("accumulates a finished turn on top of the seeded totals", () => {
    const { seedSessionUsage, addTurnUsage } = useChatUsageStore.getState();
    seedSessionUsage("chat-a", seeded);
    addTurnUsage("chat-a", turn);
    expect(displayedTokenTotal(getSessionUsage("chat-a"))).toBe(1550);
    expect(getSessionUsage("chat-a").costUsd).toBeCloseTo(0.6);
  });

  it("REPLACES on seed rather than adding — the double-count regression", () => {
    // Reloading a chat after a live turn must converge on the server's totals,
    // not stack the local delta on top of them a second time.
    const { seedSessionUsage, addTurnUsage } = useChatUsageStore.getState();
    seedSessionUsage("chat-a", seeded);
    addTurnUsage("chat-a", turn);
    seedSessionUsage("chat-a", seeded);
    expect(displayedTokenTotal(getSessionUsage("chat-a"))).toBe(1200);
    expect(getSessionUsage("chat-a").costUsd).toBeCloseTo(0.5);
  });

  it("keeps chats isolated from one another", () => {
    const { seedSessionUsage, addTurnUsage } = useChatUsageStore.getState();
    seedSessionUsage("chat-a", seeded);
    addTurnUsage("chat-b", turn);
    expect(displayedTokenTotal(getSessionUsage("chat-a"))).toBe(1200);
    expect(displayedTokenTotal(getSessionUsage("chat-b"))).toBe(350);
  });

  it("clears one chat without disturbing the others", () => {
    const { seedSessionUsage, clearSessionUsage } =
      useChatUsageStore.getState();
    seedSessionUsage("chat-a", seeded);
    seedSessionUsage("chat-b", seeded);
    clearSessionUsage("chat-a");
    expect(displayedTokenTotal(getSessionUsage("chat-a"))).toBe(0);
    expect(displayedTokenTotal(getSessionUsage("chat-b"))).toBe(1200);
  });
});
