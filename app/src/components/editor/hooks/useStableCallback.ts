import { useCallback, useInsertionEffect, useRef } from "react";

/**
 * A function identity that never changes but always calls the latest `fn`.
 *
 * Use it for handlers passed to `React.memo` children (the results grid, the
 * per-tab console panel): a fresh closure per render would defeat the memo,
 * while a `useCallback` with state deps churns whenever that state changes.
 * The ref is refreshed in an insertion effect, i.e. before any child's layout
 * effect could call it. Do not call the returned function during render.
 */
export function useStableCallback<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const ref = useRef(fn);
  useInsertionEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
