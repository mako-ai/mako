/**
 * One run per key at a time, for interval polls. A poll whose last run has
 * not settled skips its tick instead of stacking another request on a slow
 * API (a 503 the client retries after Retry-After, say). Another key runs at
 * once, so switching workspaces is never held back by the old one's poll.
 */
export function createKeyedSingleFlight(): (
  key: string,
  run: () => Promise<unknown>,
) => boolean {
  let current: string | null = null;
  return (key, run) => {
    if (current === key) return false;
    current = key;
    void Promise.resolve()
      .then(run)
      .catch(() => undefined)
      .finally(() => {
        if (current === key) current = null;
      });
    return true;
  };
}
