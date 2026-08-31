# UI toolkit: Tailwind v4 + shadcn/ui in a Mako app

Apps are ordinary Vite projects, so the standard modern React toolkit works —
no CDN tricks. This is the proven setup (first shipped in
`event-reconciliation-explorer`, 2026-08).

## Install

```bash
npm i -D tailwindcss @tailwindcss/vite
npm i clsx tailwind-merge class-variance-authority lucide-react
```

`vite.config.ts` — add the plugin and the `@/` alias (keep `makoData()`):

```ts
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
// plugins: [react(), tailwindcss(), makoData()],
// resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
```

`tsconfig.json` compilerOptions: `"baseUrl": ".", "paths": { "@/*": ["./src/*"] }`.

## Theme: map Tailwind onto the SDK's tokens

The SDK injects `--background`, `--card`, `--muted-foreground`, `--chart-1…5`,
`--radius`, … as complete color values in light AND dark. Never redefine them —
map them, and the app follows the host theme for free. `src/index.css`:

```css
@import "tailwindcss";

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}

@layer base {
  * { @apply border-border outline-ring/50; }
  body { @apply bg-background text-foreground antialiased; }
  /* Tailwind preflight leaves buttons on cursor: default — every enabled
   * click target must read as clickable. */
  a[href], button:not(:disabled), select:not(:disabled), summary, label[for],
  [role="button"]:not([aria-disabled="true"]),
  [role="tab"]:not([aria-disabled="true"]),
  [role="menuitem"], [role="menuitemcheckbox"], [role="option"],
  [role="checkbox"]:not([aria-disabled="true"]) {
    cursor: pointer;
  }
}
```

Import it once from `main.tsx` (`import "./index.css"`).

## shadcn/ui

Current shadcn components pass refs as props — they need **React 19**
(`npm i react@^19 react-dom@^19 && npm i -D @types/react@^19 @types/react-dom@^19`;
the SDK's peer range allows it). Under React 18 a `PopoverTrigger asChild`
cannot anchor and fails silently.

Write `components.json` at the app root, then add components with the CLI:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york", "rsc": false, "tsx": true,
  "tailwind": { "config": "", "css": "src/index.css", "baseColor": "neutral", "cssVariables": true, "prefix": "" },
  "aliases": { "components": "@/components", "utils": "@/lib/utils", "ui": "@/components/ui", "lib": "@/lib", "hooks": "@/hooks" },
  "iconLibrary": "lucide"
}
```

```bash
npx shadcn@latest add button card popover tabs dropdown-menu checkbox calendar
```

The CLI writes `src/components/ui/*` and installs what it needs (`radix-ui`,
`react-day-picker@10` for calendar). `src/lib/utils.ts` is the usual
`cn = twMerge(clsx(...))`.

Because the theme block above maps shadcn's expected token names onto the
SDK's, generated components are correctly themed with zero edits.

## Filter controls: the dropdown pattern

Multi-select filters (countries, teams, …) are a `DropdownMenu`, not a chip
row: trigger shows the selection summary (`All countries` / `FR, CH`), the
menu has an **All** row, then one row per value — `Checkbox` on the left,
label, and an **only** button on the right (visible on row hover) that solos
the value. Keep the menu open across toggles with
`onSelect={(e) => e.preventDefault()}`; the only-button stops propagation:

```tsx
<DropdownMenuItem className="group/row gap-2 text-xs"
    onSelect={(e) => { e.preventDefault(); toggle(value); }}>
  <Checkbox checked={selected.includes(value)} className="pointer-events-none size-3.5" />
  <span className="flex-1">{label}</span>
  <button type="button"
      className="invisible rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-background hover:text-foreground group-hover/row:visible"
      onClick={(e) => { e.stopPropagation(); solo(value); }}>
    only
  </button>
</DropdownMenuItem>
```

Semantics that make it feel right: unchecking the last value re-selects all
(an empty filter means "everything", never "nothing"), and "only" on the sole
selected value restores all. Persist selections in URL params so views are
shareable.

## Migrating a v1 (CDN-runtime) app

Delete the runtime-injected CSS string and any `<link>`/`<script>` to
unpkg/CDN, move styles to Tailwind utilities, and replace hand-rolled
popovers/segmented controls with shadcn `Popover` / `Tabs`. Keep custom SVG
charts if they are good — restyle their HTML tooltips with utilities. Then
`npx tsc -b && npm run build` must both pass.
