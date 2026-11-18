// Times and dates (2.21). The SDK runs DuckDB in UTC, and that stays: display
// code decides the zone. Two kinds of value reach an app:
//
// - Instants (an event time, "updated at", a deploy): shown in the VIEWER's
//   zone with a zone label, "14:05 CET". formatTime().
// - Day buckets (a dbt `date`, a UTC `date_trunc('day', …)`): a calendar day,
//   printed with no shift. formatDate(). A stored day never goes through the
//   viewer's zone, so 18 Nov stays 18 Nov in Los Angeles.
//
// toDayKey() is the one place a UTC "YYYY-MM-DD" key is built (URL state,
// joins, Map keys). Display code never calls getUTC*, never sets
// timeZone: "UTC" and never slices toISOString(): `mako-app-lint` flags it.

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// "2026-11-18 14:05:00", "2026-11-18T14:05:00.123": a DuckDB TIMESTAMP rendered
// without a zone. DuckDB runs in UTC, so it is a UTC wall time.
const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/;

/**
 * Any time value an app holds as a Date: a Date, epoch milliseconds, a bigint
 * of epoch microseconds (DuckDB TIMESTAMP through Arrow), an ISO string with
 * a zone, or a zone-less "YYYY-MM-DD hh:mm[:ss]" read as UTC. A bare
 * "YYYY-MM-DD" is that day's UTC midnight. Null, "" and unparsable values
 * give null.
 */
export function toInstant(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "bigint") return new Date(Number(value / 1000n));
  if (typeof value === "number") return Number.isFinite(value) ? new Date(value) : null;
  const s = String(value).trim();
  let m = DAY_RE.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = NAIVE_RE.exec(s);
  if (m) {
    const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0), ms));
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The UTC calendar day of a value, "YYYY-MM-DD": the key for URL state, joins and maps. Null when unparsable. */
export function toDayKey(value) {
  if (typeof value === "string" && DAY_RE.test(value.trim())) return value.trim();
  const d = toInstant(value);
  if (!d) return null;
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

const sameDay = (a, b, timeZone) => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(a) === f.format(b);
};

/**
 * An instant in the viewer's zone, with the zone's short name: "14:05 CET",
 * "18 Nov, 14:05 CET" when it is not today there, "18 Nov 2025, 14:05 CET"
 * in another year.
 *
 * Options: `date` ("auto" default, true, false), `seconds` (false),
 * `zoneName` (true: "CET"), `locale` (the browser's), `timeZone` (the
 * viewer's; tests and "as seen from Zurich" views only), `now` (for "auto").
 * Null or unparsable input gives "—".
 */
export function formatTime(value, opts = {}) {
  const d = toInstant(value);
  if (!d) return "—";
  const { date = "auto", seconds = false, zoneName = true, locale, timeZone, now = new Date() } = opts;
  const showDate = date === true || (date === "auto" && !sameDay(d, now, timeZone));
  const otherYear =
    showDate &&
    new Intl.DateTimeFormat("en", { timeZone, year: "numeric" }).format(d) !==
      new Intl.DateTimeFormat("en", { timeZone, year: "numeric" }).format(now);
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
    ...(showDate ? { day: "numeric", month: "short" } : {}),
    ...(otherYear ? { year: "numeric" } : {}),
    ...(zoneName ? { timeZoneName: "short" } : {}),
  }).format(d);
}

/**
 * A calendar day with no zone shift: "18 Nov 2026". Takes a "YYYY-MM-DD"
 * string, a day's UTC midnight (a parquet `date`), or anything toInstant
 * reads (its UTC day). Options: `year` ("auto" default: shown unless it is
 * the current UTC year; true; false), `weekday` (false; "short" or "long"),
 * `month` ("short" default; "long", "numeric"), `locale`, `now`.
 * Null or unparsable input gives "—".
 */
export function formatDate(value, opts = {}) {
  const key = toDayKey(value);
  if (!key) return "—";
  const { year = "auto", weekday = false, month = "short", locale, now = new Date() } = opts;
  const [y, m, d] = key.split("-").map(Number);
  const showYear = year === true || (year === "auto" && y !== now.getUTCFullYear());
  // The day's UTC noon, formatted in UTC: the printed day is the stored day, whatever the viewer's zone.
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    day: "numeric",
    month,
    ...(showYear ? { year: "numeric" } : {}),
    ...(weekday ? { weekday } : {}),
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}
