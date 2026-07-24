// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { MutableRefObject, RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { describe, expect, it, vi } from "vitest";
import { useChatScroll } from "./useChatScroll";

function renderScrollHook() {
  const isLoadingRef: MutableRefObject<boolean> = { current: true };
  const virtuosoRef: RefObject<VirtuosoHandle> = { current: null };
  return renderHook(() =>
    useChatScroll({
      isLoading: true,
      isLoadingRef,
      virtuosoRef,
    }),
  );
}

function createScroller(initialScrollTop: number) {
  const scroller = document.createElement("div");
  let scrollTop = initialScrollTop;
  const setScrollTop = vi.fn((value: number) => {
    scrollTop = value;
  });

  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 200 },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: setScrollTop,
    },
  });

  return { scroller, setScrollTop };
}

describe("useChatScroll", () => {
  it("pins once across repeated synchronous height changes", () => {
    const { result } = renderScrollHook();
    const { scroller, setScrollTop } = createScroller(0);
    result.current.scrollerElRef.current = scroller;

    act(() => {
      for (let index = 0; index < 20; index += 1) {
        result.current.handleListHeightChanged();
      }
    });

    expect(setScrollTop).toHaveBeenCalledTimes(1);
    expect(setScrollTop).toHaveBeenCalledWith(800);
  });

  it("does not write when the scroller is already pinned", () => {
    const { result } = renderScrollHook();
    const { scroller, setScrollTop } = createScroller(800);
    result.current.scrollerElRef.current = scroller;

    act(() => {
      result.current.handleListHeightChanged();
    });

    expect(setScrollTop).not.toHaveBeenCalled();
  });

  it("does not pin after the user scrolls away from the bottom", () => {
    const { result } = renderScrollHook();
    const { scroller, setScrollTop } = createScroller(0);
    result.current.scrollerElRef.current = scroller;

    act(() => {
      result.current.setIsAtBottom(false);
    });
    act(() => {
      result.current.handleListHeightChanged();
    });

    expect(setScrollTop).not.toHaveBeenCalled();
  });
});
