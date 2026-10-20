// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  distanceToBottom,
  scrollParentOf,
  useInfiniteSentinel,
} from "./useInfiniteSentinel";

/** The editor-pane layout: page → pane (scrolls) → content → sentinel. */
function nestedScroller(geometry: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop?: number;
}) {
  const pane = document.createElement("div");
  pane.style.overflowY = "auto";
  const content = document.createElement("div");
  const sentinel = document.createElement("div");
  content.appendChild(sentinel);
  pane.appendChild(content);
  document.body.appendChild(pane);
  let scrollTop = geometry.scrollTop ?? 0;
  Object.defineProperties(pane, {
    scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
    clientHeight: { configurable: true, get: () => geometry.clientHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    },
  });
  return { pane, sentinel, ref: { current: sentinel } };
}

type Observed = {
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  targets: Element[];
  disconnected: boolean;
};
let observers: Observed[] = [];

beforeEach(() => {
  observers = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private o: Observed;
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        this.o = { callback, options, targets: [], disconnected: false };
        observers.push(this.o);
      }
      observe(t: Element) {
        this.o.targets.push(t);
      }
      disconnect() {
        this.o.disconnected = true;
      }
      unobserve() {}
      takeRecords() {
        return [];
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("scroll container", () => {
  it("is the nearest scrolling ancestor, not the window", () => {
    const { pane, sentinel } = nestedScroller({
      scrollHeight: 3000,
      clientHeight: 1000,
    });
    expect(scrollParentOf(sentinel)).toBe(pane);
    pane.scrollTop = 1500;
    expect(distanceToBottom(pane)).toBe(500);
  });
});

describe("useInfiniteSentinel", () => {
  it("observes the sentinel against the nested scroller, with a prefetch margin", () => {
    const geo = { scrollHeight: 4000, clientHeight: 1000 };
    const { pane, sentinel, ref } = nestedScroller(geo);
    const onLoadMore = vi.fn();
    renderHook(() =>
      useInfiniteSentinel({
        sentinelRef: ref,
        enabled: true,
        onLoadMore,
        version: 24,
      }),
    );
    // Far from the bottom: nothing yet.
    expect(onLoadMore).not.toHaveBeenCalled();
    const [o] = observers;
    expect(o.options?.root).toBe(pane);
    expect(o.options?.rootMargin).toBe("0px 0px 800px 0px");
    expect(o.targets).toEqual([sentinel]);
    act(() =>
      o.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("loads on scrolling near the bottom even if the observer never fires", () => {
    const geo = { scrollHeight: 4000, clientHeight: 1000 };
    const { pane, ref } = nestedScroller(geo);
    const onLoadMore = vi.fn();
    renderHook(() =>
      useInfiniteSentinel({
        sentinelRef: ref,
        enabled: true,
        onLoadMore,
        version: 24,
      }),
    );
    pane.scrollTop = 1000;
    act(() => {
      pane.dispatchEvent(new Event("scroll"));
    });
    expect(onLoadMore).not.toHaveBeenCalled();
    pane.scrollTop = 2400; // 600px left < 800px margin
    act(() => {
      pane.dispatchEvent(new Event("scroll"));
    });
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("keeps loading while a page does not fill the screen, and re-arms per page", () => {
    const geo = { scrollHeight: 1200, clientHeight: 1000 };
    const { ref } = nestedScroller(geo);
    const onLoadMore = vi.fn();
    const { rerender } = renderHook(
      ({ version, enabled }) =>
        useInfiniteSentinel({
          sentinelRef: ref,
          enabled,
          onLoadMore,
          version,
        }),
      { initialProps: { version: 24, enabled: true } },
    );
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    // In flight: disabled, the old observer is gone.
    rerender({ version: 24, enabled: false });
    expect(observers[0].disconnected).toBe(true);
    // Page 2 landed and the content now reaches far below the fold.
    geo.scrollHeight = 5000;
    rerender({ version: 48, enabled: true });
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(observers.at(-1)?.disconnected).toBe(false);
  });

  it("does nothing while disabled", () => {
    const { pane, ref } = nestedScroller({
      scrollHeight: 1000,
      clientHeight: 1000,
    });
    const onLoadMore = vi.fn();
    renderHook(() =>
      useInfiniteSentinel({
        sentinelRef: ref,
        enabled: false,
        onLoadMore,
        version: 0,
      }),
    );
    act(() => {
      pane.dispatchEvent(new Event("scroll"));
    });
    expect(onLoadMore).not.toHaveBeenCalled();
    expect(observers).toHaveLength(0);
  });
});
