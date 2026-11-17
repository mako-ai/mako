/**
 * Preloaded into every folder process the harness starts (`--import`).
 *
 * - `Date.now` returns MAKO_FIXTURE_NOW, as the harness freezes it on the
 *   in-process side.
 * - With MAKO_FIXTURE_FAST_TIMERS=1, a timer under 5 s fires at once: the
 *   pauses between pages and detail reads and `Retry-After: 1` retries cost
 *   nothing against a local server. Longer timers are untouched.
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
