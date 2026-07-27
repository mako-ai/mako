import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import type { VirtuosoHandle } from "react-virtuoso";

export interface UseChatScrollArgs {
  isLoading: boolean;
  isLoadingRef: MutableRefObject<boolean>;
  virtuosoRef: RefObject<VirtuosoHandle>;
}

/**
 * Stick to the streaming tail while a turn is generating.
 *
 * Virtuoso's `followOutput` only fires when the item COUNT changes, but an
 * entire assistant turn — thinking blocks, every tool card, and the final
 * text — streams into a SINGLE message, growing one item without ever
 * changing the count. So `followOutput` never fires mid-turn and the view
 * doesn't follow the streaming content (it stays OFF on `<Virtuoso>`).
 *
 * We instead pin the bottom inside Virtuoso's own `totalListHeightChanged`
 * callback (`handleListHeightChanged`). The earlier approach pinned on each
 * throttled `messages` tick via a one-shot rAF, but that only covers ~1 of
 * every 3 frames: the interior blocks that change height asynchronously and
 * non-monotonically (MUI `Collapse` on the thinking block + tool cards, and
 * the `modify_console` diff re-render) animate over ~300ms on frames where
 * `messages` does NOT tick. On those frames Virtuoso's resize anchoring
 * nudges `scrollTop` UP (toward the message top) to keep content stable, and
 * with no pin to counter it the view paints partway up — then the next
 * `messages` tick pins it back down. That alternation is the top/bottom
 * "jumping/blinking". Plain-text turns never bounced because their growth is
 * append-only at the bottom (monotonic), so the anchor and the pin agree.
 *
 * `totalListHeightChanged` fires as part of Virtuoso's resize processing,
 * AFTER it applies that compensation, so writing `scrollTop = scrollHeight`
 * here is the last write before paint on exactly the frames that resize —
 * the frames the old pin lost. Reading `isAtBottom` from a ref keeps history
 * reading un-yanked the instant the user scrolls up.
 */
export function useChatScroll({
  isLoading,
  isLoadingRef,
  virtuosoRef,
}: UseChatScrollArgs) {
  // `isAtBottom` drives both the "scroll to bottom" button and whether
  // streaming auto-follows the tail.
  const [isAtBottom, setIsAtBottom] = useState(true);
  const scrollerElRef = useRef<HTMLElement | Window | null>(null);
  const isAtBottomRef = useRef(isAtBottom);
  isAtBottomRef.current = isAtBottom;

  // Track the last time the view was at the bottom (updated in render). Used to
  // decide whether to hold the bottom through the post-turn settling window
  // even after the big end-of-turn collapse momentarily flips `isAtBottom`.
  const lastAtBottomAtRef = useRef(0);
  if (isAtBottom) lastAtBottomAtRef.current = Date.now();

  // Bounded settling window after a turn ends. Tool cards and thinking blocks
  // now collapse per-block the instant each one finishes (see
  // `StreamingToolCard` / `ReasoningDisplay`), so there is no longer a single
  // mass collapse deferred to turn end. What still shrinks at turn end is the
  // LAST live block: the final thinking block (or a trailing tool card) closes
  // when `status` leaves "streaming". Virtuoso reacts to that shrink by
  // re-anchoring to the (now shorter) item's TOP, which can strand the view at
  // the top of the response unless we keep pinning the bottom through it.
  //
  // The live `isAtBottom` can't gate this pin: the very shrink we're countering
  // flips `isAtBottom` to false for a few frames, which would disengage the pin
  // and let the strand happen. Instead we snapshot whether the user was at the
  // bottom *as the turn ended* (`wasAtBottomAtTurnEndRef`) and hold the bottom
  // for the whole window based on that — so the final collapse stays pinned,
  // but a user who had scrolled up to read history is never yanked back down.
  const stickTailUntilRef = useRef(0);
  const wasAtBottomAtTurnEndRef = useRef(false);
  const wasLoadingRef = useRef(isLoading);
  useEffect(() => {
    if (wasLoadingRef.current && !isLoading) {
      // Hold the bottom briefly so the final block's collapse at turn end
      // stays pinned instead of stranding the view at the message top.
      stickTailUntilRef.current = Date.now() + 1200;
      wasAtBottomAtTurnEndRef.current =
        isAtBottomRef.current || Date.now() - lastAtBottomAtRef.current < 800;
    }
    wasLoadingRef.current = isLoading;
  }, [isLoading]);

  // Streaming follow: write the exact maximum scroll position on the captured
  // scroller. Avoid redundant writes when already pinned: assigning an
  // out-of-range `scrollHeight` from inside Virtuoso's ResizeObserver callback
  // can trigger another measurement/scroll cycle even though the browser
  // clamps it to the same effective position. Large, rapidly settling tool
  // results can otherwise recurse until React's maximum update depth guard
  // unmounts the app.
  const pinToBottom = useCallback(() => {
    if (!isAtBottomRef.current) return;
    const el = scrollerElRef.current;
    if (!el || !(el instanceof HTMLElement)) return;

    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    if (Math.abs(el.scrollTop - maxScrollTop) <= 1) return;
    el.scrollTop = maxScrollTop;
  }, []);

  const handleListHeightChanged = useCallback(() => {
    if (isLoadingRef.current) {
      pinToBottom();
      return;
    }
    // Post-turn settle. The final block's collapse at turn end shrinks the
    // streaming message; a raw `scrollTop` write can lose the race to Virtuoso
    // re-anchoring the (now shorter) item to its TOP, which strands the view at
    // the top of the response. Virtuoso's own
    // `scrollToIndex` is authoritative — it re-targets the last item's end and
    // survives the re-measure — so use it to hold the conclusion at the bottom
    // through the collapse. Gated on the turn-end snapshot (not the live
    // `isAtBottom`, which the collapse transiently flips false) and the bounded
    // window, so a user who scrolled up to read history is never yanked back.
    // `scrollToIndex` is only safe here because the last item is no longer
    // growing (during streaming it would re-derive a moving target and bounce —
    // that path uses the raw `scrollTop` pin above).
    if (
      Date.now() <= stickTailUntilRef.current &&
      wasAtBottomAtTurnEndRef.current
    ) {
      virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
    }
  }, [isLoadingRef, pinToBottom, virtuosoRef]);

  return {
    isAtBottom,
    setIsAtBottom,
    scrollerElRef,
    handleListHeightChanged,
  };
}
