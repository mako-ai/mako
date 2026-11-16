// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  PREVIEW_ACTIVITY_EVERY_MS,
  usePreviewActivity,
} from "./usePreviewActivity";
import { useAppsStore } from "../../store/appsStore";

const report = vi.fn(async () => undefined);

function setup() {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const ref = { current: iframe };
  const hook = renderHook(() => usePreviewActivity("ws1", "app1", ref));
  return { iframe, hook };
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

describe("usePreviewActivity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
    report.mockClear();
    useAppsStore.setState({ reportBoxActivity: report });
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("an open preview nobody touches reports nothing", () => {
    setup();
    act(() => {
      vi.advanceTimersByTime(10 * PREVIEW_ACTIVITY_EVERY_MS);
    });
    expect(report).not.toHaveBeenCalled();
  });

  it("a click into the preview (window blur to the frame) reports", () => {
    const { iframe } = setup();
    iframe.focus();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(report).toHaveBeenCalledWith("ws1", "app1");
  });

  it("a focused preview in a visible tab heartbeats every 60 s", () => {
    const { iframe } = setup();
    iframe.focus();
    act(() => {
      vi.advanceTimersByTime(3 * PREVIEW_ACTIVITY_EVERY_MS);
    });
    expect(report).toHaveBeenCalledTimes(3);
  });

  it("no heartbeat while the tab is hidden", () => {
    const { iframe } = setup();
    iframe.focus();
    setVisibility("hidden");
    act(() => {
      vi.advanceTimersByTime(3 * PREVIEW_ACTIVITY_EVERY_MS);
    });
    expect(report).not.toHaveBeenCalled();
  });

  it("pointer movement reports, at most once a minute", () => {
    const { hook } = setup();
    act(() => {
      hook.result.current.onPointerMove();
      hook.result.current.onPointerMove();
      hook.result.current.onPointerEnter();
    });
    expect(report).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(PREVIEW_ACTIVITY_EVERY_MS);
      hook.result.current.onPointerMove();
    });
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("stops the heartbeat on unmount", () => {
    const { iframe, hook } = setup();
    iframe.focus();
    hook.unmount();
    act(() => {
      vi.advanceTimersByTime(3 * PREVIEW_ACTIVITY_EVERY_MS);
    });
    expect(report).not.toHaveBeenCalled();
  });
});
