// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSessionUsageCounter } from "./useSessionUsageCounter";
import { useChatUsageStore } from "../../../store/chatUsageStore";
import { displayedTokenTotal } from "../session-usage";
import { api } from "../../../api/client";

const turn = (id: string, inTok: number, outTok: number, cost = 0.1) => ({
  id,
  metadata: { inputTokens: inTok, outputTokens: outTok, costUsd: cost },
});

// `workspaceId: undefined` throughout: these cover the OPTIMISTIC path, and
// without a workspace the post-turn server reconcile is skipped, so the
// assertions below are about the local delta alone.
describe("useSessionUsageCounter", () => {
  beforeEach(() => {
    useChatUsageStore.setState({ byChatId: {} });
  });

  it("credits a finished turn to its chat", () => {
    const messagesRef = { current: [turn("m1", 900, 100)] };
    const { result } = renderHook(() =>
      useSessionUsageCounter({
        chatId: "chat-a",
        workspaceId: undefined,
        messagesRef,
      }),
    );
    act(() => result.current.onTurnFinishedRef.current());
    expect(
      displayedTokenTotal(useChatUsageStore.getState().byChatId["chat-a"]),
    ).toBe(1000);
  });

  it("counts a replayed identical finish part only once", () => {
    const messagesRef = { current: [turn("m1", 900, 100)] };
    const { result } = renderHook(() =>
      useSessionUsageCounter({
        chatId: "chat-a",
        workspaceId: undefined,
        messagesRef,
      }),
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
      ({ chatId }) =>
        useSessionUsageCounter({ chatId, workspaceId: undefined, messagesRef }),
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
      useSessionUsageCounter({
        chatId: "chat-a",
        workspaceId: undefined,
        messagesRef,
      }),
    );
    act(() => result.current.onTurnFinishedRef.current());
    expect(useChatUsageStore.getState().byChatId["chat-a"]).toBeUndefined();
  });

  it("reconciles against the server after the turn settles", async () => {
    // The optimistic delta only covers segments whose `finish` reached this
    // browser. Measured on the preview, a tool-using turn read 25.0k live
    // against 76.8k persisted, and only became right on reload. The post-turn
    // reconcile REPLACES with the authoritative per-chat aggregate.
    vi.useFakeTimers();
    const spy = vi.spyOn(api, "GET").mockResolvedValue({
      data: {
        chatId: "chat-a",
        totals: {
          inputTokens: 76_037,
          outputTokens: 768,
          cacheReadTokens: 49_664,
          cacheWriteTokens: 0,
          reasoningTokens: 546,
          totalTokens: 76_805,
          costUsd: 0.02696055,
        },
        invocations: [],
      },
    } as never);

    const messagesRef = { current: [turn("m1", 24_800, 224, 0.02)] };
    const { result } = renderHook(() =>
      useSessionUsageCounter({
        chatId: "chat-a",
        workspaceId: "ws-1",
        messagesRef,
      }),
    );

    act(() => result.current.onTurnFinishedRef.current());
    // Optimistic first, so the number moves immediately.
    expect(
      displayedTokenTotal(useChatUsageStore.getState().byChatId["chat-a"]),
    ).toBe(25_024);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(spy).toHaveBeenCalled();
    expect(
      displayedTokenTotal(useChatUsageStore.getState().byChatId["chat-a"]),
    ).toBe(76_805);
    expect(useChatUsageStore.getState().byChatId["chat-a"].costUsd).toBeCloseTo(
      0.02696055,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});
