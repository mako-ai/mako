---
name: react-render-profiling
description: Investigate React render performance in the Mako app using React Scan, render-debug logs, and existing memoization contracts. Use when profiling render churn, slow chat streaming, Monaco console responsiveness, explorer/result table lag, or when the user mentions React Scan.
---

# React Render Profiling

## Quick Start

Use this workflow for frontend render-performance investigations in `app/`:

1. Start the frontend profiler:

   ```bash
   pnpm run app:dev:scan
   ```

2. Open `http://localhost:5173` and reproduce the interaction.
3. Watch React Scan overlays for re-render hotspots.
4. Check browser console logs prefixed with `[render-debug]` for why instrumented components changed.
5. Patch the smallest unstable boundary, then verify with focused tests plus app lint/typecheck.

## Instrumentation

- `VITE_REACT_SCAN=true` enables the React Scan Vite plugin.
- `VITE_RENDER_DEBUG=true` enables Mako's `renderDebug` helpers.
- Normal `pnpm run app:dev` keeps both off. Do not make profiling instrumentation active by default.

## Mako Hot Paths

Prioritize these areas when render churn appears:

- `app/src/components/Chat.tsx`: streaming messages, tool cards, input area.
- `app/src/components/StreamingToolCard.tsx`: terminal tool-card memo comparator and expandable previews.
- `app/src/components/ResourceTree.tsx`: stable callbacks from explorers and tree props.
- `app/src/components/Editor.tsx` and `Console.tsx`: Monaco tab/panel re-renders.
- `app/src/components/ResultsTable.tsx`: stable grid props and result view resets.
- `app/src/store/consoleStore.ts`: avoid no-op Zustand writes that still notify subscribers.

## Rules

- Keep `useChat({ experimental_throttle: 50 })` in `Chat.tsx`.
- Avoid selectors that return fresh objects/arrays in hot components unless wrapped with `useShallow`.
- For callback-only dynamic values, prefer refs or `useConsoleStore.getState()` at invocation time over object dependencies.
- Do not replace `use-stick-to-bottom` with a `useEffect([messages])` scroll implementation.
- Keep debug hooks and React Scan gated by env flags.

## Verification

For chat/render-boundary changes, run:

```bash
pnpm --filter app exec vitest run src/components/__tests__/Chat.perf.test.ts
pnpm --filter app run typecheck
pnpm --filter app run lint
```

Add focused tests for any new comparator or truncation behavior that could silently regress.
