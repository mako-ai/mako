/**
 * Preloaded into every folder process the harness starts (`--import`).
 *
 * With MAKO_FIXTURE_FAST_TIMERS=1, a timer under 5 s fires at once: the
 * pauses between pages and `Retry-After: 1` retries cost nothing against a
 * local server. Longer timers (the client's 60 s request timeout) are
 * untouched, and so are fetch's own (its keep-alive timer is under 5 s:
 * firing it at once closes sockets as they are reused).
 *
 * Test-only. The connector never reads this variable.
 */
if (process.env.MAKO_FIXTURE_FAST_TIMERS === "1") {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = Object.assign(
    (fn, ms, ...args) =>
      realSetTimeout(
        fn,
        typeof ms === "number" &&
          ms < 5000 &&
          !/undici/.test(new Error().stack ?? "")
          ? 0
          : ms,
        ...args,
      ),
    realSetTimeout,
  );
}
