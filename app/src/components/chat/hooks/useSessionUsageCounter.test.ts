// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSessionUsageCounter } from "./useSessionUsageCounter";
import { useChatUsageStore } from "../../../store/chatUsageStore";
import { displayedTokenTotal } from "../session-usage";

const turn = (id: string, inTok: number, outTok: number, cost = 0.1) => ({
  id,
  metadata: { inputTokens: inTok, outputTokens: outTok, costUsd: cost },
});

describe("useSessionUsageCounter", () => {
  beforeEach(() => {
    useChatUsageStore.setState({ byChatId: {} });
  });

  it("credits a finished turn to its chat", () => {
    const messagesRef = { current: [turn("m1", 900, 100)] };
    const { result } = renderHook(() =>
      useSessionUsageCounter({ chatId: "chat-a", messagesRef }),
    );
    act(() => result.current.onTurnFinishedRef.current());
    expect(
      displayedTokenTotal(useChatUsageStore.getState().byChatId["chat-a"]),
    ).toBe(1000);
  });

  it("counts a replayed identical finish part only once", () => {
    const messagesRef = { current: [turn("m1", 900, 100)] };
    const { result } = renderHook(() =>
      useSessionUsageCounter({ chatId: "chat-a", messagesRef }),
    );
    act(() => {
      result.current.onTurnFinishedRef.current();
      result.current.onTurnFinishedRef.current();
    });
    expect(
      displayedTokenTotal(useChatUsageStore.getState().byChatId["chat-a"]),
    ).toBe(1000);
  });

  it("credits the NEW chat immediately after a switch, not the old one", () => {
    // Regression: chatIdRef used to be updated in an effect, so a turn that
    // finished between the prop change and the effect flushing was credited
    // to the chat the user had just navigated away from.
    const messagesRef = { current: [turn("m1", 900, 100)] };
    const { result, rerender } = renderHook(
      ({ chatId }) => useSessionUsageCounter({ chatId, messagesRef }),
      { initialProps: { chatId: "chat-a" } },
    );
    rerender({ chatId: "chat-b" });
    messagesRef.current = [turn("m2", 500, 50)];
    act(() => result.current.onTurnFinishedRef.current());

    expect(useChatUsageStore.getState().byChatId["chat-a"]).toBeUndefined();
    expect(
      displayedTokenTotal(useChatUsageStore.getState().byChatId["chat-b"]),
    ).toBe(550);
  });

  it("ignores a turn that reported no tokens (local agent)", () => {
    const messagesRef = {
      current: [{ id: "m1", metadata: { modelId: "cc" } }],
    };
    const { result } = renderHook(() =>
      useSessionUsageCounter({ chatId: "chat-a", messagesRef }),
    );
    act(() => result.current.onTurnFinishedRef.current());
    expect(useChatUsageStore.getState().byChatId["chat-a"]).toBeUndefined();
  });
});
