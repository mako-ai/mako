// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { APP_USAGE_HEARTBEAT_MS, useAppUsageBeacon } from "./useAppUsageBeacon";

const kinds = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map(
    ([, init]) => JSON.parse((init as RequestInit).body as string).kind,
  );

describe("useAppUsageBeacon", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn().mockResolvedValue({ status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens once when the view becomes active, then beats while visible", async () => {
    const { rerender } = renderHook(
      ({ active }) =>
        useAppUsageBeacon({ workspaceId: "w", appId: "a", active }),
      { initialProps: { active: false } },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    rerender({ active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(kinds(fetchMock)).toEqual(["open"]);
    const openBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(openBody.sessionId).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/workspaces/w/apps/a/usage");

    await vi.advanceTimersByTimeAsync(APP_USAGE_HEARTBEAT_MS);
    expect(kinds(fetchMock)).toEqual(["open", "heartbeat"]);
    // The heartbeat belongs to the open: same per-view session.
    expect(
      JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
        .sessionId,
    ).toBe(openBody.sessionId);

    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(APP_USAGE_HEARTBEAT_MS);
    expect(kinds(fetchMock)).toEqual(["open", "heartbeat"]);

    // Switching tabs away and back is the same view, not a new open.
    visibility = "visible";
    rerender({ active: false });
    await vi.advanceTimersByTimeAsync(APP_USAGE_HEARTBEAT_MS);
    rerender({ active: true });
    await vi.advanceTimersByTimeAsync(APP_USAGE_HEARTBEAT_MS);
    expect(kinds(fetchMock)).toEqual(["open", "heartbeat", "heartbeat"]);
  });

  it("never reports a view that is not active (the dev preview)", async () => {
    renderHook(() =>
      useAppUsageBeacon({ workspaceId: "w", appId: "a", active: false }),
    );
    await vi.advanceTimersByTimeAsync(APP_USAGE_HEARTBEAT_MS * 3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows failures and stops beating an app that is gone", async () => {
    fetchMock.mockResolvedValueOnce({ status: 404 });
    renderHook(() =>
      useAppUsageBeacon({ workspaceId: "w", appId: "a", active: true }),
    );
    await vi.advanceTimersByTimeAsync(APP_USAGE_HEARTBEAT_MS * 2);
    expect(kinds(fetchMock)).toEqual(["open"]);

    fetchMock.mockRejectedValue(new Error("offline"));
    renderHook(() =>
      useAppUsageBeacon({ workspaceId: "w", appId: "b", active: true }),
    );
    await vi.advanceTimersByTimeAsync(APP_USAGE_HEARTBEAT_MS);
    expect(kinds(fetchMock)).toEqual(["open", "open", "heartbeat"]);
  });
});
