/**
 * Preloaded into every folder process the harness starts (`--import`).
 *
 * - `Date.now` returns MAKO_FIXTURE_NOW, as the harness freezes it in its
 *   own process.
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

// Signed transcript links name signed.claap.test. With these variables set,
// `fetch` sends them to the fixture server instead, tagged with the run's
// key (`x-fixture-key`) so each side's request log stays its own.
const signedFrom = process.env.MAKO_FIXTURE_SIGNED_FROM;
const signedTo = process.env.MAKO_FIXTURE_SIGNED_TO;
if (signedFrom && signedTo) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const url =
      typeof input === "string" ? input : (input?.url ?? String(input));
    if (!url.startsWith(signedFrom)) return realFetch(input, init);
    return realFetch(`${signedTo}${url.slice(signedFrom.length)}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        "x-fixture-key": process.env.MAKO_FIXTURE_KEY ?? "",
      },
    });
  };
}
