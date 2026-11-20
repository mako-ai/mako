"use client"

// Deferred and Staged mounting (2.31): panels below the first screen stop sharing the
// load task with the panels above them. House components, not shadcn ones.
// Each placeholder keeps the final height, so nothing jumps when the content lands.
//   Deferred          mounts on first approach to the viewport (or one task later).
//   Staged            mounts one panel per painted frame, in mount order, app-wide.
//   useStagedMount    the same frame pacing for panels you gate yourself.
import * as React from "react"
import { Skeleton } from "./skeleton"

const px = (v: number | string) => (typeof v === "number" ? `${v}px` : v)

function Placeholder({ minHeight, placeholder, innerRef, slot }: {
  minHeight: number | string
  placeholder: React.ReactNode | false | undefined
  innerRef?: React.Ref<HTMLDivElement>
  slot: string
}) {
  return (
    <div data-slot={slot} ref={innerRef} style={{ minHeight: px(minHeight), display: "flex", flexDirection: "column" }}>
      {placeholder === false ? null : (placeholder ?? <Skeleton aria-busy="true" className="flex-1" />)}
    </div>
  )
}

/**
 * Mounts `children` the first time its placeholder comes within `rootMargin` of the viewport, then keeps
 * them. Without IntersectionObserver, or with mode="task", it mounts one task after the first commit.
 * The placeholder is a Skeleton (aria-busy) of `minHeight`; `placeholder={false}` leaves a blank spacer,
 * a node replaces the Skeleton.
 */
function Deferred({ minHeight, rootMargin = "800px 0px", mode = "visible", placeholder, children }: {
  /** The loaded panel's height, held while it waits. */
  minHeight: number | string
  /** IntersectionObserver rootMargin. Default "800px 0px": 800 px above and below the viewport. */
  rootMargin?: string
  /** "visible" (default): mount near the viewport. "task": mount one task after the first commit. */
  mode?: "visible" | "task"
  /** Replaces the Skeleton; `false` renders a blank spacer. */
  placeholder?: React.ReactNode | false
  children: React.ReactNode
}) {
  const [shown, setShown] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const el = ref.current
    if (shown || !el) return
    if (mode === "task" || typeof IntersectionObserver === "undefined") {
      const id = window.setTimeout(() => setShown(true), 0)
      return () => window.clearTimeout(id)
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShown(true)
      },
      { rootMargin },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [shown, mode, rootMargin])
  return shown ? <>{children}</> : <Placeholder slot="deferred" innerRef={ref} minHeight={minHeight} placeholder={placeholder} />
}

// Panels whose data lands in the same tick would mount in one React commit. Each Staged panel waits for its
// turn in this one queue: one panel per painted frame, in mount order.
let turn: Promise<void> = Promise.resolve()

// Runs `run` once: after the next painted frame and one task in a visible tab, or after a 100 ms timer in a
// hidden one (a hidden tab never fires requestAnimationFrame). The timer runs only while the tab is hidden, so
// frames slower than 100 ms never let it fire between paints. A visibilitychange swaps the waiting path.
const FRAME_FALLBACK_MS = 100
function afterFrame(run: () => void): () => void {
  let frame = 0
  let task = 0
  let fallback = 0
  const cb = () => {
    stop()
    run()
  }
  const stop = () => {
    cancelAnimationFrame(frame)
    window.clearTimeout(task)
    window.clearTimeout(fallback)
    document.removeEventListener("visibilitychange", arm)
  }
  function arm() {
    cancelAnimationFrame(frame)
    window.clearTimeout(fallback)
    if (document.visibilityState === "hidden") {
      fallback = window.setTimeout(cb, FRAME_FALLBACK_MS)
      return
    }
    frame = requestAnimationFrame(() => {
      document.removeEventListener("visibilitychange", arm)
      task = window.setTimeout(cb, 0)
    })
  }
  document.addEventListener("visibilitychange", arm)
  arm()
  return stop
}
const nextFrame = () => new Promise<void>((done) => afterFrame(done))

/** Shows a Skeleton of `minHeight`, then mounts `children` on its own frame, one panel at a time. */
function Staged({ minHeight, placeholder, children }: {
  /** The loaded panel's height, held while it waits. */
  minHeight: number | string
  /** Replaces the Skeleton; `false` renders a blank spacer. */
  placeholder?: React.ReactNode | false
  children: React.ReactNode
}) {
  const [ready, setReady] = React.useState(false)
  React.useEffect(() => {
    let live = true
    // A panel unmounted before its turn spends no frame.
    turn = turn.then(() => (live ? nextFrame().then(() => { if (live) setReady(true) }) : undefined))
    return () => {
      live = false
    }
  }, [])
  return ready ? <>{children}</> : <Placeholder slot="staged" minHeight={minHeight} placeholder={placeholder} />
}

/**
 * Counts up from 0 to `count`, one step per painted frame. Gate panel n with `step >= n`:
 * `const step = useStagedMount(3)` mounts 3 groups, one per frame, after the first paint.
 */
function useStagedMount(count: number): number {
  const [step, setStep] = React.useState(0)
  React.useEffect(() => {
    if (step >= count) return
    return afterFrame(() => setStep((s) => s + 1))
  }, [step, count])
  return step
}

export { Deferred, Staged, useStagedMount }
