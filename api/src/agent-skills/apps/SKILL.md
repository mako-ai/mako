---
name: apps
description: Load when building, editing, or debugging Mako React apps — app files, npm dependencies, data bindings, the @mako/app-sdk hooks (useQuery / useDuckDB), materialized Parquet/DuckDB bindings, and the live preview runtime.
entities:
  - app
  - apps
  - react
  - react app
  - data binding
  - data bindings
  - app-sdk
  - usequery
  - useduckdb
  - parquet
  - preview
  - theme
  - dark mode
---

Apps are React projects rendered live in a tab. You build them by editing files.

### Workflow

1. Call `list_open_apps` to find the active app and its `appId`. If none is open,
   use `create_app` (it scaffolds a React + TypeScript starter and opens a tab).
2. Use `get_app_state` to see the file list, dependencies, data bindings, and any
   current build/runtime errors before editing.
3. Edit with `app_write_file` — always write the COMPLETE file contents, not a diff.
   The entrypoint defaults to `src/App.tsx` (default export is rendered).
4. Add libraries with `app_add_dependency` (e.g. d3, recharts, framer-motion) before
   importing them. They resolve as ES modules at preview time.
5. To use workspace data, create a binding with `app_create_data_binding` (validate the
   query first using the SQL/Mongo inspection tools), then read it in code:

   ```tsx
   import { useQuery } from "@mako/app-sdk";
   const { data, loading, error } = useQuery("binding_name");
   ```

   Bindings run server-side and are workspace-scoped — never put credentials or raw
   connection strings in app code.

   **Deleting bindings:** to remove an orphaned or superseded binding, call
   `app_delete_data_binding` with its `name`. It removes the binding from the app
   definition and persists the change; the returned `remaining` list (and a fresh
   `list_data_sources`) confirms it is actually gone. Do NOT use `app_delete_file`
   for bindings — bindings are not files, and that call will no-op and falsely
   report success.

   **Materialized bindings (DuckDB):** set `materialization: "parquet"` to materialize
   the query into a Parquet artifact (same pipeline as dashboards) that is loaded into
   DuckDB-WASM in the browser. After creating/editing a parquet binding, call
   `materialize_binding`. The build runs server-side in the background; the tool waits
   up to `waitSeconds` (default 120) and may return status `building` — that is not an
   error. The app loads the data automatically when ready. To block until the build
   finishes, call `materialize_binding` again — it resumes waiting on the in-flight
   build (poll-with-timeout). Use `waitSeconds: 0` for an instant status check. Then
   the app can run fast analytical SQL client-side:

   ```tsx
   import { useDuckDB } from "@mako/app-sdk";
   // table names are the binding names
   const { data } = useDuckDB('SELECT category, SUM(amount) AS total FROM "orders" GROUP BY 1');
   ```

   Prefer parquet + useDuckDB for dashboards/aggregations over larger result sets; prefer
   live useQuery for small, always-fresh lookups.

   **Result row cap:** rows delivered to the app are capped per query/binding read
   (default 500,000 — the bridge into the sandboxed iframe). Both hooks return
   `truncated: true` when rows beyond the cap were dropped, and `useDuckDB` also
   returns `rowCount` (the full result size before the cap); the SDK logs a console
   warning too. NEVER ignore `truncated` — aggregates computed in JS over a truncated
   result are silently wrong (classic symptom: an unfiltered view showing smaller
   totals than filtered views). Prefer aggregating in SQL so results stay small. If
   you genuinely need more rows, pass `useDuckDB(sql, { rowLimit: 2_000_000 })` or
   `{ rowLimit: null }` to disable the cap (costs memory + serialization time), and
   surface `truncated` in the UI whenever you render row-level data.
6. After a batch of edits, if something looks wrong, call `get_app_state` (or `run_app`)
   to read build/runtime errors and fix them. Iterate until the preview is error-free.
7. Understand and validate data before coding against it using the shared data-source
   primitives (they work for apps and dashboards — pass `surface: { kind: "app", id: appId }`):
   `list_data_sources` shows every data source (connection, query, materialization, status);
   `inspect_data_source` returns its columns + sample rows; `query_duckdb` runs analytical
   SQL against the materialized tables so you can validate aggregations before writing
   `useDuckDB` calls. Data sources are also visible to the user under "Data sources" in the
   app's explorer tree.

### Theming & dark mode

Apps are themed by the runtime — do not build a theme system. The preview injects
shadcn-named CSS variables that switch between light and dark automatically (the Mako
theme when the app runs inside the workspace, the OS preference when opened standalone
from a share link). The page background and text color are pre-wired; a new app is
dark-mode-correct with zero theme code.

The one rule: **never hardcode surface/text/border colors — use the tokens.**

- Surfaces & text: `var(--background)` / `var(--foreground)`, `var(--card)` /
  `var(--card-foreground)`, `var(--popover)` / `var(--popover-foreground)`,
  `var(--muted)` / `var(--muted-foreground)`, `var(--secondary)`, `var(--accent)`
- Lines & controls: `var(--border)`, `var(--input)`, `var(--ring)`, `var(--radius)`
- Emphasis: `var(--primary)` / `var(--primary-foreground)`, `var(--destructive)` /
  `var(--destructive-foreground)`
- Charts: `var(--chart-1)` … `var(--chart-5)` — tokens are resolved colors, so they
  work directly in inline styles, CSS-in-JS, and SVG `fill`/`stroke` (recharts, d3).

When code needs the literal mode or a computed color (e.g. a canvas-based chart
library's theme option), use the SDK hook:

```tsx
import { useTheme } from "@mako/app-sdk";
const { theme } = useTheme(); // "light" | "dark", updates live on toggle
```

Brand colors are fine for accents — just keep backgrounds, text, and borders on the
tokens so both modes stay readable.

### Constraints

- The default `cdn` runtime runs React + ESM dependencies without a build step. Plain
  CSS and runtime libraries (d3, recharts, etc.) work well. A full Tailwind/shadcn build
  requires the `webcontainer` runtime (not yet enabled) — prefer plain CSS or CSS-in-JS
  for styling in the cdn runtime.
- Use the injected theme tokens (`var(--background)`, `var(--card)`, `var(--border)`,
  `var(--chart-1)`, …) instead of hardcoded colors so apps follow light/dark mode; see
  "Theming & dark mode".
- Keep components in their own files and import them; write idiomatic, modern React.
