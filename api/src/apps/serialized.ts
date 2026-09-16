/**
 * Per-key promise chains: `serialized(key, fn)` runs `fn` after every earlier
 * call for the same key has settled, whether it resolved or rejected. The
 * apps index and the consoles service both queue writes per workspace this
 * way; one implementation, two chain maps.
 */
export function createSerializer(): <T>(
  key: string,
  fn: () => Promise<T>,
) => Promise<T> {
  const chains = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    chains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  };
}
