/**
 * Waiting on the server for something a caller would otherwise poll for: a
 * run to end, a deploy to go live. One MCP exchange may last two minutes
 * (EXCHANGE_TIMEOUT_MS in routes/mcp-server.routes.ts), so a wait is capped
 * well below that and answers with what it saw last; the caller asks again.
 */

/** The longest a single wait lasts, in seconds. */
export const MAX_WAIT_SECONDS = 90;

/** A requested wait, in seconds, bounded to [0, MAX_WAIT_SECONDS]. */
export function waitSeconds(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested) || requested <= 0) return 0;
  return Math.min(requested, MAX_WAIT_SECONDS);
}

export type WaitOptions = {
  /** How long to wait at most, in seconds; 0 reads once. */
  seconds: number;
  /** Time between reads. */
  intervalMs?: number;
  /** For tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Read until `done` says so or the time is up, and answer the last read with
 * whether it is done. A read that throws ends the wait with that error.
 */
export async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  {
    seconds,
    intervalMs = 1000,
    now = Date.now,
    sleep = defaultSleep,
  }: WaitOptions,
): Promise<{ value: T; done: boolean }> {
  const deadline = now() + seconds * 1000;
  for (;;) {
    const value = await read();
    if (done(value)) return { value, done: true };
    const left = deadline - now();
    if (left <= 0) return { value, done: false };
    await sleep(Math.min(intervalMs, left));
  }
}
