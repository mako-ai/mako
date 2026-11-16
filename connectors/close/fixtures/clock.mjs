/**
 * Preloaded into every folder process the harness starts (`--import`).
 *
 * - `Date.now` returns MAKO_FIXTURE_NOW, so the Search API walk ends on the
 *   same day, and probes the same ranges, as in the recording.
 * - With MAKO_FIXTURE_FAST_TIMERS=1, a timer under 5 s fires at once: the
 *   500 ms request floor, the pauses between pages and `Retry-After: 1`
 *   retries cost nothing against a local server. Longer timers (the SDK's
 *   60 s request timeout) are untouched.
 *
 * Test-only. The connector never reads these variables.
 */
const now = Date.parse(process.env.MAKO_FIXTURE_NOW ?? "");
if (Number.isFinite(now)) Date.now = () => now;

if (process.env.MAKO_FIXTURE_FAST_TIMERS === "1") {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = Object.assign(
    (fn, ms, ...args) =>
      realSetTimeout(fn, typeof ms === "number" && ms < 5000 ? 0 : ms, ...args),
    realSetTimeout,
  );
}
