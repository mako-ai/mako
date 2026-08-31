/**
 * Debounce for "persist what the user just typed": the last call wins, and
 * an unmount FLUSHES the pending call instead of dropping it. Three editors
 * hand-rolled this with a `saveTimer` ref (1000 ms, 1200 ms, 500 ms); the
 * console's cleanup cleared its timer, so the final keystrokes before a tab
 * switch never reached the persisted tab state.
 */
import { useCallback, useEffect, useRef } from "react";

export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: number,
) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<A | null>(null);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
  }, []);

  /** Run the pending call now (no-op when nothing is pending). */
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const args = pending.current;
    pending.current = null;
    if (args) fnRef.current(...args);
  }, []);

  const call = useCallback(
    (...args: A) => {
      pending.current = args;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, delayMs);
    },
    [delayMs, flush],
  );

  // Unmount = the user moved on; what they typed must still land.
  useEffect(() => flush, [flush]);

  return { call, flush, cancel };
}
