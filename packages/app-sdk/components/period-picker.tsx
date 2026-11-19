"use client"

// PeriodPicker (2.27): the house date filter, ‹ Nov 2026 ›. The arrows step
// one period, the middle opens a picker (recent weeks / months / quarters /
// years, or a custom range), and the period in progress is tinted. Ported
// 1:1 from the workspace's apps/attrition-por-cohorte/src/ui/PeriodPicker.tsx
// and its `.pp` styles. The app's hand-rolled popover became the stock
// shadcn Popover (./popover): it portals the menu, moves focus into it on
// open and back to the trigger on close.
//
// 2.29: `locale` translates every fixed text (from the SDK's strings table,
// ../locale.js) and the month names (Intl); `labels` overrides single
// strings; `presets` adds a tab of rolling windows. Without them the output
// is byte-identical to 2.28.
import * as React from "react"
import { closePopovers } from "../ui.js"
import { localeStrings, type PeriodPickerLabels } from "../locale.js"
import { cn } from "../menu/utils"
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "./popover"
import { addDays, isCurrent, periodLabel, periodOf, presetPeriod, shift, todayIso, type Period, type PeriodPreset, type Unit } from "./period"

const RECENT: Record<Unit, number> = { week: 12, month: 12, quarter: 8, year: 4 }

export interface PeriodPickerProps {
  value: Period
  onChange: (p: Period) => void
  /** The units offered in the picker. Default month, quarter, year. */
  units?: Unit[]
  /** Custom ranges: whole months ("month"), any days ("day"), or none (false). */
  custom?: "month" | "day" | false
  /** Earliest and latest day a period may reach. Default: no limit back, today forward. */
  min?: string
  max?: string
  /** The trigger's screen-reader name, read as "<label>: Nov 2026". Default "Time" (`labels.time`). */
  label?: string
  /** Mako thin prop (2.29): BCP 47 tag, e.g. "fr-CH". Translates every text and the month names. Default English. */
  locale?: string
  /** Mako thin prop (2.29): override single texts on top of the locale, e.g. `{ apply: "OK" }`. */
  labels?: Partial<PeriodPickerLabels>
  /**
   * Mako thin prop (2.29): rolling windows in their own tab, first: "7d", "28d", "90d" (the last N days),
   * "mtd", "qtd", "ytd" (month, quarter, year to date). A pick emits `presetPeriod(id)`: a custom range
   * ending today with `preset: id`. Default none.
   */
  presets?: readonly PeriodPreset[]
  /** Mako thin prop (2.27): classes on the stepper's frame, e.g. `w-full` in a phone sheet. */
  className?: string
}

/** The house date filter: ‹ Nov 2026 › with the period in progress tinted. */
export function PeriodPicker({ value, onChange, units = ["month", "quarter", "year"], custom = "month", min, max, label: labelProp, locale, labels, presets, className }: PeriodPickerProps) {
  const L = localeStrings("period", locale, labels)
  const label = labelProp ?? L.time
  const text = periodLabel(value, locale)
  const wide = !!(locale || presets?.length)
  const today = todayIso()
  const hi = max ?? today
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)
  const prev = shift(value, -1), next = shift(value, 1)
  const okPrev = !min || prev.to >= min
  const okNext = next.from <= hi
  const current = isCurrent(value, today)
  const step = "w-8 border-0 bg-transparent px-0 pt-0 pb-[2px] text-[18px] leading-none text-muted-foreground enabled:cursor-pointer enabled:hover:bg-accent enabled:hover:text-foreground disabled:cursor-default disabled:opacity-30"

  return (
    <Popover open={open} onOpenChange={o => { if (o) closePopovers(); setOpen(o) }}>
      <PopoverAnchor asChild>
        <div
          ref={ref}
          data-slot="period-picker"
          className={cn(
            "relative inline-flex h-[34px] items-stretch rounded-[8px] border border-border bg-card p-0 text-[14px] font-medium text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.05)] transition-[border-color,box-shadow] duration-150",
            // The ring stays while the picker is open, though focus has moved into the portalled menu.
            "focus-within:border-ring focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--ring)_35%,transparent)] focus-within:outline-none",
            "has-[[data-state=open]]:border-ring has-[[data-state=open]]:shadow-[0_0_0_3px_color-mix(in_srgb,var(--ring)_35%,transparent)]",
            className,
          )}
        >
          <button type="button" data-slot="period-picker-prev" className={cn(step, "rounded-l-[7px]")} aria-label={L.previous} disabled={!okPrev} onClick={() => onChange(prev)}>‹</button>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-slot="period-picker-trigger"
              data-current={current || undefined}
              className="inline-flex min-w-[156px] cursor-pointer items-center gap-2 border-x border-border bg-transparent py-0 pr-[10px] pl-3 font-medium text-inherit focus-visible:outline-none data-[current]:bg-[color-mix(in_srgb,var(--brand)_10%,transparent)] data-[current]:text-brand"
              aria-label={`${label}: ${text}`}
              title={current ? L.inProgressTitle : undefined}
            >
              {current && <span className="size-[7px] flex-none rounded-full bg-brand shadow-[0_0_0_3px_color-mix(in_srgb,var(--brand)_22%,transparent)]" aria-hidden />}
              <span className="flex-1 whitespace-nowrap text-left tabular-nums">{text}</span>
              <svg className={cn("flex-none text-muted-foreground transition-transform duration-150", open && "rotate-180")} width="12" height="12" viewBox="0 0 24 24" aria-hidden><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </PopoverTrigger>
          <button type="button" data-slot="period-picker-next" className={cn(step, "rounded-r-[7px]")} aria-label={L.next} disabled={!okNext} onClick={() => onChange(next)}>›</button>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        // The app's menu sat 6px under the frame's inner edge, flush with its inner left.
        sideOffset={5}
        alignOffset={1}
        aria-label={L.menu}
        className={cn(
          "z-[70] grid w-[320px] max-w-[calc(100vw-24px)] gap-[10px] rounded-[10px] p-[10px] shadow-[0_12px_28px_-8px_rgb(0_0_0/0.22)]",
          // Longer tab names ("Personnalisé") or a sixth tab: the menu grows to fit its tabs,
          // and on a phone too narrow for them the tab row scrolls.
          wide && "w-max min-w-[320px] grid-cols-[minmax(0,1fr)]",
        )}
        // The arrows sit outside the menu but inside the stepper: they step the period and leave it open.
        onInteractOutside={e => { if (ref.current?.contains(e.target as Node)) e.preventDefault() }}
      >
        <PickerMenu value={value} units={units} custom={custom} min={min} max={hi} today={today} L={L} locale={locale} presets={presets} wide={wide}
          onPick={p => { onChange(p); setOpen(false) }} />
      </PopoverContent>
    </Popover>
  )
}

function PickerMenu({ value, units, custom, min, max, today, L, locale, presets, wide, onPick }: {
  value: Period; units: Unit[]; custom: "month" | "day" | false; min?: string; max: string; today: string; onPick: (p: Period) => void
  L: PeriodPickerLabels; locale?: string; presets?: readonly PeriodPreset[]; wide: boolean
}) {
  const rolling = presets?.length ? presets : null
  const [tab, setTab] = React.useState<Unit | "custom" | "presets">(
    rolling && value.preset && rolling.includes(value.preset) ? "presets" : value.unit === "custom" && !custom ? units[0] : value.unit)
  const asMonth = custom === "month"
  const [from, setFrom] = React.useState(asMonth ? value.from.slice(0, 7) : value.from)
  const [to, setTo] = React.useState(asMonth ? value.to.slice(0, 7) : value.to)
  const list = tab === "custom" ? [] : tab === "presets" ? (rolling ?? []).flatMap(id => presetPeriod(id, today) ?? []) : (() => {
    const out: Period[] = []
    let p = periodOf(tab, max)
    for (let i = 0; i < RECENT[tab] && (!min || p.to >= min); i++, p = shift(p, -1)) out.push(p)
    return out
  })()
  const range = (): Period | null => {
    if (!from || !to) return null
    const f = asMonth ? `${from}-01` : from
    const t = asMonth ? addDays(periodOf("month", `${to}-01`).to, 0) : to
    return f <= t ? { unit: "custom", from: f, to: t } : null
  }
  const r = range()
  const tabClass = (on: boolean) => cn(
    "flex-1 cursor-pointer rounded-[6px] border border-transparent bg-transparent px-[6px] py-1 text-[13px] font-medium text-muted-foreground",
    on && "border-border bg-card text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.05)]",
  )
  const input = "h-8 rounded-[6px] border border-border bg-card px-2 text-[14px] text-foreground [font:inherit]"
  return (
    <>
      {units.length + (custom ? 1 : 0) + (rolling ? 1 : 0) > 1 && <div data-slot="period-picker-tabs" className={cn("flex gap-[2px] rounded-[8px] bg-muted p-[3px]", wide && "overflow-x-auto")} role="tablist">
        {rolling && <button type="button" role="tab" aria-selected={tab === "presets"} className={tabClass(tab === "presets")} onClick={() => setTab("presets")}>{L.presets}</button>}
        {units.map(u => <button key={u} type="button" role="tab" aria-selected={tab === u} className={tabClass(tab === u)} onClick={() => setTab(u)}>{L[u]}</button>)}
        {custom && <button type="button" role="tab" aria-selected={tab === "custom"} className={tabClass(tab === "custom")} onClick={() => setTab("custom")}>{L.custom}</button>}
      </div>}
      {tab !== "custom" ? (
        <div data-slot="period-picker-grid" className={cn("grid gap-1", tab === "month" ? "grid-cols-3" : "grid-cols-2")}>
          {list.map(p => {
            const on = p.preset ? value.preset === p.preset : value.unit === p.unit && value.from === p.from && !value.preset
            // Every preset runs to today: "in progress" under each would say nothing.
            const live = !p.preset && isCurrent(p, today)
            return (
              <button key={p.preset ?? p.from} type="button" data-current={live || undefined}
                className={cn(
                  "grid cursor-pointer justify-items-center rounded-[6px] border border-transparent bg-transparent px-[6px] py-[7px] text-[13px] text-inherit tabular-nums",
                  live && "text-brand",
                  on ? "border-brand bg-[color-mix(in_srgb,var(--brand)_8%,transparent)] font-semibold" : "hover:bg-accent",
                )}
                onClick={() => onPick(p)}>
                {periodLabel(p, locale)}{live && <small className="text-[10px] font-normal text-muted-foreground">{L.inProgress}</small>}
              </button>
            )
          })}
        </div>
      ) : (
        <form data-slot="period-picker-custom" className="grid grid-cols-2 gap-2" onSubmit={e => { e.preventDefault(); if (r) onPick(r) }}>
          <label className="grid gap-1 text-[12px] text-muted-foreground">{L.from}<input className={input} type={asMonth ? "month" : "date"} value={from} min={min ? (asMonth ? min.slice(0, 7) : min) : undefined} max={asMonth ? max.slice(0, 7) : max} onChange={e => setFrom(e.target.value)} /></label>
          <label className="grid gap-1 text-[12px] text-muted-foreground">{L.to}<input className={input} type={asMonth ? "month" : "date"} value={to} min={from || undefined} max={asMonth ? max.slice(0, 7) : max} onChange={e => setTo(e.target.value)} /></label>
          <button type="submit" className="col-span-full h-8 cursor-pointer rounded-[6px] border-0 bg-brand font-semibold text-white disabled:cursor-default disabled:opacity-45" disabled={!r}>{L.apply}</button>
        </form>
      )}
    </>
  )
}
