import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatDate, formatTime, toDayKey, toInstant } from "./time.js";

const NOW = new Date(Date.UTC(2026, 10, 18, 12, 0)); // 18 Nov 2026, 12:00 UTC

test("toInstant: a zone-less DuckDB timestamp is UTC; zoned strings, ms, µs and Dates pass through", () => {
  assert.equal(toInstant("2026-11-18 14:05:00").toISOString(), "2026-11-18T14:05:00.000Z");
  assert.equal(toInstant("2026-11-18T14:05:00.25").toISOString(), "2026-11-18T14:05:00.250Z");
  assert.equal(toInstant("2026-11-18T14:05:00+01:00").toISOString(), "2026-11-18T13:05:00.000Z");
  assert.equal(toInstant("2026-11-18").toISOString(), "2026-11-18T00:00:00.000Z");
  assert.equal(toInstant(Date.UTC(2026, 10, 18)).toISOString(), "2026-11-18T00:00:00.000Z");
  assert.equal(toInstant(1_779_105_900_000_000n).toISOString(), new Date(1_779_105_900_000).toISOString(), "bigint is epoch µs");
  for (const v of [null, undefined, "", "not a date", NaN, new Date(NaN)]) assert.equal(toInstant(v), null);
});

test("toDayKey: the UTC day, whatever the viewer's zone", () => {
  assert.equal(toDayKey("2026-11-18"), "2026-11-18");
  assert.equal(toDayKey(new Date(Date.UTC(2026, 10, 18, 23, 30))), "2026-11-18");
  assert.equal(toDayKey("2026-11-18T00:30:00+01:00"), "2026-11-17");
  assert.equal(toDayKey(null), null);
});

test("formatTime: the viewer's zone with its label; the date when not today; the year when not this year", () => {
  const t = "2026-11-18 13:05:00"; // UTC
  assert.equal(formatTime(t, { timeZone: "Europe/Zurich", locale: "en-GB", now: NOW }), "14:05 CET");
  assert.equal(formatTime(t, { timeZone: "America/Los_Angeles", locale: "en-US", now: NOW }), "05:05 PST");
  assert.equal(formatTime("2026-11-17 13:05:00", { timeZone: "Europe/Zurich", locale: "en-GB", now: NOW }), "17 Nov, 14:05 CET");
  assert.equal(formatTime("2025-11-17 13:05:00", { timeZone: "Europe/Zurich", locale: "en-GB", now: NOW }), "17 Nov 2025, 14:05 CET");
  assert.equal(formatTime(t, { timeZone: "Europe/Zurich", locale: "en-GB", now: NOW, zoneName: false, seconds: true }), "14:05:00");
  // Summer time: the label follows the instant, not today.
  assert.equal(formatTime("2026-07-01 12:00:00", { timeZone: "Europe/Zurich", locale: "en-GB", now: NOW, date: false }), "14:00 CEST");
  assert.equal(formatTime(null), "—");
});

test("formatDate: a day bucket prints unshifted in every zone", () => {
  assert.equal(formatDate("2026-11-18", { locale: "en-GB", now: NOW }), "18 Nov");
  assert.equal(formatDate("2025-11-18", { locale: "en-GB", now: NOW }), "18 Nov 2025");
  // A parquet `date` arrives as its UTC midnight: west of UTC, new Date() display would show 17 Nov.
  const utcMidnight = new Date(Date.UTC(2026, 10, 18));
  const tz = process.env.TZ;
  try {
    process.env.TZ = "America/Los_Angeles";
    assert.equal(formatDate(utcMidnight, { locale: "en-GB", now: NOW, year: true }), "18 Nov 2026");
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
  assert.equal(formatDate("2026-11-18", { locale: "en-GB", now: NOW, weekday: "short" }), "Wed 18 Nov");
  assert.equal(formatDate(undefined), "—");
});

test("the time helpers ship from the root and /ui, typed in both", () => {
  const root = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const ui = readFileSync(new URL("./ui.js", import.meta.url), "utf8");
  for (const src of [root, ui]) assert.match(src, /export \{ formatDate, formatTime, toDayKey, toInstant \} from "\.\/time\.js"/);
  for (const f of ["index.d.ts", "ui.d.ts"]) {
    const d = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    for (const name of ["formatDate", "formatTime", "toDayKey", "toInstant"]) assert.ok(d.includes(name), `${f} types ${name}`);
  }
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("time.js"));
});
