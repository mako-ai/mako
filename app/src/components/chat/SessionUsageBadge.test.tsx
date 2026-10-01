// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { SessionUsageBadge } from "./SessionUsageBadge";
import { useChatUsageStore } from "../../store/chatUsageStore";
import {
  readPersistedUsageTotals,
  usageDeltaFromMetadata,
} from "./session-usage";

describe("SessionUsageBadge", () => {
  // This repo has no global vitest setup file, so testing-library's automatic
  // cleanup never registers — unmount explicitly or queries see stale trees.
  beforeEach(() => {
    cleanup();
    useChatUsageStore.setState({ byChatId: {} });
  });

  it("renders nothing for a chat with no recorded usage", () => {
    const { container } = render(<SessionUsageBadge chatId="chat-a" />);
    expect(container.textContent).toBe("");
    expect(screen.queryByLabelText("Session usage")).toBeNull();
  });

  it("shows the session total and cost once seeded", () => {
    act(() => {
      useChatUsageStore.getState().seedSessionUsage(
        "chat-a",
        readPersistedUsageTotals({
          promptTokens: 2_000_083,
          completionTokens: 71_700,
          costUsd: 0.92493626,
        }),
      );
    });
    render(<SessionUsageBadge chatId="chat-a" />);
    expect(screen.getByLabelText("Session usage").textContent).toBe(
      "2.1M · $0.92",
    );
  });

  it("counts cached tokens inside input, not on top of it", () => {
    // 10k input of which 8k was a cache read, plus 2.4k output, is 12.4k —
    // not 20.4k.
    act(() => {
      useChatUsageStore.getState().seedSessionUsage(
        "chat-a",
        readPersistedUsageTotals({
          promptTokens: 10_000,
          completionTokens: 2_400,
          cacheReadTokens: 8_000,
          costUsd: 0.05,
        }),
      );
    });
    render(<SessionUsageBadge chatId="chat-a" />);
    const text = screen.getByLabelText("Session usage").textContent ?? "";
    expect(text).toContain("12.4k");
    expect(text).not.toContain("20.4k");
  });

  it("advances when a live turn is recorded", () => {
    act(() => {
      useChatUsageStore
        .getState()
        .seedSessionUsage(
          "chat-a",
          readPersistedUsageTotals({ promptTokens: 1000, completionTokens: 0 }),
        );
    });
    render(<SessionUsageBadge chatId="chat-a" />);
    expect(screen.getByLabelText("Session usage").textContent).toContain(
      "1.0k",
    );

    act(() => {
      useChatUsageStore
        .getState()
        .addTurnUsage(
          "chat-a",
          usageDeltaFromMetadata({ inputTokens: 1000, outputTokens: 0 })!,
        );
    });
    expect(screen.getByLabelText("Session usage").textContent).toContain(
      "2.0k",
    );
  });

  it("omits the cost half when no turn was priced", () => {
    act(() => {
      useChatUsageStore
        .getState()
        .addTurnUsage(
          "chat-a",
          usageDeltaFromMetadata({ inputTokens: 900, outputTokens: 100 })!,
        );
    });
    render(<SessionUsageBadge chatId="chat-a" />);
    const badge = screen.getByLabelText("Session usage");
    expect(badge.textContent).toContain("1.0k");
    expect(badge.textContent).not.toContain("$");
  });
});
