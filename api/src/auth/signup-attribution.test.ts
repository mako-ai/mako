/**
 * Signup attribution cookie parsing tests.
 *
 * Focus: the `mako_attr` cookie is attacker-controlled input (any visitor can
 * craft it), so parsing must whitelist keys, truncate values, and reject
 * malformed/oversized payloads without throwing.
 *
 * Run: tsx src/auth/signup-attribution.test.ts
 */
import assert from "node:assert/strict";
import { parseAttributionCookieValue } from "./signup-attribution";

const validTouch = {
  ts: "2026-07-09T07:00:00.000Z",
  landing_page: "/sql-client?gclid=G123&utm_source=google",
  referrer: "",
  utm: { utm_source: "google", utm_medium: "cpc" },
  click_ids: { gclid: "G123" },
  user_agent: "Mozilla/5.0",
  screen: "1512x982",
  viewport: "1512x740",
  language: "en-US",
  timezone: "Europe/Zurich",
};

function cookie(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    sid: "sid-123",
    first: validTouch,
    last: validTouch,
    ...overrides,
  });
}

function testValidCookieParses() {
  const parsed = parseAttributionCookieValue(cookie());
  assert.ok(parsed, "expected valid cookie to parse");
  assert.equal(parsed.sid, "sid-123");
  assert.equal(parsed.gclid, "G123");
  assert.equal(parsed.first.utm?.utm_source, "google");
  assert.equal(parsed.last.landing_page, validTouch.landing_page);
}

function testGclidPrefersLastTouch() {
  const parsed = parseAttributionCookieValue(
    cookie({
      first: { ...validTouch, click_ids: { gclid: "FIRST" } },
      last: { ...validTouch, click_ids: { gclid: "LAST" } },
    }),
  );
  assert.equal(parsed?.gclid, "LAST");

  const firstOnly = parseAttributionCookieValue(
    cookie({
      first: { ...validTouch, click_ids: { gclid: "FIRST" } },
      last: { ...validTouch, click_ids: {} },
    }),
  );
  assert.equal(firstOnly?.gclid, "FIRST");
}

function testUnknownAndDangerousKeysAreDropped() {
  const parsed = parseAttributionCookieValue(
    cookie({
      first: {
        ...validTouch,
        $where: "1 == 1",
        "nested.path": "x",
        injected: { deep: true },
        utm: { utm_source: "ok", $gt: "evil", not_a_utm: "nope" },
        click_ids: { gclid: "G1", constructor: "evil" },
      },
    }),
  );
  assert.ok(parsed);
  const first = parsed.first as Record<string, unknown>;
  assert.equal(first.$where, undefined);
  assert.equal(first["nested.path"], undefined);
  assert.equal(first.injected, undefined);
  assert.deepEqual(parsed.first.utm, { utm_source: "ok" });
  assert.deepEqual(parsed.first.click_ids, { gclid: "G1" });
}

function testValuesAreTruncated() {
  const parsed = parseAttributionCookieValue(
    cookie({
      first: { ...validTouch, landing_page: "/x".repeat(600) },
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed.first.landing_page?.length, 512);
}

function testInvalidInputsReturnNull() {
  assert.equal(parseAttributionCookieValue(undefined), null);
  assert.equal(parseAttributionCookieValue(""), null);
  assert.equal(parseAttributionCookieValue("not json"), null);
  assert.equal(parseAttributionCookieValue("[]"), null);
  assert.equal(parseAttributionCookieValue('"string"'), null);
  // Unsupported version
  assert.equal(parseAttributionCookieValue(cookie({ v: 2 })), null);
  // Missing touches
  assert.equal(
    parseAttributionCookieValue(JSON.stringify({ v: 1, sid: "x" })),
    null,
  );
  // Oversized payload
  const huge = cookie({ first: { ...validTouch, referrer: "r".repeat(9000) } });
  assert.equal(parseAttributionCookieValue(huge), null);
}

function testMissingLastFallsBackToFirst() {
  const parsed = parseAttributionCookieValue(
    JSON.stringify({ v: 1, first: validTouch }),
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.last, parsed.first);
}

const tests = [
  testValidCookieParses,
  testGclidPrefersLastTouch,
  testUnknownAndDangerousKeysAreDropped,
  testValuesAreTruncated,
  testInvalidInputsReturnNull,
  testMissingLastFallsBackToFirst,
];

for (const test of tests) {
  test();
}
// eslint-disable-next-line no-console
console.log(`signup-attribution: ${tests.length} tests passed`);
