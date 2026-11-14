import { useCallback, useEffect, useMemo, useRef } from "react";

export interface RequestTicket {
  /** False once a newer request started (or the component unmounted). */
  isLatest: () => boolean;
  /** Call when the request settles (use in `finally`). */
  done: () => void;
}

/**
 * Bookkeeping for a polled request: only the most recently started call may
 * apply its response (an older, slower one must not overwrite newer data),
 * and interval ticks can skip while a call is still in flight or the
 * browser tab is hidden.
 */
export function useLatestRequest() {
  const seqRef = useRef(0);
  const inFlightRef = useRef(0);

  const begin = useCallback((): RequestTicket => {
    const id = ++seqRef.current;
    inFlightRef.current += 1;
    let settled = false;
    return {
      isLatest: () => id === seqRef.current,
      done: () => {
        if (settled) return;
        settled = true;
        inFlightRef.current -= 1;
      },
    };
  }, []);

  /** Whether an interval tick should fire now. */
  const shouldTick = useCallback(
    () =>
      inFlightRef.current === 0 &&
      (typeof document === "undefined" ||
        document.visibilityState !== "hidden"),
    [],
  );

  // Responses arriving after unmount are never "latest".
  useEffect(
    () => () => {
      seqRef.current += 1;
    },
    [],
  );

  return useMemo(() => ({ begin, shouldTick }), [begin, shouldTick]);
}

/**
 * Run `onVisible` when the browser tab becomes visible again, so a poll that
 * paused while hidden refreshes immediately instead of waiting a full
 * interval.
 */
export function useOnDocumentVisible(onVisible: () => void, enabled = true) {
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const handler = () => {
      if (document.visibilityState === "visible") onVisibleRef.current();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [enabled]);
}
