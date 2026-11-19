// Periods for the date filters (2.27): a week, month, quarter or year, or a
// custom range. Dates are ISO 'YYYY-MM-DD' strings in UTC, both ends
// inclusive. Pure functions only. Ported 1:1 from the workspace's
// apps/attrition-por-cohorte/src/ui/period.ts. 2.29: localized labels
// (`periodLabel(p, locale)`) and rolling presets (`presetPeriod`).
import { localeStrings } from "../locale.js";

export type Unit = "week" | "month" | "quarter" | "year";
/** A rolling preset (2.29): the last N days ("28d") or month, quarter, year to date; "all" (2.30) runs from the picker's `min`. All end today. */
export type PeriodPreset = `${number}d` | "mtd" | "qtd" | "ytd" | "all";
/** `preset` (2.29) marks a range picked as a rolling preset: write it to the URL as `period=28d`. */
export type Period = { unit: Unit | "custom"; from: string; to: string; preset?: PeriodPreset };

const d = (iso: string) => new Date(iso + "T00:00:00Z");
const iso = (x: Date) => x.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => { const x = d(s); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
export const addMonths = (s: string, n: number) => {
  const x = d(s);
  return iso(new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + n, 1)));
};
/** Today as a UTC day key, the same string as `toDayKey(new Date())`. */
export const todayIso = () => new Date().toISOString().slice(0, 10);

/** The first day of the unit that holds a date. Weeks start on Monday. */
export function startOf(unit: Unit, s: string): string {
  const x = d(s);
  const y = x.getUTCFullYear(), m = x.getUTCMonth();
  if (unit === "week") return addDays(s, -((x.getUTCDay() + 6) % 7));
  if (unit === "month") return iso(new Date(Date.UTC(y, m, 1)));
  if (unit === "quarter") return iso(new Date(Date.UTC(y, m - (m % 3), 1)));
  return `${y}-01-01`;
}
const stepMonths: Record<Exclude<Unit, "week">, number> = { month: 1, quarter: 3, year: 12 };
/** The last day of the unit that starts on `start`. */
export function endOf(unit: Unit, start: string): string {
  if (unit === "week") return addDays(start, 6);
  return addDays(addMonths(start, stepMonths[unit]), -1);
}
/** The week, month, quarter or year that holds a date: `periodOf("month", "2026-11-19")`. */
export const periodOf = (unit: Unit, s: string): Period => {
  const from = startOf(unit, s);
  return { unit, from, to: endOf(unit, from) };
};

// Months between two month starts, for stepping a custom range made of whole months.
const monthSpan = (from: string, to: string) => {
  const a = d(from), b = d(to);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
};
const wholeMonths = (p: Period) => p.from.slice(8) === "01" && addDays(p.to, 1).slice(8) === "01";

/** The period k steps later (k < 0: earlier). A custom range moves by its own length. */
export function shift(p: Period, k: number): Period {
  // Month, quarter or year to date steps to the whole unit before (or after) it.
  const toDate = p.preset && TO_DATE[p.preset as keyof typeof TO_DATE];
  if (toDate) return shift(periodOf(toDate, p.from), k);
  if (p.unit === "week") return periodOf("week", addDays(p.from, 7 * k));
  if (p.unit !== "custom") return periodOf(p.unit, addMonths(p.from, stepMonths[p.unit] * k));
  if (wholeMonths(p)) {
    const n = monthSpan(p.from, addDays(p.to, 1));
    return { unit: "custom", from: addMonths(p.from, n * k), to: addDays(addMonths(p.from, n * (k + 1)), -1) };
  }
  const days = Math.round((d(p.to).getTime() - d(p.from).getTime()) / 864e5) + 1;
  return { unit: "custom", from: addDays(p.from, days * k), to: addDays(p.to, days * k) };
}

/** In progress: today falls inside it, so its numbers are not final yet. */
export const isCurrent = (p: Period, today = todayIso()) => p.from <= today && today <= p.to;
/** Up to today: a period in progress stops at today. */
export const clipToday = (p: Period, today = todayIso()) => ({ from: p.from, to: p.to < today ? p.to : today });

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (s: string, withYear = true) => `${Number(s.slice(8))} ${MON[Number(s.slice(5, 7)) - 1]}${withYear ? ` ${s.slice(0, 4)}` : ""}`;
const month = (s: string, withYear = true) => `${MON[Number(s.slice(5, 7)) - 1]}${withYear ? ` ${s.slice(0, 4)}` : ""}`;

/**
 * "Nov 2026", "Q4 2026", "2026", "17–23 Nov 2026", "Sep – Nov 2026".
 * With a `locale` (2.29) the month names come from Intl in that language
 * ("nov. 2026", "16.–22. Nov 2026"). A preset reads as its name: "Last 28 days", "28 derniers jours".
 */
export function periodLabel(p: Period, locale?: string): string {
  if (p.preset) return presetLabel(p.preset, locale);
  if (locale) return localLabel(p, locale);
  if (p.unit === "year") return p.from.slice(0, 4);
  if (p.unit === "quarter") return `Q${Math.floor(Number(p.from.slice(5, 7)) / 3) + 1} ${p.from.slice(0, 4)}`;
  if (p.unit === "month") return month(p.from);
  const sameYear = p.from.slice(0, 4) === p.to.slice(0, 4);
  if (p.unit === "custom" && wholeMonths(p)) {
    const last = addDays(p.to, 1 - Number(p.to.slice(8)));
    if (last === p.from) return month(p.from);
    return `${month(p.from, !sameYear)} – ${month(last)}`;
  }
  const sameMonth = sameYear && p.from.slice(5, 7) === p.to.slice(5, 7);
  return sameMonth ? `${Number(p.from.slice(8))}–${day(p.to)}` : `${day(p.from, !sameYear)} – ${day(p.to)}`;
}

export const UNIT_LABEL: Record<Unit, string> = { week: "Week", month: "Month", quarter: "Quarter", year: "Year" };

const TO_DATE = { mtd: "month", qtd: "quarter", ytd: "year" } as const;

/**
 * A preset's dates on `today`: `presetPeriod("28d")` is the 28 days ending today. Null for an unknown id.
 * "all" (2.30) is `min` to today, so it needs `min` (the picker's): null without it.
 */
export function presetPeriod(id: string | null | undefined, today = todayIso(), min?: string): Period | null {
  if (id === "all") return min ? { unit: "custom", from: min, to: today, preset: "all" } : null;
  const days = /^([1-9]\d{0,3})d$/.exec(id ?? "");
  const unit = TO_DATE[id as keyof typeof TO_DATE];
  if (!days && !unit) return null;
  const from = days ? addDays(today, 1 - Number(days[1])) : startOf(unit, today);
  return { unit: "custom", from, to: today, preset: id as PeriodPreset };
}

/** A preset's name: "Last 28 days", "Month to date"; localized with `locale`. */
export function presetLabel(id: PeriodPreset, locale?: string, labels?: { lastDays?: (n: number) => string; mtd?: string; qtd?: string; ytd?: string; allTime?: string }): string {
  const L = localeStrings("period", locale, labels);
  if (id === "all") return L.allTime;
  return /^\d+d$/.test(id) ? L.lastDays(Number(id.slice(0, -1))) : L[id as "mtd" | "qtd" | "ytd"];
}

function localLabel(p: Period, locale: string): string {
  const fmt = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
  const de = /^de\b/i.test(locale);
  const mon = (s: string, withYear = true) => `${fmt.format(d(s))}${withYear ? ` ${s.slice(0, 4)}` : ""}`;
  const dd = (s: string) => `${Number(s.slice(8))}${de ? "." : ""}`;
  const dayL = (s: string, withYear = true) => `${dd(s)} ${mon(s, withYear)}`;
  if (p.unit === "year") return p.from.slice(0, 4);
  if (p.unit === "quarter") return localeStrings("period", locale).quarterLabel(Math.floor(Number(p.from.slice(5, 7)) / 3) + 1, p.from.slice(0, 4));
  if (p.unit === "month") return mon(p.from);
  const sameYear = p.from.slice(0, 4) === p.to.slice(0, 4);
  if (p.unit === "custom" && wholeMonths(p)) {
    const last = addDays(p.to, 1 - Number(p.to.slice(8)));
    return last === p.from ? mon(p.from) : `${mon(p.from, !sameYear)} – ${mon(last)}`;
  }
  const sameMonth = sameYear && p.from.slice(5, 7) === p.to.slice(5, 7);
  return sameMonth ? `${dd(p.from)}–${dayL(p.to)}` : `${dayL(p.from, !sameYear)} – ${dayL(p.to)}`;
}
