"use client"

// The page's filter bar (one row under the tabs): a small-caps label above each
// control, groups split by a hairline, Reset at the end. Each tab adds its own
// fields with <TabFilters>; they render into the bar, next to the global ones.
// Phones (768px and under): the fields fold behind one "Filters" chip that
// opens a bottom sheet with Done.
//
// A house component, not a shadcn one (2.27): ported 1:1 from the workspace's
// apps/attrition-por-cohorte/src/ui/FilterBar.tsx and its .fb CSS, written as
// Tailwind classes on the house tokens. The bar and the sheet are one element
// (CSS restyles it), so the tab fields portalled into its slot stay mounted on
// every width. Two changes from the reference: the sheet sits at z-50 (scrim
// z-49), so the SDK's Radix popovers (z-50, portalled after it) open above it;
// and Escape leaves the sheet open when a popover inside it took the key.
import * as React from "react"
import { createPortal } from "react-dom"
import { cn } from "../menu/utils"

type Entry = { dirty: boolean; reset: () => void }
type Ctx = {
  slot: HTMLElement | null
  setSlot: (el: HTMLElement | null) => void
  entries: Record<string, Entry>
  register: (id: string, e: Entry | null) => void
}
const FilterCtx = React.createContext<Ctx>({ slot: null, setSlot: () => {}, entries: {}, register: () => {} })

/** Wraps the page: the bar and every tab that adds fields to it. */
function FilterProvider({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = React.useState<HTMLElement | null>(null)
  const [entries, setEntries] = React.useState<Record<string, Entry>>({})
  const register = React.useCallback((id: string, e: Entry | null) => {
    setEntries(prev => {
      if (e == null) {
        if (!(id in prev)) return prev
        const { [id]: _, ...rest } = prev
        return rest
      }
      if (prev[id]?.dirty === e.dirty && prev[id]?.reset === e.reset) return prev
      return { ...prev, [id]: e }
    })
  }, [])
  const ctx = React.useMemo(() => ({ slot, setSlot, entries, register }), [slot, entries, register])
  return <FilterCtx.Provider value={ctx}>{children}</FilterCtx.Provider>
}

/** The bar. `dirty`/`onReset` cover the page-wide fields; tabs register theirs with useResettable. */
function FilterBar({
  children,
  dirty,
  onReset,
  className,
}: {
  children: React.ReactNode
  dirty: boolean
  onReset: () => void
  className?: string
}) {
  const { setSlot, entries } = React.useContext(FilterCtx)
  const active = (dirty ? 1 : 0) + Object.values(entries).filter(e => e.dirty).length
  const [sheet, setSheet] = React.useState(false)
  React.useEffect(() => {
    if (!sheet) return
    // A Radix popover in the sheet marks the Escape it handled: only it closes.
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setSheet(false)
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [sheet])
  const reset = () => {
    onReset()
    Object.values(entries).forEach(e => e.reset())
  }

  return (
    <>
      <div data-slot="filter-chipbar" className="hidden max-[769px]:flex">
        <button
          type="button"
          data-slot="filter-chip"
          aria-expanded={sheet}
          onClick={() => setSheet(!sheet)}
          className="inline-flex h-[34px] items-center gap-2 rounded-[8px] border border-border bg-card px-3 text-sm font-medium shadow-[0_1px_2px_rgb(0_0_0/.05)]"
        >
          Filters{" "}
          {active > 0 && (
            <span
              data-slot="filter-count"
              className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand px-[5px] text-[11px] font-semibold text-white"
            >
              {active}
            </span>
          )}
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden>
            <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {sheet && (
        <div
          data-slot="filter-scrim"
          className="hidden max-[769px]:fixed max-[769px]:inset-0 max-[769px]:z-49 max-[769px]:block max-[769px]:bg-black/40"
          onClick={() => setSheet(false)}
        />
      )}
      <div
        data-slot="filter-bar"
        data-open={sheet || undefined}
        role="group"
        aria-label="Filters"
        className={cn(
          "group/fb flex flex-wrap items-end gap-x-3 gap-y-2.5",
          sheet
            ? "max-[769px]:fixed max-[769px]:inset-x-0 max-[769px]:bottom-0 max-[769px]:z-50 max-[769px]:max-h-[85dvh] max-[769px]:flex-col max-[769px]:items-stretch max-[769px]:gap-3.5 max-[769px]:overflow-auto max-[769px]:rounded-t-2xl max-[769px]:border-t max-[769px]:border-border max-[769px]:bg-background max-[769px]:px-4 max-[769px]:pt-1 max-[769px]:pb-[calc(16px+env(safe-area-inset-bottom,0px))] max-[769px]:shadow-[0_-12px_32px_rgb(0_0_0/.2)]"
            : "max-[769px]:hidden",
          className
        )}
      >
        <div
          data-slot="filter-sheet-head"
          className="hidden items-center justify-between border-b border-border pt-3 pb-2 font-semibold max-[769px]:group-data-[open]/fb:flex"
        >
          <span>Filters</span>
          <button
            type="button"
            data-slot="filter-done"
            onClick={() => setSheet(false)}
            className="h-8 rounded-[8px] border-0 bg-brand px-4 font-semibold text-white"
          >
            Done
          </button>
        </div>
        {children}
        <div ref={setSlot} data-slot="filter-slot" className="contents" />
        <button
          type="button"
          data-slot="filter-reset"
          disabled={active === 0}
          onClick={reset}
          title="Back to the default filters"
          className="inline-flex h-[34px] items-center gap-1.5 self-end rounded-[8px] border border-border bg-card px-3 text-sm font-medium text-foreground enabled:hover:bg-accent disabled:cursor-default disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-60 max-[769px]:self-start"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Reset
        </button>
      </div>
    </>
  )
}

/** A tab's own fields, rendered into the page's filter bar. */
function TabFilters({ children }: { children: React.ReactNode }) {
  const { slot } = React.useContext(FilterCtx)
  return slot ? createPortal(children, slot) : null
}

/** Lets Reset (and the Filters badge) know about a tab's filter. */
function useResettable(id: string, dirty: boolean, reset: () => void) {
  const { register } = React.useContext(FilterCtx)
  const keep = React.useRef(reset)
  keep.current = reset
  const stable = React.useCallback(() => keep.current(), [])
  React.useEffect(() => {
    register(id, { dirty, reset: stable })
  }, [id, dirty, stable, register])
  React.useEffect(() => () => register(id, null), [id, register])
}

/** A small-caps label over its control. `hint` shows as the label's title, with an ⓘ. */
function FilterField({
  label,
  hint,
  children,
  className,
}: {
  label: string
  hint?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-slot="filter-field"
      className={cn("flex min-w-0 flex-col gap-1.5 max-[769px]:group-data-[open]/fb:*:w-full!", className)}
    >
      <span
        data-slot="filter-label"
        title={hint}
        className="inline-flex items-center gap-1 text-[11px] font-semibold tracking-[.06em] whitespace-nowrap text-muted-foreground uppercase"
      >
        {label}
        {hint && (
          <span aria-hidden className="cursor-help text-xs tracking-normal">
            ⓘ
          </span>
        )}
      </span>
      {children}
    </div>
  )
}

/** The hairline between two groups of fields. */
function FilterSep() {
  return (
    <span
      data-slot="filter-sep"
      aria-hidden
      className="mx-1 h-[34px] w-px self-end bg-border max-[769px]:group-data-[open]/fb:hidden"
    />
  )
}

export { FilterBar, FilterField, FilterProvider, FilterSep, TabFilters, useResettable }
