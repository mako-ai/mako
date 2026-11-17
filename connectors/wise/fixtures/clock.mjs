/**
 * Preloaded into every folder process the harness starts (`--import`).
 *
 * - The clock reads MAKO_FIXTURE_NOW: `Date.now()` and `new Date()` with no
 *   argument both return it, so the balance-statement walk ends its last
 *   window at the same instant as in the recording. (The in-process fetcher
 *   reads `new Date()`; the harness freezes it the same way there.)
 * - With MAKO_FIXTURE_FAST_TIMERS=1, a timer under 5 s fires at once: the
 *   pauses between pages and `Retry-After: 1` retries cost nothing against
 *   a local server. Longer timers (the 60 s request timeout) are untouched.
 *
 * Test-only. The connector never reads these variables.
 */
const now = Date.parse(process.env.MAKO_FIXTURE_NOW ?? "");
if (Number.isFinite(now)) {
  const RealDate = Date;
  class FixtureDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() {
      return now;
    }
  }
  globalThis.Date = FixtureDate;
}

if (process.env.MAKO_FIXTURE_FAST_TIMERS === "1") {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = Object.assign(
    (fn, ms, ...args) =>
      realSetTimeout(
        fn,
        // fetch's own keep-alive timer is under 5 s too: firing it at once
        // closes sockets as they are reused ("fetch failed").
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
