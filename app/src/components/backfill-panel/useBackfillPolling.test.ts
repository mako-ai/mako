// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  state: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock("../../store/flowStore", () => ({
  useFlowStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(store.state),
}));

import { useBackfillPolling } from "./useBackfillPolling";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

const flush = () => act(async () => {});

describe("useBackfillPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
    store.state = {
      fetchCdcStatus: vi.fn().mockResolvedValue({ streamState: "idle" }),
      fetchCdcDestinationCounts: vi.fn().mockResolvedValue({ a: 1 }),
      fetchFlowStatus: vi.fn().mockResolvedValue({ isRunning: false }),
      fetchExecutionDetails: vi.fn().mockResolvedValue(null),
      fetchFlowHistory: vi.fn().mockResolvedValue([]),
      fetchWebhookEvents: vi.fn().mockResolvedValue({ events: [], total: 0 }),
      fetchEntitySchemaHealth: vi.fn().mockResolvedValue({ entities: [] }),
    };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const render = (tab = 0) =>
    renderHook(props => useBackfillPolling(props), {
      initialProps: { workspaceId: "w", flowId: "f", tab, eventsFilter: "all" },
    });

  it("polls CDC status on mount and every 8s while idle", async () => {
    const { result } = render();
    await flush();
    expect(store.state.fetchCdcStatus).toHaveBeenCalledTimes(1);
    expect(result.current.cdc).toEqual({ streamState: "idle" });
    expect(result.current.destinationCounts).toEqual({ a: 1 });

    await act(async () => {
      vi.advanceTimersByTime(8_000);
    });
    expect(store.state.fetchCdcStatus).toHaveBeenCalledTimes(2);
  });

  it("skips interval ticks while a call is still in flight", async () => {
    const slow = deferred<{ streamState: string }>();
    store.state.fetchCdcStatus.mockReturnValue(slow.promise);
    render();
    await flush();
    expect(store.state.fetchCdcStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(24_000);
    });
    expect(store.state.fetchCdcStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      slow.resolve({ streamState: "idle" });
    });
    await act(async () => {
      vi.advanceTimersByTime(8_000);
    });
    expect(store.state.fetchCdcStatus).toHaveBeenCalledTimes(2);
  });

  it("drops a stale response that settles after a newer one", async () => {
    const first = deferred<{ streamState: string }>();
    const second = deferred<{ streamState: string }>();
    store.state.fetchCdcStatus
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = render();
    await flush();

    // A manual poll (e.g. after an action) starts while the first is pending.
    act(() => {
      void result.current.pollCdc();
    });
    await act(async () => {
      // (Neither state is "active", so the poll cadence does not change.)
      second.resolve({ streamState: "error" });
    });
    await act(async () => {
      first.resolve({ streamState: "paused" });
    });
    expect(result.current.cdc).toEqual({ streamState: "error" });
  });

  it("pauses while the document is hidden and catches up on return", async () => {
    render();
    await flush();
    setVisibility("hidden");
    await act(async () => {
      vi.advanceTimersByTime(16_000);
    });
    expect(store.state.fetchCdcStatus).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(store.state.fetchCdcStatus).toHaveBeenCalledTimes(2);
  });

  it("polls faster and follows the running execution's logs", async () => {
    store.state.fetchCdcStatus.mockResolvedValue({ backfillStatus: "running" });
    store.state.fetchFlowStatus.mockResolvedValue({
      isRunning: true,
      runningExecution: { executionId: "exec-1" },
    });
    store.state.fetchExecutionDetails.mockResolvedValue({
      status: "running",
      logs: [{ timestamp: "t", level: "info", message: "hi" }],
      stats: { entityStats: { a: 5 }, entityStatus: { a: "syncing" } },
    });
    const { result } = render();
    await flush();
    expect(result.current.isActive).toBe(true);
    await flush();
    expect(result.current.executionId).toBe("exec-1");

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(store.state.fetchExecutionDetails).toHaveBeenCalledWith(
      "w",
      "f",
      "exec-1",
    );
    expect(result.current.liveLogs).toHaveLength(1);
    expect(result.current.execStats).toEqual({ a: 5 });
    expect(result.current.execStatus).toEqual({ a: "syncing" });

    const calls = store.state.fetchCdcStatus.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(store.state.fetchCdcStatus.mock.calls.length).toBe(calls + 1);
  });

  it("loads the events list and counts only on the events tab", async () => {
    store.state.fetchWebhookEvents.mockResolvedValue({
      events: [{ id: 1 }],
      total: 12,
    });
    const { result, rerender } = render(0);
    await flush();
    expect(store.state.fetchWebhookEvents).not.toHaveBeenCalled();

    rerender({ workspaceId: "w", flowId: "f", tab: 2, eventsFilter: "all" });
    await flush();
    // 1 list call (tab change re-poll) + 5 count calls.
    expect(store.state.fetchWebhookEvents).toHaveBeenCalledTimes(6);
    expect(result.current.webhookEvents).toEqual([{ id: 1 }]);
    expect(result.current.webhookEventsTotalAll).toBe(12);
    expect(result.current.eventCounts.all).toBe(12);
  });
});
