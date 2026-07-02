---
name: apps
description: Load when building, editing, or debugging Mako React apps — app files, npm dependencies, data bindings, the @mako/app-sdk hooks (useQuery / useDuckDB / useLocation / useSearchParams / navigate), URL state and shareable deep links, materialized Parquet/DuckDB bindings, and the live preview runtime.
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
  - uselocation
  - usesearchparams
  - navigate
  - url state
  - query params
  - routing
  - tabs
  - deep link
  - share link
  - parquet
  - preview
  - theme
  - dark mode
---

Apps are React projects rendered live in a tab. You build them by editing files.

All app tools run server-side except the live preview: `list_open_apps`,
`create_app`, `get_app_state`, `app_read_file`, the file/dependency/binding
edits, `materialize_binding`, and versioning all operate on the server document,
so you can build and operate an app with no browser attached. The only
browser-only tool is `run_app` (rebuild the preview and read render/build
errors); `open_app` just focuses a UI tab.

### Workflow

1. Call `list_open_apps` to find the target app and its `appId`. If none exists,
   use `create_app` (it scaffolds a React + TypeScript starter; in an attached
   browser, call `open_app` afterward to focus its tab).
2. Use `get_app_state` to see the file list, dependencies, data bindings,
   entrypoint, and version before editing. (Live preview build/runtime errors are
   only available in an attached browser via `run_app`.)
3. Modify existing files with `app_edit_file` — an anchored replacement: pass the
   exact current text as `oldString` (must match exactly once — include a few
   surrounding lines to disambiguate; re-read the file with `app_read_file` if the
   match fails) and the replacement as `newString` (`""` deletes it; set
   `replaceAll: true` for renames). Use `app_write_file` (COMPLETE contents) only to
   create new files or fully rewrite one. The entrypoint defaults to `src/App.tsx`
   (default export is rendered).
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

   **Reusing a saved console:** pass `consoleId` (from `search_consoles`) to
   `app_create_data_binding` and the console's query code, connection, language, and
   database resolve server-side — do not re-type the SQL. Explicit fields override
   the console's values; `name` defaults to a sanitized version of the console name.

   **Updating bindings IN PLACE — never recreate under a new name:** to change an
   existing binding's query (or connection/language/database), call
   `app_update_data_binding` with its `name`. For small query changes pass an
   anchored `oldString`/`newString` edit; pass `code` only for a full replacement.
   The binding keeps its id, materialization, schedule, and artifact history, and
   app code keeps reading the same table name. For a `parquet` binding the rebuild
   is queued automatically, but the app keeps serving the PREVIOUS data until it
   completes — call `materialize_binding` to wait for it before validating results
   with `query_duckdb`. Do NOT delete/recreate a binding or mint a versioned name
   (`my_data_v2`) to change a query — that orphans the artifact, drops the
   schedule, and forces app-code edits.

   **Deleting bindings:** to remove an orphaned or superseded binding, call
   `app_delete_data_binding` with its `name`. It removes the binding from the app
   definition and persists the change; the returned `remaining` list (and a fresh
   `list_data_sources`) confirms it is actually gone. Do NOT use `app_delete_file`
   for bindings — bindings are not files, and that call will no-op and falsely
   report success.

   **Materialized bindings (DuckDB):** set `materialization: "parquet"` to materialize
   the query into a Parquet artifact (same pipeline as dashboards) that is loaded into
   DuckDB-WASM in the browser. Works for **SQL and MongoDB** bindings — a MongoDB
   binding's `code` is a JS shell query (e.g. `db.newUsers.aggregate([...])`) and it
   materializes through the same pipeline. After creating/editing a parquet binding, call
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

   **Toggle materialization IN PLACE — never delete/recreate:** to switch an
   existing binding between `live` and `parquet`, call
   `app_set_binding_materialization` with the binding `name` and the target
   `materialization`. It flips the setting on the existing binding (preserving its
   id, code, and connection); after switching to `parquet`, call
   `materialize_binding` to build the artifact. Do NOT delete and recreate a binding
   just to change materialization — that mints a new id, drops the cache, and breaks
   anything referencing it.

   **Scheduled refresh:** a parquet binding can auto-refresh on a cron — set
   `materializationSchedule` when creating it, or call `app_set_binding_schedule`
   (e.g. `{ enabled: true, cron: "0 * * * *" }` for hourly, `"0 0 * * *"` for
   daily) on an existing one. This mirrors dashboard data-source schedules. Only
   parquet bindings can be scheduled (live bindings always run fresh). Scheduled
   refresh runs in production; in local dev trigger a build with
   `materialize_binding`. An explicit `materialize_binding` always rebuilds from
   current upstream data (it force-refreshes past the query-definition cache).

   **dbt-linked bindings (environment-agnostic SQL):** when a binding reads
   tables built by a Mako dbt project, pass `dbtProjectId` (from
   `read_dbt_project_tree`) to `app_create_data_binding` /
   `app_update_data_binding` and reference the schema via the
   `{{ dbt_schema }}` token instead of hardcoding it:

   ```sql
   SELECT * FROM {{ dbt_schema }}.fct_revenue
   ```

   The token resolves to the dbt project's PROD-like environment schema for
   published apps, parquet materialization, and public shares. In the DRAFT
   preview it can be switched per user with `app_set_preview_environment`
   (e.g. to a personal `dbt_<user>` schema) to verify an app against
   freshly-built dev models WITHOUT affecting other editors or viewers —
   pass `environment: null` to reset to prod. While an override is active,
   dbt-linked parquet bindings run live (row-capped) in the preview so the
   prod artifact is never rebuilt from dev data. See the `dbt` skill for the
   full model-iteration → preview → promote loop.

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
6. After a batch of edits, in an attached browser call `run_app` to rebuild the
   preview and read build/runtime errors, then fix them. Iterate until the preview
   is error-free. (Headless, with no browser, you cannot render — rely on
   `get_app_state` and careful editing.)
7. Understand and validate data before coding against it using the shared data-source
   primitives (they work for apps and dashboards — pass `surface: { kind: "app", id: appId }`):
   `list_data_sources` shows every data source (connection, query, materialization, status);
   `inspect_data_source` returns its columns + sample rows; `query_duckdb` runs analytical
   SQL against the materialized tables so you can validate aggregations before writing
   `useDuckDB` calls. Data sources are also visible to the user under "Data sources" in the
   app's explorer tree.

### Version history, drafts & publishing

Apps use a **draft → published** split:

- The files/dependencies/bindings you edit are the working **draft**, autosaved
  on every edit. Editors (and you) always see the draft in the preview.
- **Publishing** snapshots the draft into immutable version history AND sets it
  as the **published** definition — the one public/shared links and viewers
  render. So a half-finished or in-progress draft is never shown to viewers
  until you publish.

Tools:

- `app_save_version` — snapshot the current draft into history **and publish it**
  (it becomes the viewer-facing version). Use at meaningful milestones (after
  finishing a feature, before a risky refactor) and whenever the user asks to
  "save"/"publish"/"snapshot" the app. Give a short `comment`.
- `browse_version_history` with `entityType: "app"` and the `appId` — list past
  versions (who, when, comment, `restoredFrom`). Use `get_version_snapshot` to
  inspect a version's files before restoring.
- `app_restore_version` — revert the **draft** to a past version by number. The
  current draft is snapshotted first, so restoring is never lossy; it does NOT
  auto-publish (publish afterward to push the restored state live). Open tabs
  reload automatically. Binding materialization artifacts are kept (snapshots
  store query definitions, not parquet caches).

Good habit: publish a version with a descriptive comment right before sweeping
edits the user might want to undo, so there is always a clean live point to roll
back to.

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

**`*-foreground` tokens are ONLY for text drawn on top of the matching solid
color.** `--destructive-foreground` is near-white (for text on a solid
`--destructive` red button), so using it as the text color of an error message on
a light `--card`/`--background` surface renders **white-on-white and unreadable** —
a common failure. For an inline error/empty state on a normal surface, use
`--destructive` (the red) as the text and/or border color, not
`--destructive-foreground`:

```tsx
// ✅ readable error box on a card
<div style={{
  border: "1px solid var(--destructive)",
  color: "var(--destructive)",
  background: "var(--card)",
  padding: 12, borderRadius: "var(--radius)",
}}>
  {error}
</div>

// ❌ white-on-white — never use *-foreground as text on a light surface
<div style={{ color: "var(--destructive-foreground)", background: "var(--card)" }}>{error}</div>
```

Always render `useQuery`/`useDuckDB` `error` and empty states with readable
contrast, and verify with `run_app`.

When code needs the literal mode or a computed color (e.g. a canvas-based chart
library's theme option), use the SDK hook:

```tsx
import { useTheme } from "@mako/app-sdk";
const { theme } = useTheme(); // "light" | "dark", updates live on toggle
```

Brand colors are fine for accents — just keep backgrounds, text, and borders on the
tokens so both modes stay readable.

### URL state & routing (shareable, reload-safe views)

Persist view state — the open tab, active filters, a selected record, a sub-page —
in the URL so a reload restores it and the link is shareable. The runtime projects
the app's location onto the host's real URL in **both** contexts: embedded in Mako
(`/a/:appId`) and the public share view (`/share/:token`). App query params stay
readable on the address bar; the app's pathname rides in a reserved `_path` param.

Use the injected hooks — do **not** reach for `window.history`, `window.location`,
the URL hash, or a `react-router` `BrowserRouter`. The app runs in a sandboxed
`about:srcdoc` iframe, so those can't write the real address bar and won't survive a
reload or share; only these hooks bridge to the host:

```tsx
import { useLocation, useSearchParams, navigate } from "@mako/app-sdk";

// Read the current location (re-renders on every change, incl. back/forward).
const loc = useLocation(); // { pathname, search, hash, href, searchParams }

// React-Router-style query params for tabs / filters.
const [params, setParams] = useSearchParams();
const tab = params.get("tab") ?? "overview";
// Pass { replace: true } for high-frequency updates (typing in a filter, sliders)
// so back/forward isn't flooded; the default pushes a new history entry.
setParams(new URLSearchParams({ tab: "customers", c: "ES,FR" }), { replace: true });

// Path-style routing for distinct views / detail pages.
navigate("/customers/42");          // push a new entry (Back returns to the list)
navigate("/", { replace: true });   // replace the current entry
```

Guidance: reach for this whenever the app has tabs, filters, or master→detail
navigation a user would expect to bookmark or share. Use distinct **paths** for
separate views (`/`, `/customers/42`) and **query params** for filters/sort within a
view. Hashes (`#…`) are not carried across the bridge — keep state in the path/query.

### Constraints

- The default `cdn` runtime runs React + ESM dependencies without a build step. Plain
  CSS and runtime libraries (d3, recharts, etc.) work well. A full Tailwind/shadcn build
  requires the `webcontainer` runtime (not yet enabled) — prefer plain CSS or CSS-in-JS
  for styling in the cdn runtime.
- Use the injected theme tokens (`var(--background)`, `var(--card)`, `var(--border)`,
  `var(--chart-1)`, …) instead of hardcoded colors so apps follow light/dark mode; see
  "Theming & dark mode".
- Keep components in their own files and import them; write idiomatic, modern React.
