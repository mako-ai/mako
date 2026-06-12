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

### Constraints

- The default `cdn` runtime runs React + ESM dependencies without a build step. Plain
  CSS and runtime libraries (d3, recharts, etc.) work well. A full Tailwind/shadcn build
  requires the `webcontainer` runtime (not yet enabled) — prefer plain CSS or CSS-in-JS
  for styling in the cdn runtime.
- Keep components in their own files and import them; write idiomatic, modern React.
