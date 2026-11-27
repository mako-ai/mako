"use client"

// TimePicker (2.32): calm, composable date & period picker built on stock shadcn
// Popover + Calendar (`./popover`, `./calendar`, `./button`). Ships on its own
// subpath (`@makoai/app-sdk/components/time-picker`) outside the `/components`
// barrel so apps without `react-day-picker` never load it.
//
// Reshapes cleanly via orthogonal props across every workspace dashboard archetype:
//   1. Time range (Evolution / Funnels):
//        shortcuts={["7d", "28d", "90d", "last_week", "mtd", "qtd", "all"]} navigation={false}
//   2. Time range + sub-day & time (Observability — Web / Hasura Performance):
//        shortcuts={["1h", "6h", "24h", "48h", "7d", "30d", "90d", "1y"]} includeTime timeRetentionMin={...}
//   3. Multi-unit cohort stepper (Sales / Acquisition):
//        periods={["day", "week", "month", "quarter", "year"]} navigation custom={false}
//   4. Single-unit cohort + future & extras (Renewals / Capacity — left rail auto-hides):
//        periods={["month"]} navigation custom={false} max="2027-06-30" extraOptions={[...]}
//   5. Whole-month range (Financial Model / Cohort MRR):
//        shortcuts={["ytd", "all"]} custom="month" navigation={false}
//   6. Single-day stepper (Daily Ops — left rail auto-hides):
//        periods={["day"]} navigation custom={false}

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { DateRange } from "react-day-picker"
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react"
import { localeLang, localeStrings } from "../locale.js"
import { cn } from "../menu/utils"
import { closePopovers, formatDate } from "../ui.js"
import { Button } from "./button"
import { Calendar } from "./calendar"
import {
  clipToday,
  isCurrent,
  periodLabel,
  periodOf,
  presetLabel,
  presetPeriod,
  shift,
  todayIso,
  type Period,
  type PeriodPreset,
  type Unit,
} from "./period"
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "./popover"

export { clipToday, isCurrent, periodLabel, periodOf, presetLabel, presetPeriod, shift, todayIso }
export type { Period, PeriodPreset, Unit }

/** Presets including rolling days (`7d`), to-date (`mtd`), `all`, sub-day (`1h`..`48h`), and `1y`. */
export type TimePreset = PeriodPreset | `${number}h` | "1y"

/** Quick shortcut identifier supported in the popover's slim side rail. */
export type TimeShortcut = TimePreset | "this_week" | "last_week" | "last_month" | "last_quarter"

/** Calendar-unit views supported in cohort / period-stepping mode. */
export type TimeUnit = "day" | Unit

/** Custom range granularity (`true` is an alias for `"day"`). */
export type CustomMode = boolean | "day" | "month"

/** Non-calendar bucket shown at the bottom of a cohort picker (e.g. "All months", "Missing date"). */
export interface TimeExtraOption {
  id: string
  label: string
  badge?: string | number
}

/**
 * Value emitted by TimePicker. Backwards-compatible with SDK `Period`:
 * standard day/week/month/quarter/year/custom ranges omit `fromTime` / `toTime`.
 */
export type TimeRange = Omit<Period, "preset"> & {
  preset?: TimePreset
  /** Local "HH:MM" start time when `includeTime` is enabled or a sub-day preset is active. */
  fromTime?: string
  /** Local "HH:MM" end time when `includeTime` is enabled or a sub-day preset is active. */
  toTime?: string
}

export interface TimePickerProps {
  /** Active period / range (compatible with SDK `Period`). */
  value: TimeRange
  /** Fired when a preset, shortcut, step arrow, period, or custom range is chosen. */
  onChange: (value: TimeRange) => void
  /**
   * Optional primary presets. Shown inline when `inlinePresets` is true, or prepended to the
   * popover shortcuts rail when `inlinePresets` is false.
   */
  presets?: readonly TimePreset[]
  /**
   * Quick shortcuts listed in the popover's left rail (e.g. `["1h", "24h", "7d", "30d", "all"]`).
   * Omit or pass `[]` on pure cohort pickers.
   */
  shortcuts?: readonly TimeShortcut[]
  /**
   * Render `presets` as a 1-click inline segmented bar next to the calendar trigger. Default `false`.
   */
  inlinePresets?: boolean
  /**
   * Show `<` / `>` period-stepping arrows flanking the trigger. Disabled for unsteppable states
   * (`preset === "all"`, sub-day presets, or an active `extraOption`) and at `min` / `max` bounds.
   * Defaults to `true` when `periods` is provided, otherwise `false`.
   */
  navigation?: boolean
  /**
   * Calendar-unit views offered for cohort / period-stepping dashboards
   * (e.g. `["day", "week", "month", "quarter", "year"]` or `["month"]`).
   * When only a single unit is provided without `custom` or `shortcuts`, the left rail collapses automatically.
   */
  periods?: readonly TimeUnit[]
  /**
   * Custom range picker mode: `"day"` (or `true`, default) shows a 2-month day calendar;
   * `"month"` shows a 2-click start-month → end-month 3×4 grid; `false` disables custom ranges.
   */
  custom?: CustomMode
  /**
   * Show compact `Start HH:MM` / `End HH:MM` inputs + `Apply` in the day-range calendar footer
   * (for observability dashboards like Web / Hasura Performance). Default `false`.
   */
  includeTime?: boolean
  /**
   * Earliest ISO day (`YYYY-MM-DD`) that still has sub-day (hourly/minute) granularity.
   * When `includeTime` is true and the picked range starts earlier than `timeRetentionMin`,
   * the time inputs automatically lock to whole days with an inline retention note.
   */
  timeRetentionMin?: string
  /**
   * Optional domain buckets rendered below a divider in the popover (e.g. `"All months"`, `"Missing date"`).
   */
  extraOptions?: readonly TimeExtraOption[]
  /** Currently active `extraOptions` id (takes display precedence over `value` until cleared or a period is picked). */
  activeExtra?: string | null
  /** Fired when an extra option is selected, or called with `null` when a calendar period is picked. */
  onExtraChange?: (id: string | null) => void
  /** Earliest selectable ISO day (`YYYY-MM-DD`). Anchors `"all"` and bounds the calendar. */
  min?: string
  /** Latest selectable ISO day (`YYYY-MM-DD`). Defaults to `todayIso()`. Pass a future date to enable future periods. */
  max?: string
  /** Clamp rolling `Nd` / to-date presets so `from` never precedes `min`. Default `true`. */
  clampToMin?: boolean
  /** BCP 47 locale tag (e.g. `"en"`, `"fr-CH"`). */
  locale?: string
  /** Accessible group/trigger label. Default `"Time"`. */
  label?: string
  /** Extra classes on the outer container. */
  className?: string
  /** Extra classes on the trigger button (e.g. to override fixed width). */
  triggerClassName?: string
}

type ResolvedItem = {
  id: TimeShortcut
  label: string
  shortLabel: string
  value: TimeRange
  displayTo: string
  clamped: boolean
}

const ALL_SHORT: Record<string, string> = {
  en: "All",
  fr: "Tout",
  de: "Alle",
  it: "Tutto",
  es: "Todo",
  pl: "Wszystko",
  pt: "Tudo",
}

const DAY_LABEL: Record<string, string> = {
  en: "Day",
  fr: "Jour",
  de: "Tag",
  it: "Giorno",
  es: "Día",
  pl: "Dzień",
  pt: "Dia",
}

const LAST_YEAR_LABEL: Record<string, string> = {
  en: "Last year",
  fr: "Dernière année",
  de: "Letztes Jahr",
  it: "Ultimo anno",
  es: "Último año",
  pl: "Ostatni rok",
  pt: "Último ano",
}

const EXTRA_SHORTCUT_LABELS: Record<
  "this_week" | "last_week" | "last_month" | "last_quarter",
  Record<string, string>
> = {
  this_week: {
    en: "This week",
    fr: "Cette semaine",
    de: "Diese Woche",
    it: "Questa settimana",
    es: "Esta semana",
    pl: "Ten tydzień",
    pt: "Esta semana",
  },
  last_week: {
    en: "Last week",
    fr: "Semaine dernière",
    de: "Letzte Woche",
    it: "Settimana scorsa",
    es: "Semana pasada",
    pl: "Poprzedni tydzień",
    pt: "Semana passada",
  },
  last_month: {
    en: "Last month",
    fr: "Mois dernier",
    de: "Letzter Monat",
    it: "Mese scorso",
    es: "Mes pasado",
    pl: "Poprzedni miesiąc",
    pt: "Mês passado",
  },
  last_quarter: {
    en: "Last quarter",
    fr: "Trimestre dernier",
    de: "Letztes Quartal",
    it: "Trimestre scorso",
    es: "Trimestre pasado",
    pl: "Poprzedni kwartał",
    pt: "Trimestre passado",
  },
}

function isSingleDay(p: TimeRange): boolean {
  return !p.preset && p.unit === "custom" && p.from === p.to && !hasExplicitTimes(p)
}

function hasExplicitTimes(p: TimeRange): boolean {
  if (!p.fromTime && !p.toTime) return false
  return (p.fromTime ?? "00:00") !== "00:00" || (p.toTime ?? "23:59") !== "23:59"
}

function normalizeCustomMode(custom: CustomMode): "day" | "month" | false {
  if (custom === true) return "day"
  return custom
}

function parseIsoDay(iso: string): Date {
  return new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
}

function formatIsoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function startOfMonthDate(iso: string): Date {
  return new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, 1)
}

function monthIndex(d: Date): number {
  return d.getFullYear() * 12 + d.getMonth()
}

function ymIndex(ym: string): number {
  return Number(ym.slice(0, 4)) * 12 + (Number(ym.slice(5, 7)) - 1)
}

function monthSpanCount(fromYm: string, toYm: string): number {
  return Math.max(1, ymIndex(toYm) - ymIndex(fromYm) + 1)
}

function localTimeZoneShort(locale?: string): string {
  try {
    const parts = new Intl.DateTimeFormat(locale, { timeZoneName: "short" }).formatToParts(new Date())
    return parts.find(p => p.type === "timeZoneName")?.value ?? ""
  } catch {
    return ""
  }
}

function subDayLabel(hours: number, lang: string): string {
  if (hours === 1) {
    const one: Record<string, string> = {
      en: "Last hour",
      fr: "Dernière heure",
      de: "Letzte Stunde",
      it: "Ultima ora",
      es: "Última hora",
      pl: "Ostatnia godzina",
      pt: "Última hora",
    }
    return one[lang] ?? "Last hour"
  }
  const many: Record<string, (h: number) => string> = {
    en: h => `Last ${h} hours`,
    fr: h => `${h} dernières heures`,
    de: h => `Letzte ${h} Stunden`,
    it: h => `Ultime ${h} ore`,
    es: h => `Últimas ${h} horas`,
    pl: h => `Ostatnie ${h} godz.`,
    pt: h => `Últimas ${h} horas`,
  }
  return (many[lang] ?? many.en)(hours)
}

function resolveSubDayBounds(hours: number): { from: string; to: string; fromTime: string; toTime: string } {
  const now = new Date()
  const start = new Date(now.getTime() - hours * 3_600_000)
  const pad = (n: number) => String(n).padStart(2, "0")
  return {
    from: formatIsoDay(start),
    to: formatIsoDay(now),
    fromTime: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
    toTime: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  }
}

function isoWeekNumber(iso: string): number {
  const d = parseIsoDay(iso)
  const dayNum = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - dayNum + 3)
  const firstThu = new Date(d.getFullYear(), 0, 4)
  const firstDayNum = (firstThu.getDay() + 6) % 7
  firstThu.setDate(firstThu.getDate() - firstDayNum + 3)
  return 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 86_400_000))
}

function isoWeekYear(iso: string): number {
  const d = parseIsoDay(iso)
  const dayNum = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - dayNum + 3)
  return d.getFullYear()
}

function formatMonthShort(year: number, monthIdx: number, locale?: string): string {
  const iso = `${year}-${String(monthIdx + 1).padStart(2, "0")}-01`
  return formatDate(iso, { locale, year: false }).replace(/\s*\d+\.?\s*/g, "").trim()
}

function formatYm(ym: string, locale?: string, withYear = true): string {
  const y = Number(ym.slice(0, 4))
  const m = Number(ym.slice(5, 7)) - 1
  const mon = formatMonthShort(y, m, locale)
  return withYear ? `${mon} ${y}` : mon
}

function formatMonthRange(fromYm: string, toYm: string, locale?: string): string {
  if (fromYm === toYm) return formatYm(fromYm, locale, true)
  const sameYear = fromYm.slice(0, 4) === toYm.slice(0, 4)
  return `${formatYm(fromYm, locale, !sameYear)} – ${formatYm(toYm, locale, true)}`
}

function isWholeMonthSpan(p: TimeRange): boolean {
  if (p.from.slice(8, 10) !== "01") return false
  const end = periodOf("month", p.to).to
  return p.to === end
}

function quarterMonthSpan(year: number, q: number, locale?: string): string {
  const m0 = (q - 1) * 3
  return `${formatMonthShort(year, m0, locale)} – ${formatMonthShort(year, m0 + 2, locale)}`
}

function weeksInIsoYear(year: number, min?: string, hi?: string): Period[] {
  const out: Period[] = []
  let p = periodOf("week", `${year}-12-28`)
  while (isoWeekYear(p.from) === year) {
    const withinMax = !hi || p.from <= hi
    const withinMin = !min || p.to >= min
    if (withinMax && withinMin) out.push(p)
    p = shift(p, -1)
  }
  return out
}

function monthsInYear(year: number): Period[] {
  const out: Period[] = []
  for (let m = 0; m < 12; m++) {
    const iso = `${year}-${String(m + 1).padStart(2, "0")}-01`
    out.push(periodOf("month", iso))
  }
  return out
}

function quartersInYear(year: number): Period[] {
  const out: Period[] = []
  for (let q = 4; q >= 1; q--) {
    const m = (q - 1) * 3 + 1
    out.push(periodOf("quarter", `${year}-${String(m).padStart(2, "0")}-01`))
  }
  return out
}

function yearsInRange(min?: string, hi?: string): Period[] {
  const maxY = hi ? Number(hi.slice(0, 4)) : Number(todayIso().slice(0, 4))
  const minY = min ? Number(min.slice(0, 4)) : maxY - 3
  const out: Period[] = []
  for (let y = maxY; y >= minY; y--) {
    out.push(periodOf("year", `${y}-01-01`))
  }
  return out
}

function compactWeekTriggerLabel(p: TimeRange, locale?: string): string {
  const wk = isoWeekNumber(p.from)
  const sameMonth = p.from.slice(0, 7) === p.to.slice(0, 7)
  if (sameMonth) {
    return `W${wk} · ${formatDate(p.from, { locale, year: false })}–${Number(p.to.slice(8))}`
  }
  return `W${wk} · ${formatRange(p.from, p.to, locale, false)}`
}

function daySpan(from: string, to: string): number {
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)))
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)))
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1)
}

function clampDay(day: string, min?: string, max?: string): string {
  let out = day
  if (min && out < min) out = min
  if (max && out > max) out = max
  return out
}

function formatRange(from: string, to: string, locale?: string, year: boolean | "auto" = "auto"): string {
  if (from === to) return formatDate(from, { locale, year })
  const sameYear = from.slice(0, 4) === to.slice(0, 4)
  return `${formatDate(from, { locale, year: sameYear ? false : true })} – ${formatDate(to, {
    locale,
    year: sameYear ? year : true,
  })}`
}

function formatTimedRange(from: string, to: string, fromTime: string, toTime: string, locale?: string): string {
  if (from === to) {
    return `${formatDate(from, { locale, year: false })}, ${fromTime}–${toTime}`
  }
  return `${formatDate(from, { locale, year: false })} ${fromTime} – ${formatDate(to, { locale, year: false })} ${toTime}`
}

function formatDayCount(days: number): string {
  return days === 1 ? "1 day" : `${days} days`
}

function shortPresetLabel(id: TimePreset, locale?: string): string {
  if (id === "all") return ALL_SHORT[localeLang(locale)] ?? "All"
  if (id === "mtd") return "MTD"
  if (id === "qtd") return "QTD"
  if (id === "ytd") return "YTD"
  if (id === "1y") return "1y"
  return id
}

function sameValue(a: TimeRange, b: TimeRange): boolean {
  if (a.preset || b.preset) return a.preset === b.preset
  return (
    a.unit === b.unit &&
    a.from === b.from &&
    a.to === b.to &&
    (a.fromTime ?? "") === (b.fromTime ?? "") &&
    (a.toTime ?? "") === (b.toTime ?? "")
  )
}

function isSteppable(p: TimeRange): boolean {
  if (p.preset === "all") return false
  if (p.preset && /^\d+h$/.test(p.preset)) return false
  return true
}

function shiftValue(v: TimeRange, k: number): TimeRange {
  const base: Period = {
    unit: v.unit,
    from: v.from,
    to: v.to,
    preset:
      v.preset && v.preset !== "1y" && !/^\d+h$/.test(v.preset) ? (v.preset as PeriodPreset) : undefined,
  }
  return shift(base, k)
}

function resolveShortcut(
  id: TimeShortcut,
  today: string,
  hi: string,
  min?: string,
  clampToMin = true,
  locale?: string,
): ResolvedItem | null {
  const lang = localeLang(locale)
  // Rolling / to-date shortcuts anchor to `today` (capped at `hi` if data ends earlier),
  // whereas `"all"` spans the full selectable window `min → hi` (including future forecast years).
  const anchor = hi < today ? hi : today
  if (id === "this_week" || id === "last_week" || id === "last_month" || id === "last_quarter") {
    const period =
      id === "this_week"
        ? periodOf("week", anchor)
        : id === "last_week"
          ? shift(periodOf("week", anchor), -1)
          : id === "last_month"
            ? shift(periodOf("month", anchor), -1)
            : shift(periodOf("quarter", anchor), -1)
    if (min && period.to < min) return null
    const label = EXTRA_SHORTCUT_LABELS[id][lang] ?? EXTRA_SHORTCUT_LABELS[id].en
    const displayTo = period.to > anchor ? anchor : period.to
    return { id, label, shortLabel: label, value: period, displayTo, clamped: false }
  }

  const hourMatch = /^([1-9]\d*)h$/.exec(id)
  if (hourMatch) {
    const hours = Number(hourMatch[1])
    const bounds = resolveSubDayBounds(hours)
    const label = subDayLabel(hours, lang)
    return {
      id,
      label,
      shortLabel: id,
      value: { unit: "custom", ...bounds, preset: id as TimePreset },
      displayTo: bounds.to,
      clamped: false,
    }
  }

  if (id === "1y") {
    const raw = presetPeriod("365d", anchor, min)
    if (!raw) return null
    const clamped = Boolean(clampToMin && min && raw.from < min)
    const from = clamped && min ? min : raw.from
    return {
      id,
      label: LAST_YEAR_LABEL[lang] ?? "Last year",
      shortLabel: "1y",
      value: { unit: "custom", from, to: raw.to, preset: "1y" },
      displayTo: raw.to,
      clamped,
    }
  }

  const raw = presetPeriod(id, id === "all" ? hi : anchor, min)
  if (!raw) return null
  const clamped = Boolean(clampToMin && min && raw.from < min)
  const period = clamped && min ? { ...raw, from: min } : raw
  const stdId = id as PeriodPreset
  return {
    id,
    label: presetLabel(stdId, locale),
    shortLabel: shortPresetLabel(stdId, locale),
    value: period,
    displayTo: period.to,
    clamped,
  }
}

function useIsNarrow(breakpointPx = 640): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(`(max-width: ${breakpointPx}px)`).matches
      : false,
  )
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
    const mq = window.matchMedia(`(max-width: ${breakpointPx}px)`)
    const update = () => setNarrow(mq.matches)
    update()
    mq.addEventListener("change", update)
    return () => mq.removeEventListener("change", update)
  }, [breakpointPx])
  return narrow
}

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
const PILL_BASE = cn(
  "inline-flex h-full items-center justify-center gap-1.5 rounded-[5px] px-2.5 text-[13px] font-medium whitespace-nowrap tabular-nums",
  "transition-[background-color,color,box-shadow] duration-150",
  FOCUS_RING,
)
const PILL_ACTIVE = "bg-card text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.06)] ring-1 ring-border/75"
const PILL_IDLE = "text-muted-foreground hover:text-foreground"

export const TimePicker = memo(function TimePicker({
  value,
  onChange,
  presets,
  shortcuts,
  inlinePresets = false,
  navigation,
  periods,
  custom = true,
  includeTime = false,
  timeRetentionMin,
  extraOptions,
  activeExtra = null,
  onExtraChange,
  min,
  max,
  clampToMin = true,
  locale,
  label: labelProp,
  className,
  triggerClassName,
}: TimePickerProps) {
  const L = localeStrings("period", locale)
  const ariaLabel = labelProp ?? L.time
  const today = todayIso()
  const hi = max ?? today
  const customMode = normalizeCustomMode(custom)
  const showNavigation = navigation ?? Boolean(periods?.length)
  const isNarrow = useIsNarrow(640)

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const inlineItems = useMemo<ResolvedItem[]>(() => {
    if (!inlinePresets || !presets?.length) return []
    return presets.flatMap(id => {
      const item = resolveShortcut(id, today, hi, min, clampToMin, locale)
      return item ? [item] : []
    })
  }, [inlinePresets, presets, today, hi, min, clampToMin, locale])

  const railItems = useMemo<ResolvedItem[]>(() => {
    const ids: TimeShortcut[] = []
    if (!inlinePresets && presets?.length) ids.push(...presets)
    if (shortcuts?.length) {
      for (const s of shortcuts) {
        if (!ids.includes(s)) ids.push(s)
      }
    }
    return ids.flatMap(id => {
      const item = resolveShortcut(id, today, hi, min, clampToMin, locale)
      return item ? [item] : []
    })
  }, [inlinePresets, presets, shortcuts, today, hi, min, clampToMin, locale])

  const activeExtraObj = useMemo(
    () => (activeExtra ? extraOptions?.find(o => o.id === activeExtra) ?? null : null),
    [activeExtra, extraOptions],
  )

  const activeInline = useMemo(
    () => (activeExtraObj ? null : inlineItems.find(item => sameValue(item.value, value)) ?? null),
    [activeExtraObj, inlineItems, value],
  )
  const activeRail = useMemo(
    () => (activeExtraObj ? null : railItems.find(item => sameValue(item.value, value)) ?? null),
    [activeExtraObj, railItems, value],
  )

  const effectiveTo = value.to > hi ? hi : value.to
  const effectiveFrom = min && value.from < min ? min : value.from
  const fullRangeText = formatRange(effectiveFrom, effectiveTo, locale, true)

  const triggerText = useMemo(() => {
    if (activeExtraObj) return activeExtraObj.label
    if (inlinePresets) {
      return formatRange(effectiveFrom, effectiveTo, locale, false)
    }
    if (activeRail) return activeRail.label
    if (includeTime && hasExplicitTimes(value)) {
      return formatTimedRange(effectiveFrom, effectiveTo, value.fromTime ?? "00:00", value.toTime ?? "23:59", locale)
    }
    if (isSingleDay(value)) return formatDate(value.from, { locale, year: true })
    if (value.unit === "week") return compactWeekTriggerLabel(value, locale)
    if (value.unit === "custom" && customMode === "month" && isWholeMonthSpan(value)) {
      return formatMonthRange(value.from.slice(0, 7), value.to.slice(0, 7), locale)
    }
    if (value.unit === "custom") return formatRange(effectiveFrom, effectiveTo, locale, false)
    return periodLabel(value as Period, locale)
  }, [activeExtraObj, inlinePresets, effectiveFrom, effectiveTo, activeRail, includeTime, value, customMode, locale])

  const steppable = showNavigation && !activeExtraObj && isSteppable(value)
  const prevPeriod = useMemo(() => (steppable ? shiftValue(value, -1) : null), [steppable, value])
  const nextPeriod = useMemo(() => (steppable ? shiftValue(value, 1) : null), [steppable, value])
  const canPrev = Boolean(prevPeriod && (!min || prevPeriod.to >= min))
  const canNext = Boolean(nextPeriod && nextPeriod.from <= hi)

  const handleOpenChange = useCallback((next: boolean) => {
    if (next) closePopovers()
    setOpen(next)
  }, [])

  const commit = useCallback(
    (p: TimeRange) => {
      if (activeExtraObj) onExtraChange?.(null)
      onChange(p)
      setOpen(false)
    },
    [activeExtraObj, onExtraChange, onChange],
  )

  const pickExtra = useCallback(
    (id: string) => {
      onExtraChange?.(id)
      setOpen(false)
    },
    [onExtraChange],
  )

  const customActive = inlinePresets && !activeInline
  const showPopover =
    customMode !== false || railItems.length > 0 || Boolean(periods?.length) || Boolean(extraOptions?.length)

  const popoverBody = showPopover ? (
    <PopoverContent
      ref={contentRef}
      tabIndex={-1}
      align="start"
      sideOffset={6}
      aria-label={L.menu}
      onOpenAutoFocus={e => {
        e.preventDefault()
        contentRef.current?.focus({ preventScroll: true })
      }}
      onInteractOutside={e => {
        if (rootRef.current?.contains(e.target as Node)) e.preventDefault()
      }}
      className="z-[70] w-auto max-w-[calc(100vw-24px)] overflow-hidden rounded-[12px] border border-border bg-popover p-0 text-popover-foreground shadow-[0_14px_34px_-10px_rgb(0_0_0/0.18)] outline-none"
    >
      <TimePickerPopover
        value={value}
        railItems={railItems}
        periods={periods}
        customMode={customMode}
        includeTime={includeTime}
        timeRetentionMin={timeRetentionMin}
        extraOptions={extraOptions}
        activeExtra={activeExtra}
        min={min}
        hi={hi}
        today={today}
        locale={locale}
        isNarrow={isNarrow}
        onPick={commit}
        onPickExtra={pickExtra}
      />
    </PopoverContent>
  ) : null

  if (inlinePresets) {
    return (
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverAnchor asChild>
          <div
            ref={rootRef}
            data-slot="time-picker"
            data-mode="inline"
            role="group"
            aria-label={ariaLabel}
            className={cn("inline-flex max-w-full items-center gap-1.5", className)}
          >
            <div className="inline-flex h-[34px] max-w-full flex-wrap items-center gap-[2px] rounded-[8px] border border-border/80 bg-muted/80 p-[3px] max-[769px]:h-auto max-[769px]:w-full">
              {inlineItems.map(item => {
                const active = activeInline?.id === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-slot="time-picker-preset"
                    aria-pressed={active}
                    onClick={() => {
                      if (activeExtraObj) onExtraChange?.(null)
                      setOpen(false)
                      onChange(item.value)
                    }}
                    className={cn(
                      PILL_BASE,
                      active ? PILL_ACTIVE : PILL_IDLE,
                      "max-[769px]:h-[28px] max-[769px]:flex-1",
                    )}
                  >
                    {item.shortLabel}
                  </button>
                )
              })}

              {showPopover && (
                <>
                  {inlineItems.length > 0 && (
                    <span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-border max-[769px]:hidden" />
                  )}
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      data-slot="time-picker-custom"
                      aria-label={`${ariaLabel}: ${customActive ? fullRangeText : L.custom}`}
                      aria-expanded={open}
                      className={cn(
                        PILL_BASE,
                        "w-[156px] shrink-0 justify-center",
                        customActive ? PILL_ACTIVE : open ? "bg-card/75 text-foreground" : PILL_IDLE,
                        "max-[769px]:h-[28px] max-[769px]:w-full max-[769px]:flex-1",
                        triggerClassName,
                      )}
                    >
                      <CalendarDays
                        className={cn(
                          "size-3.5 shrink-0",
                          customActive ? "text-muted-foreground" : "opacity-70",
                        )}
                      />
                      <span className="truncate">{triggerText}</span>
                    </button>
                  </PopoverTrigger>
                </>
              )}
            </div>

            {steppable && prevPeriod && nextPeriod && (
              <div
                data-slot="time-picker-nav"
                className="inline-flex h-[34px] shrink-0 items-stretch rounded-[8px] border border-border bg-background shadow-[0_1px_2px_rgb(0_0_0/0.05)]"
              >
                <StepButton
                  direction="prev"
                  label={L.previous}
                  disabled={!canPrev}
                  onClick={() => onChange(prevPeriod)}
                  className="rounded-l-[7px] border-r border-border"
                />
                <StepButton
                  direction="next"
                  label={L.next}
                  disabled={!canNext}
                  onClick={() => onChange(nextPeriod)}
                  className="rounded-r-[7px]"
                />
              </div>
            )}
          </div>
        </PopoverAnchor>
        {popoverBody}
      </Popover>
    )
  }

  const showNavFrame = showNavigation && !activeExtraObj && isSteppable(value)
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverAnchor asChild>
        <div
          ref={rootRef}
          data-slot="time-picker"
          data-mode="compact"
          role="group"
          aria-label={ariaLabel}
          className={cn(
            "inline-flex h-[34px] items-stretch rounded-[8px] border border-border bg-background text-[14px] font-medium text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.05)] transition-colors duration-150",
            open && "border-foreground/25",
            className,
          )}
        >
          {showNavigation && (
            <StepButton
              direction="prev"
              label={L.previous}
              disabled={!showNavFrame || !canPrev}
              onClick={() => prevPeriod && onChange(prevPeriod)}
              className="rounded-l-[7px] border-r border-border"
            />
          )}

          <PopoverTrigger asChild>
            <button
              type="button"
              data-slot="time-picker-trigger"
              aria-label={`${ariaLabel}: ${triggerText}`}
              aria-expanded={open}
              className={cn(
                "inline-flex shrink-0 items-center gap-2 bg-transparent px-3 text-[14px] font-medium text-foreground transition-colors hover:bg-accent",
                includeTime ? "w-[236px]" : "w-[212px]",
                !showNavigation && "rounded-[7px]",
                FOCUS_RING,
                triggerClassName,
              )}
            >
              <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-left tabular-nums">{triggerText}</span>
              <ChevronDown
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
                  open && "rotate-180",
                )}
              />
            </button>
          </PopoverTrigger>

          {showNavigation && (
            <StepButton
              direction="next"
              label={L.next}
              disabled={!showNavFrame || !canNext}
              onClick={() => nextPeriod && onChange(nextPeriod)}
              className="rounded-r-[7px] border-l border-border"
            />
          )}
        </div>
      </PopoverAnchor>
      {popoverBody}
    </Popover>
  )
})

function StepButton({
  direction,
  label,
  disabled,
  onClick,
  className,
}: {
  direction: "prev" | "next"
  label: string
  disabled: boolean
  onClick: () => void
  className?: string
}) {
  const Icon = direction === "prev" ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      data-slot={direction === "prev" ? "time-picker-prev" : "time-picker-next"}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex w-8 items-center justify-center bg-transparent text-muted-foreground transition-colors",
        "enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-35",
        FOCUS_RING,
        className,
      )}
    >
      <Icon className="size-4" />
    </button>
  )
}

function TimePickerPopover({
  value,
  railItems,
  periods,
  customMode,
  includeTime,
  timeRetentionMin,
  extraOptions,
  activeExtra,
  min,
  hi,
  today,
  locale,
  isNarrow,
  onPick,
  onPickExtra,
}: {
  value: TimeRange
  railItems: ResolvedItem[]
  periods?: readonly TimeUnit[]
  customMode: "day" | "month" | false
  includeTime: boolean
  timeRetentionMin?: string
  extraOptions?: readonly TimeExtraOption[]
  activeExtra: string | null
  min?: string
  hi: string
  today: string
  locale?: string
  isNarrow: boolean
  onPick: (p: TimeRange) => void
  onPickExtra: (id: string) => void
}) {
  const L = localeStrings("period", locale)
  const lang = localeLang(locale)
  const unitLabel = (u: TimeUnit) => (u === "day" ? (DAY_LABEL[lang] ?? "Day") : L[u])
  const hasUnits = Boolean(periods?.length)
  const showUnitTabs = Boolean(periods && (periods.length > 1 || (periods.length === 1 && customMode !== false)))
  const showRail = railItems.length > 0 || showUnitTabs
  const periodsOnlyRail = showUnitTabs && railItems.length === 0

  const initialPane: TimeUnit | "custom" =
    hasUnits && isSingleDay(value) && periods!.includes("day")
      ? "day"
      : hasUnits && value.unit !== "custom" && periods!.includes(value.unit)
        ? value.unit
        : customMode !== false
          ? "custom"
          : (periods?.[0] ?? "custom")
  const [pane, setPane] = useState<TimeUnit | "custom">(initialPane)

  const [pickingFrom, setPickingFrom] = useState<string | null>(null)
  const [hoverDay, setHoverDay] = useState<string | null>(null)
  const [draftRange, setDraftRange] = useState<{ from: string; to: string } | null>(null)
  const [startTime, setStartTime] = useState<string>(() => value.fromTime ?? "00:00")
  const [endTime, setEndTime] = useState<string>(() => value.toTime ?? "23:59")

  const [pickingMonthFrom, setPickingMonthFrom] = useState<string | null>(null)
  const [hoverMonth, setHoverMonth] = useState<string | null>(null)

  const minDate = useMemo(() => (min ? parseIsoDay(min) : undefined), [min])
  const maxDate = useMemo(() => parseIsoDay(hi), [hi])
  const startMonth = useMemo(() => (min ? startOfMonthDate(min) : undefined), [min])
  const endMonth = useMemo(() => startOfMonthDate(hi), [hi])

  const spanMonths = startMonth ? monthIndex(endMonth) - monthIndex(startMonth) + 1 : 2
  const numMonths = isNarrow || spanMonths <= 1 ? 1 : 2

  const defaultMonth = useMemo(() => {
    const anchorIso = clampDay(value.to, min, hi)
    const anchor = startOfMonthDate(anchorIso)
    if (numMonths === 1) return anchor
    const prev = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1)
    if (startMonth && monthIndex(prev) < monthIndex(startMonth)) return startMonth
    return prev
  }, [value.to, min, hi, numMonths, startMonth])

  const committedFrom = clampDay(value.from, min, hi)
  const committedTo = clampDay(value.to, min, hi)

  const previewRange = useMemo<{ from: string; to: string | null }>(() => {
    if (pickingFrom) {
      if (!hoverDay) return { from: pickingFrom, to: null }
      return pickingFrom <= hoverDay
        ? { from: pickingFrom, to: hoverDay }
        : { from: hoverDay, to: pickingFrom }
    }
    if (draftRange) return draftRange
    return { from: committedFrom, to: committedTo >= committedFrom ? committedTo : committedFrom }
  }, [pickingFrom, hoverDay, draftRange, committedFrom, committedTo])

  const calendarSelected = useMemo<DateRange>(() => {
    return {
      from: parseIsoDay(previewRange.from),
      to: previewRange.to ? parseIsoDay(previewRange.to) : undefined,
    }
  }, [previewRange])

  const timeLockedByRetention = Boolean(
    includeTime && timeRetentionMin && previewRange.from < timeRetentionMin,
  )
  const tzLabel = useMemo(() => (includeTime ? localTimeZoneShort(locale) : ""), [includeTime, locale])

  const handleCalendarSelect = useCallback(
    (_range: DateRange | undefined, triggerDate: Date, modifiers: Record<string, boolean>) => {
      if (!triggerDate || modifiers.disabled) return
      const clicked = formatIsoDay(triggerDate)
      if (pickingFrom === null) {
        setPickingFrom(clicked)
        setHoverDay(null)
        return
      }
      const from = pickingFrom <= clicked ? pickingFrom : clicked
      const to = pickingFrom <= clicked ? clicked : pickingFrom
      setPickingFrom(null)
      setHoverDay(null)
      if (includeTime) {
        setDraftRange({ from, to })
        return
      }
      onPick({ unit: "custom", from, to })
    },
    [pickingFrom, includeTime, onPick],
  )

  const applyTimedRange = useCallback(() => {
    const from = pickingFrom ?? draftRange?.from ?? committedFrom
    const to = pickingFrom ?? draftRange?.to ?? committedTo
    const lo = from <= to ? from : to
    const hiDay = from <= to ? to : from
    const locked = Boolean(timeRetentionMin && lo < timeRetentionMin)
    const ft = locked ? "00:00" : startTime || "00:00"
    const tt = locked ? "23:59" : endTime || "23:59"
    setPickingFrom(null)
    setHoverDay(null)
    setDraftRange(null)
    if (ft === "00:00" && tt === "23:59") {
      onPick({ unit: "custom", from: lo, to: hiDay })
    } else {
      onPick({ unit: "custom", from: lo, to: hiDay, fromTime: ft, toTime: tt })
    }
  }, [pickingFrom, draftRange, committedFrom, committedTo, timeRetentionMin, startTime, endTime, onPick])

  const handleDayMouseEnter = useCallback(
    (day: Date, modifiers: Record<string, boolean>) => {
      if (pickingFrom === null || modifiers.disabled) return
      setHoverDay(formatIsoDay(day))
    },
    [pickingFrom],
  )

  const dayDefaultMonth = useMemo(() => {
    const anchorIso = clampDay(isSingleDay(value) ? value.from : value.to, min, hi)
    return startOfMonthDate(anchorIso)
  }, [value, min, hi])

  const selectedSingleDay = useMemo(
    () => (!activeExtra && isSingleDay(value) ? parseIsoDay(value.from) : undefined),
    [activeExtra, value],
  )

  const handleSingleDaySelect = useCallback(
    (day: Date | undefined) => {
      if (!day) return
      const iso = formatIsoDay(day)
      if ((min && iso < min) || iso > hi) return
      onPick({ unit: "custom", from: iso, to: iso })
    },
    [min, hi, onPick],
  )

  const disabledMatchers = useMemo(() => {
    const out: Array<{ before: Date } | { after: Date }> = [{ after: maxDate }]
    if (minDate) out.unshift({ before: minDate })
    return out
  }, [minDate, maxDate])

  const minYear = min ? Number(min.slice(0, 4)) : Number(hi.slice(0, 4)) - 3
  const maxYear = Number(hi.slice(0, 4))
  const [browseYear, setBrowseYear] = useState<number>(() => {
    const y =
      value.unit === "week"
        ? isoWeekYear(value.from)
        : Number(clampDay(pane === "custom" && customMode === "month" ? value.to : value.from, min, hi).slice(0, 4))
    return Math.min(maxYear, Math.max(minYear, y))
  })

  const yearWeeks = useMemo(
    () => (pane === "week" ? weeksInIsoYear(browseYear, min, hi) : []),
    [pane, browseYear, min, hi],
  )
  const yearMonths = useMemo(
    () => (pane === "month" || (pane === "custom" && customMode === "month") ? monthsInYear(browseYear) : []),
    [pane, customMode, browseYear],
  )
  const yearQuarters = useMemo(() => (pane === "quarter" ? quartersInYear(browseYear) : []), [pane, browseYear])
  const allYears = useMemo(() => (pane === "year" ? yearsInRange(min, hi) : []), [pane, min, hi])

  const committedFromYm = committedFrom.slice(0, 7)
  const committedToYm = committedTo.slice(0, 7)
  const previewMonthRange = useMemo<{ from: string; to: string | null }>(() => {
    if (!pickingMonthFrom) {
      return { from: committedFromYm, to: committedToYm >= committedFromYm ? committedToYm : committedFromYm }
    }
    if (!hoverMonth) return { from: pickingMonthFrom, to: null }
    return pickingMonthFrom <= hoverMonth
      ? { from: pickingMonthFrom, to: hoverMonth }
      : { from: hoverMonth, to: pickingMonthFrom }
  }, [pickingMonthFrom, hoverMonth, committedFromYm, committedToYm])

  const handleMonthRangePick = useCallback(
    (ym: string) => {
      if (pickingMonthFrom === null) {
        setPickingMonthFrom(ym)
        setHoverMonth(null)
        return
      }
      const lo = pickingMonthFrom <= ym ? pickingMonthFrom : ym
      const hiYm = pickingMonthFrom <= ym ? ym : pickingMonthFrom
      const startP = periodOf("month", `${lo}-01`)
      const endP = periodOf("month", `${hiYm}-01`)
      setPickingMonthFrom(null)
      setHoverMonth(null)
      onPick({ unit: "custom", from: startP.from, to: endP.to })
    },
    [pickingMonthFrom, onPick],
  )

  return (
    <div className="flex flex-col">
      <div className="flex flex-col sm:flex-row">
        {showRail && (
          <div
            data-slot="time-picker-rail"
            className={cn(
              "flex shrink-0 flex-col gap-2 border-b border-border/80 bg-muted/25 p-2.5 sm:border-r sm:border-b-0",
              periodsOnlyRail ? "sm:w-[124px]" : "sm:w-[164px]",
            )}
          >
            {railItems.length > 0 && (
              <div className="flex flex-col gap-0.5">
                {showUnitTabs && (
                  <div className="px-2 pb-1 text-[10px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                    {L.presets}
                  </div>
                )}
                <div className="flex flex-wrap gap-1 sm:flex-col sm:gap-0.5">
                  {railItems.map(item => {
                    const active = !activeExtra && sameValue(item.value, value)
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-slot="time-picker-shortcut"
                        onClick={() => onPick(item.value)}
                        className={cn(
                          "group flex h-8 items-center justify-between gap-2 rounded-[6px] px-2.5 text-left text-[13px] font-medium whitespace-nowrap transition-colors",
                          active
                            ? "bg-card text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.05)] ring-1 ring-border/80"
                            : "text-foreground/85 hover:bg-accent/70 hover:text-foreground",
                          FOCUS_RING,
                        )}
                      >
                        <span className="truncate">{item.label}</span>
                        {active && <Check className="size-3.5 shrink-0 text-foreground" />}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {showUnitTabs && (
              <div className={cn("flex flex-col gap-0.5", railItems.length > 0 && "border-t border-border/70 pt-2")}>
                {railItems.length > 0 && (
                  <div className="px-2 pb-1 text-[10px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                    By period
                  </div>
                )}
                <div className="flex flex-wrap gap-1 sm:flex-col sm:gap-0.5">
                  {periods!.map(u => (
                    <button
                      key={u}
                      type="button"
                      data-slot="time-picker-unit"
                      onClick={() => setPane(u)}
                      className={cn(
                        "flex items-center justify-between rounded-[6px] px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors",
                        pane === u
                          ? "bg-card text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.05)] ring-1 ring-border/80"
                          : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                        FOCUS_RING,
                      )}
                    >
                      {unitLabel(u)}
                    </button>
                  ))}
                  {customMode !== false && (
                    <button
                      type="button"
                      data-slot="time-picker-unit"
                      onClick={() => setPane("custom")}
                      className={cn(
                        "flex items-center justify-between rounded-[6px] px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors",
                        pane === "custom"
                          ? "bg-card text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.05)] ring-1 ring-border/80"
                          : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                        FOCUS_RING,
                      )}
                    >
                      {L.custom}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {pane === "custom" && customMode === "day" ? (
          <div className="p-2.5" onMouseLeave={() => setHoverDay(null)}>
            <Calendar
              mode="range"
              numberOfMonths={numMonths}
              weekStartsOn={1}
              showOutsideDays={false}
              selected={calendarSelected}
              onSelect={handleCalendarSelect}
              onDayMouseEnter={handleDayMouseEnter}
              defaultMonth={defaultMonth}
              startMonth={startMonth}
              endMonth={endMonth}
              disabled={disabledMatchers}
              className="p-1"
            />
          </div>
        ) : pane === "custom" && customMode === "month" ? (
          <div className="flex w-[292px] flex-col" onMouseLeave={() => setHoverMonth(null)}>
            <YearNavHeader
              heading={String(browseYear)}
              canPrev={browseYear > minYear}
              canNext={browseYear < maxYear}
              onPrev={() => setBrowseYear(y => Math.max(minYear, y - 1))}
              onNext={() => setBrowseYear(y => Math.min(maxYear, y + 1))}
            />
            <div className="grid grid-cols-3 gap-1.5 p-3">
              {yearMonths.map((p, idx) => {
                const ym = p.from.slice(0, 7)
                const live = isCurrent(p, today)
                const disabled = Boolean((min && p.to < min) || p.from > hi)
                const shortName = formatMonthShort(browseYear, idx, locale)
                const isStart = ym === previewMonthRange.from
                const isEnd = previewMonthRange.to != null && ym === previewMonthRange.to
                const isInRange =
                  previewMonthRange.to != null && ym > previewMonthRange.from && ym < previewMonthRange.to
                const isEdge = isStart || isEnd
                return (
                  <button
                    key={ym}
                    type="button"
                    data-slot="time-picker-month"
                    disabled={disabled}
                    onMouseEnter={() => {
                      if (pickingMonthFrom && !disabled) setHoverMonth(ym)
                    }}
                    onClick={() => handleMonthRangePick(ym)}
                    className={cn(
                      "relative flex h-10 items-center justify-center rounded-[7px] text-[13px] whitespace-nowrap tabular-nums transition-colors",
                      isEdge
                        ? "bg-primary font-semibold text-primary-foreground"
                        : isInRange
                          ? "bg-accent font-medium text-accent-foreground"
                          : "text-foreground/90 enabled:hover:bg-accent/70 enabled:hover:text-foreground disabled:opacity-30",
                      FOCUS_RING,
                    )}
                  >
                    <span>{shortName}</span>
                    {live && (
                      <span
                        aria-hidden
                        className={cn(
                          "absolute bottom-1.5 size-1 rounded-full",
                          isEdge ? "bg-primary-foreground" : "bg-brand",
                        )}
                      />
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        ) : pane === "day" ? (
          <div className="flex w-[292px] items-start justify-center p-2.5">
            <Calendar
              mode="single"
              numberOfMonths={1}
              weekStartsOn={1}
              showOutsideDays={false}
              selected={selectedSingleDay}
              onSelect={handleSingleDaySelect}
              defaultMonth={dayDefaultMonth}
              startMonth={startMonth}
              endMonth={endMonth}
              disabled={disabledMatchers}
              className="p-1 [--cell-size:2.2rem]"
            />
          </div>
        ) : (
          <div className="flex w-[292px] flex-col">
            {pane !== "year" && (
              <YearNavHeader
                heading={pane === "week" ? `Weeks · ${browseYear}` : String(browseYear)}
                canPrev={browseYear > minYear}
                canNext={browseYear < maxYear}
                onPrev={() => setBrowseYear(y => Math.max(minYear, y - 1))}
                onNext={() => setBrowseYear(y => Math.min(maxYear, y + 1))}
              />
            )}

            {pane === "week" && (
              <div className="relative min-h-[304px] flex-1">
                <div className="flex flex-col gap-0.5 overflow-y-auto p-2 max-sm:max-h-[308px] sm:absolute sm:inset-0">
                  {yearWeeks.map(p => {
                    const active = !activeExtra && !value.preset && value.unit === "week" && value.from === p.from
                    const live = isCurrent(p, today)
                    const wk = isoWeekNumber(p.from)
                    const rangeLabel = formatRange(p.from, p.to, locale, false)
                    return (
                      <button
                        key={p.from}
                        type="button"
                        data-slot="time-picker-week"
                        onClick={() => onPick(p)}
                        className={cn(
                          "flex h-9 shrink-0 items-center justify-between gap-2 rounded-[6px] px-2.5 text-left text-[13px] whitespace-nowrap tabular-nums transition-colors",
                          active
                            ? "bg-accent font-medium text-foreground ring-1 ring-border"
                            : "text-foreground/90 hover:bg-accent/60 hover:text-foreground",
                          FOCUS_RING,
                        )}
                      >
                        <span className="flex items-center gap-2.5">
                          <span className="inline-flex w-[34px] shrink-0 justify-center rounded bg-muted px-1 py-0.5 font-mono text-[11px] font-medium text-muted-foreground">
                            W{String(wk).padStart(2, "0")}
                          </span>
                          <span>{rangeLabel}</span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          {live && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              Current
                            </span>
                          )}
                          {active && <Check className="size-3.5 shrink-0 text-foreground" />}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {pane === "month" && (
              <div className="grid grid-cols-3 gap-1.5 p-3">
                {yearMonths.map((p, idx) => {
                  const active = !activeExtra && !value.preset && value.unit === "month" && value.from === p.from
                  const live = isCurrent(p, today)
                  const disabled = Boolean((min && p.to < min) || p.from > hi)
                  const shortName = formatMonthShort(browseYear, idx, locale)
                  return (
                    <button
                      key={p.from}
                      type="button"
                      data-slot="time-picker-month"
                      disabled={disabled}
                      onClick={() => onPick(p)}
                      className={cn(
                        "relative flex h-10 items-center justify-center rounded-[7px] text-[13px] whitespace-nowrap tabular-nums transition-colors",
                        active
                          ? "bg-accent font-semibold text-foreground ring-1 ring-foreground/25"
                          : "text-foreground/90 enabled:hover:bg-accent/70 enabled:hover:text-foreground disabled:opacity-30",
                        FOCUS_RING,
                      )}
                    >
                      <span>{shortName}</span>
                      {live && (
                        <span aria-hidden className="absolute bottom-1.5 size-1 rounded-full bg-brand" />
                      )}
                    </button>
                  )
                })}
              </div>
            )}

            {pane === "quarter" && (
              <div className="flex flex-col gap-1 p-2.5">
                {yearQuarters.map(p => {
                  const active = !activeExtra && !value.preset && value.unit === "quarter" && value.from === p.from
                  const live = isCurrent(p, today)
                  const disabled = Boolean((min && p.to < min) || p.from > hi)
                  const qNum = Math.floor((Number(p.from.slice(5, 7)) - 1) / 3) + 1
                  return (
                    <button
                      key={p.from}
                      type="button"
                      data-slot="time-picker-quarter"
                      disabled={disabled}
                      onClick={() => onPick(p)}
                      className={cn(
                        "flex h-10 items-center justify-between gap-2 rounded-[6px] px-3 text-left text-[13px] whitespace-nowrap tabular-nums transition-colors",
                        active
                          ? "bg-accent font-medium text-foreground ring-1 ring-border"
                          : "text-foreground/90 enabled:hover:bg-accent/60 enabled:hover:text-foreground disabled:opacity-30",
                        FOCUS_RING,
                      )}
                    >
                      <span className="flex items-center gap-3">
                        <span className="inline-flex w-8 shrink-0 justify-center rounded bg-muted px-1 py-0.5 font-mono text-[11px] font-semibold text-muted-foreground">
                          Q{qNum}
                        </span>
                        <span>{quarterMonthSpan(browseYear, qNum, locale)}</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        {live && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            Current
                          </span>
                        )}
                        {active && <Check className="size-3.5 shrink-0 text-foreground" />}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}

            {pane === "year" && (
              <div className="flex flex-col gap-1 p-2.5">
                <div className="px-2.5 pb-1 text-[10px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                  Years
                </div>
                {allYears.map(p => {
                  const active = !activeExtra && !value.preset && value.unit === "year" && value.from === p.from
                  const live = isCurrent(p, today)
                  const y = Number(p.from.slice(0, 4))
                  const spanEnd =
                    p.to > hi
                      ? formatMonthShort(y, Number(hi.slice(5, 7)) - 1, locale)
                      : formatMonthShort(y, 11, locale)
                  const spanText = `${formatMonthShort(y, 0, locale)} – ${spanEnd}`
                  return (
                    <button
                      key={p.from}
                      type="button"
                      data-slot="time-picker-year"
                      onClick={() => onPick(p)}
                      className={cn(
                        "flex h-10 items-center justify-between gap-2 rounded-[6px] px-3 text-left text-[13px] whitespace-nowrap tabular-nums transition-colors",
                        active
                          ? "bg-accent font-medium text-foreground ring-1 ring-border"
                          : "text-foreground/90 hover:bg-accent/60 hover:text-foreground",
                        FOCUS_RING,
                      )}
                    >
                      <span className="flex items-center gap-3">
                        <span className="font-semibold text-foreground">{y}</span>
                        <span className="text-[12px] text-muted-foreground">{spanText}</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        {live && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            Current
                          </span>
                        )}
                        {active && <Check className="size-3.5 shrink-0 text-foreground" />}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {extraOptions && extraOptions.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t border-border/80 bg-muted/20 p-2">
          {extraOptions.map(opt => {
            const active = activeExtra === opt.id
            return (
              <button
                key={opt.id}
                type="button"
                data-slot="time-picker-extra"
                onClick={() => onPickExtra(opt.id)}
                className={cn(
                  "flex h-8 items-center justify-between gap-2 rounded-[6px] px-2.5 text-left text-[13px] font-medium transition-colors",
                  active
                    ? "bg-accent text-foreground ring-1 ring-border"
                    : "text-foreground/85 hover:bg-accent/70 hover:text-foreground",
                  FOCUS_RING,
                )}
              >
                <span className="truncate">{opt.label}</span>
                <span className="flex items-center gap-1.5">
                  {opt.badge != null && (
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground tabular-nums">
                      {opt.badge}
                    </span>
                  )}
                  {active && <Check className="size-3.5 shrink-0 text-foreground" />}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {pane === "custom" && customMode === "day" && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/80 bg-muted/20 px-3.5 py-2 text-[12px]">
          {includeTime ? (
            <>
              <div className="flex flex-wrap items-center gap-2.5 text-foreground tabular-nums">
                <label className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <span>Start</span>
                  <input
                    type="time"
                    step={60}
                    disabled={timeLockedByRetention}
                    value={timeLockedByRetention ? "00:00" : startTime}
                    onChange={e => setStartTime(e.target.value || "00:00")}
                    className="h-7 rounded-[6px] border border-border bg-background px-2 text-[12px] text-foreground tabular-nums disabled:opacity-45"
                  />
                </label>
                <label className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <span>End</span>
                  <input
                    type="time"
                    step={60}
                    disabled={timeLockedByRetention}
                    value={timeLockedByRetention ? "23:59" : endTime}
                    onChange={e => setEndTime(e.target.value || "23:59")}
                    className="h-7 rounded-[6px] border border-border bg-background px-2 text-[12px] text-foreground tabular-nums disabled:opacity-45"
                  />
                </label>
                {timeLockedByRetention && timeRetentionMin ? (
                  <span className="text-[11px] text-muted-foreground">
                    Daily only before {formatDate(timeRetentionMin, { locale, year: false })}
                  </span>
                ) : tzLabel ? (
                  <span className="text-[11px] text-muted-foreground">{tzLabel}</span>
                ) : null}
              </div>

              <div className="flex items-center gap-1.5">
                {(pickingFrom !== null || draftRange !== null) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-7 px-2 text-[12px] text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setPickingFrom(null)
                      setHoverDay(null)
                      setDraftRange(null)
                    }}
                  >
                    Reset
                  </Button>
                )}
                <Button type="button" size="xs" className="h-7 px-3 text-[12px]" onClick={applyTimedRange}>
                  {L.apply}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5 text-foreground tabular-nums">
                {pickingFrom !== null && previewRange.to === null ? (
                  <>
                    <span className="font-medium">{formatDate(pickingFrom, { locale, year: true })}</span>
                    <span className="text-muted-foreground">→ pick end date</span>
                  </>
                ) : (
                  <>
                    <span className="font-medium">
                      {formatRange(previewRange.from, previewRange.to ?? previewRange.from, locale, true)}
                    </span>
                    <span className="text-muted-foreground">
                      · {formatDayCount(daySpan(previewRange.from, previewRange.to ?? previewRange.from))}
                    </span>
                  </>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                {pickingFrom !== null ? (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="h-6 px-2 text-[12px] text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        const day = pickingFrom
                        setPickingFrom(null)
                        setHoverDay(null)
                        onPick({ unit: "custom", from: day, to: day })
                      }}
                    >
                      Single day
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="h-6 px-2 text-[12px] text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        setPickingFrom(null)
                        setHoverDay(null)
                      }}
                    >
                      Clear
                    </Button>
                  </>
                ) : min ? (
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    Data since {formatDate(min, { locale, year: true })}
                  </span>
                ) : null}
              </div>
            </>
          )}
        </div>
      )}

      {pane === "custom" && customMode === "month" && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/80 bg-muted/20 px-3.5 py-2 text-[12px]">
          <div className="flex items-center gap-1.5 text-foreground tabular-nums">
            {pickingMonthFrom !== null && previewMonthRange.to === null ? (
              <>
                <span className="font-medium">{formatYm(pickingMonthFrom, locale, true)}</span>
                <span className="text-muted-foreground">→ pick end month</span>
              </>
            ) : (
              <>
                <span className="font-medium">
                  {formatMonthRange(previewMonthRange.from, previewMonthRange.to ?? previewMonthRange.from, locale)}
                </span>
                <span className="text-muted-foreground">
                  · {monthSpanCount(previewMonthRange.from, previewMonthRange.to ?? previewMonthRange.from)}{" "}
                  {monthSpanCount(previewMonthRange.from, previewMonthRange.to ?? previewMonthRange.from) === 1
                    ? "month"
                    : "months"}
                </span>
              </>
            )}
          </div>
          {pickingMonthFrom !== null && (
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="h-6 px-2 text-[12px] text-muted-foreground hover:text-foreground"
                onClick={() => {
                  const p = periodOf("month", `${pickingMonthFrom}-01`)
                  setPickingMonthFrom(null)
                  setHoverMonth(null)
                  onPick(p)
                }}
              >
                Single month
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="h-6 px-2 text-[12px] text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setPickingMonthFrom(null)
                  setHoverMonth(null)
                }}
              >
                Clear
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function YearNavHeader({
  heading,
  canPrev,
  canNext,
  onPrev,
  onNext,
}: {
  heading: string
  canPrev: boolean
  canNext: boolean
  onPrev: () => void
  onNext: () => void
}) {
  return (
    <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
      <button
        type="button"
        aria-label="Previous year"
        disabled={!canPrev}
        onClick={onPrev}
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-[6px] text-muted-foreground transition-colors",
          "enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-30",
          FOCUS_RING,
        )}
      >
        <ChevronLeft className="size-4" />
      </button>
      <span className="text-[13px] font-semibold text-foreground tabular-nums">{heading}</span>
      <button
        type="button"
        aria-label="Next year"
        disabled={!canNext}
        onClick={onNext}
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-[6px] text-muted-foreground transition-colors",
          "enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-30",
          FOCUS_RING,
        )}
      >
        <ChevronRight className="size-4" />
      </button>
    </div>
  )
}
