// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  PREVIEW_ACTIVITY_EVERY_MS,
  PREVIEW_HEARTBEAT_MAX_MS,
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

let windowFocused = true;

function clickIntoFrame(iframe: HTMLIFrameElement) {
  iframe.focus();
  act(() => {
    window.dispatchEvent(new Event("blur"));
  });
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
    windowFocused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => windowFocused);
  });
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("a focused preview in a visible, focused window heartbeats every 60 s", () => {
    const { iframe } = setup();
    clickIntoFrame(iframe);
    act(() => {
      vi.advanceTimersByTime(3 * PREVIEW_ACTIVITY_EVERY_MS);
    });
    // The click, then one beat per minute.
    expect(report).toHaveBeenCalledTimes(4);
  });

  it("no heartbeat once the person switches to another app", () => {
    const { iframe } = setup();
    clickIntoFrame(iframe);
    windowFocused = false; // activeElement is still the frame
    act(() => {
      vi.advanceTimersByTime(10 * PREVIEW_ACTIVITY_EVERY_MS);
    });
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("a frame left focused stops counting 30 minutes after the last interaction", () => {
    const { iframe } = setup();
    clickIntoFrame(iframe);
    act(() => {
      vi.advanceTimersByTime(
        PREVIEW_HEARTBEAT_MAX_MS + 10 * PREVIEW_ACTIVITY_EVERY_MS,
      );
    });
    // The click plus 29 beats inside the 30-minute window, then silence.
    expect(report).toHaveBeenCalledTimes(30);
  });

  it("no heartbeat while the tab is hidden", () => {
    const { iframe } = setup();
    clickIntoFrame(iframe);
    setVisibility("hidden");
    act(() => {
      vi.advanceTimersByTime(3 * PREVIEW_ACTIVITY_EVERY_MS);
    });
    expect(report).toHaveBeenCalledTimes(1);
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
    clickIntoFrame(iframe);
    hook.unmount();
    act(() => {
      vi.advanceTimersByTime(3 * PREVIEW_ACTIVITY_EVERY_MS);
    });
    expect(report).toHaveBeenCalledTimes(1);
  });
});
