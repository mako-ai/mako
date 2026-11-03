/**
 * Infinite scroll for a list that lives inside a nested scroller (the Apps
 * home scrolls inside the editor's tab pane, not the window).
 *
 * Three triggers, any of which asks for the next page:
 *  1. an IntersectionObserver on the sentinel, rooted at the sentinel's
 *     ACTUAL scroll container (found by walking up from it, not assumed),
 *     with a generous bottom margin so the page is fetched before it is
 *     needed;
 *  2. a scroll listener on that container — nearly free, and it still works
 *     where observers are throttled (a background tab, an embedded view);
 *  3. a fill check after every page renders: while the content does not
 *     reach `margin` past the bottom of the viewport, keep loading — a
 *     first page shorter than a tall screen can never be scrolled.
 *
 * `onLoadMore` must be idempotent while a page is in flight (the store's
 * fetchMoreFeed is); `enabled` is false while loading, at the end, or when
 * the list is not shown.
 */
import { useEffect, useRef, type RefObject } from "react";

/** The nearest ancestor that scrolls vertically; null = the document. */
export function scrollParentOf(el: Element | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(overflowY)) return node;
    node = node.parentElement;
  }
  return null;
}

/** How far the bottom of the content is below the bottom of the viewport. */
export function distanceToBottom(root: HTMLElement | null): number {
  if (root) return root.scrollHeight - root.scrollTop - root.clientHeight;
  const doc = document.scrollingElement ?? document.documentElement;
  return doc.scrollHeight - doc.scrollTop - window.innerHeight;
}

export function useInfiniteSentinel(input: {
  sentinelRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  onLoadMore: () => void;
  /** Prefetch distance, px. */
  margin?: number;
  /** Changes whenever a page lands (e.g. the item count): re-checks fill. */
  version: unknown;
}): void {
  const { sentinelRef, enabled, onLoadMore, margin = 800, version } = input;
  const loadRef = useRef(onLoadMore);
  useEffect(() => {
    loadRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!enabled || !sentinel) return;
    const root = scrollParentOf(sentinel);
    const near = () => distanceToBottom(root) < margin;
    const request = () => loadRef.current();

    // 3. Fill: the page that just rendered may not reach the fold.
    if (near()) request();

    // 1. The observer (re-created per page, so it re-evaluates at once).
    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(
        entries => {
          if (entries.some(e => e.isIntersecting)) request();
        },
        { root, rootMargin: `0px 0px ${margin}px 0px` },
      );
      observer.observe(sentinel);
    }

    // 2. Scrolling near the bottom.
    const target: HTMLElement | Window = root ?? window;
    const onScroll = () => {
      if (near()) request();
    };
    target.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      observer?.disconnect();
      target.removeEventListener("scroll", onScroll);
    };
  }, [enabled, margin, sentinelRef, version]);
}
