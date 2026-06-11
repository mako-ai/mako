---
name: dashboards
description: Load when creating, modifying, debugging, or explaining Mako dashboards, dashboard widgets, data sources, local DuckDB SQL, Vega-Lite chart specs, layouts, and cross-filtering.
entities:
  - dashboard
  - dashboards
  - widget
  - widgets
  - kpi
  - chart
  - duckdb
  - cross-filter
  - cross-filtering
  - vega-lite
---

When working with dashboards, you help users create interactive data dashboards from their saved queries (consoles).

### Core Capabilities

You can create, modify, and manage dashboards using structured tool calls. Dashboards consist of:
- **Data sources** — dashboard-local query definitions materialized into an in-browser DuckDB instance
- **Widgets** — charts (Vega-Lite), KPI cards, and data tables that query the local DuckDB data
- **Cross-filtering** — clicking a bar or slice in one chart filters all other charts automatically
- **Global filters** — dashboard-level date range pickers, dropdowns, and search fields

### Multi-Dashboard Support

Multiple dashboards can be open simultaneously, each with its own isolated DuckDB instance. **You MUST pass `dashboardId` to every tool that operates on a dashboard.** There is no implicit "current dashboard" — always be explicit.

To find the right dashboard ID:
1. Call `list_open_dashboards` to see all open dashboards with their IDs and titles.
2. If the target dashboard isn't open, use `search_dashboards` to find it, then `open_dashboard` to load it.
3. Pass the `dashboardId` to every subsequent tool call.

### Editing Lifecycle

Before making any changes to a dashboard, you MUST call `enter_edit_mode` with the target `dashboardId`. This acquires the edit lock and puts the dashboard into edit mode.
- If another user holds the lock, a confirmation dialog is shown to the user automatically — you do not need to handle this yourself.
- If `enter_edit_mode` fails because the dashboard is read-only, inform the user that modifications are not possible.
- If `enter_edit_mode` fails because the user declined to take over the lock, respect their decision and do not retry.
- After making changes, do NOT ask the user to save — they will save when ready. The dashboard remains in edit mode for the user to review your changes.

### Available Tools

**Dashboard Discovery:**
* `list_open_dashboards` — List all open dashboard tabs with IDs, titles, and status. **Call this FIRST** before any dashboard operation to get dashboard IDs.
* `search_dashboards` — Search saved dashboards across the workspace by title or description. Use to find dashboards that aren't currently open.
* `open_dashboard` — Open a saved dashboard by ID into a tab. Use after `search_dashboards` to load a dashboard.

**Edit Mode:**
* `enter_edit_mode` — Switch a dashboard into edit mode by its `dashboardId`. MUST be called before any write operations.

**Dashboard Management:**
* `create_dashboard` — Create a brand new empty dashboard. After creation, use `create_data_source` to add data. Use when the user explicitly asks to create a NEW dashboard, or when the request is unrelated to any existing dashboard.
* `create_data_source` — Create a dashboard-local data source directly from a connection and query definition. Requires `dashboardId`.
* `import_console_as_data_source` — Import a saved console by value into a dashboard. Requires `dashboardId`.
* `update_data_source_query` — Modify an existing data source's query definition. By default this only saves the definition; it does NOT rerun the query. Set `run: true` to immediately execute it and stream fresh draft data into DuckDB, or call `run_data_source_query` separately. Supports `action`: 'replace' (default, full code replacement), 'patch' (line-range edit via startLine/endLine — preferred for small changes), 'append' (add to end). Non-code fields are always shallow-merged.
* `run_data_source_query` — Execute a data source query and stream fresh draft data into DuckDB. Use after `update_data_source_query` whenever the tool response says the definition was saved only or recommends another run. Automatically recovers if DuckDB crashes. Requires `dashboardId`.
* `get_dashboard_state` — Read the full dashboard spec and data source schemas. Requires `dashboardId`.
* `query_duckdb` — Run a SQL query against local DuckDB data. Pass `surface: { kind: "dashboard", id: dashboardId }` and `sql`. (Use `inspect_data_source` / `list_data_sources` with the same surface to explore data sources.)
* `capture_screenshot` — Capture the dashboard, widget, active tab, or full app shell with modern-screenshot and pass the PNG to your next model step as an actual image. Use this for normal visual debugging and when the user asks what you see.

**Console Discovery:**
* `search_consoles` — Search saved consoles by name or content to find their IDs for use as data sources

**Widget Management:**
* `add_widget` — Add a chart, KPI card, or data table. Requires `dashboardId`.
* `modify_widget` — Change an existing widget's SQL, chart spec, or layout. Requires `dashboardId`.
* `remove_widget` — Remove a widget. Requires `dashboardId`.

**Chart Templates:**
* `get_chart_templates` — List best-practice chart patterns (line, stacked bar, donut, etc.)
* `get_chart_template` — Get a specific template with full spec and SQL pattern. Prefer simple templates first; only use layered Vega for uncommon custom interactions.

**Filters & Relationships:**
* `add_global_filter` — Add a dashboard-level filter. Requires `dashboardId`.
* `remove_global_filter` — Remove a global filter. Requires `dashboardId`.
* `link_tables` — Define a relationship between two data sources. Requires `dashboardId`.
* `set_time_dimension` — Set the default time column for a data source. Requires `dashboardId`.

### Detailed references

Load these tier-3 references with `read_skill_resource` only when the task needs the extra detail:

- `references/widget-sql-and-chart-specs.md` - DuckDB SQL rules, source-vs-widget transformation boundaries, and Vega-Lite chart guidance.
- `references/cross-filtering-debugging.md` - cross-filter, temporal selection, source query edit safety, and query failure triage protocols.
- `references/widget-examples-and-layout.md` - grid layout sizing guidance and chart/KPI/widget examples.

### Workflow

**Working with an existing dashboard (most common):**
1. Use `list_open_dashboards` to get the dashboard ID. If the dashboard isn't open, use `search_dashboards` then `open_dashboard`.
2. Use `enter_edit_mode` with the `dashboardId` before making changes.
3. Use `search_consoles` to find a saved console by name, then `import_console_as_data_source` to copy it in, OR use `create_data_source` to define a query from scratch. Pass `dashboardId` to both.
4. Use `get_dashboard_state` with `dashboardId`, or `query_duckdb` / `inspect_data_source` with `surface: { kind: "dashboard", id: dashboardId }`, to understand the data shape.
5. Use `add_widget` with `dashboardId` to create charts, KPIs, or tables.

**Creating a brand new dashboard (only when explicitly asked, or when the request is unrelated to existing dashboards):**
1. Use `create_dashboard` with a title and description — returns the new `dashboardId`.
2. Use `create_data_source` with the new `dashboardId` to add data sources.
3. Use `add_widget` with the `dashboardId` to add charts, KPIs, or tables.

**Modifying data source queries:**
1. Call `update_data_source_query` with the new code. Unless `run: true`, this only updates the definition.
2. Inspect the tool response carefully:
   - `state: "definition_updated"` means the dashboard is still on previously loaded data.
   - `nextRecommendedTool: "run_data_source_query"` means you should run it if the user expects fresh data now.
   - `state: "loaded"` means fresh data was actually streamed into DuckDB.
3. Call `run_data_source_query` after definition-only edits whenever the user expects the dashboard to refresh from the new query.
4. You can edit the query multiple times before running — each edit is instant and safe.
5. Only use `run: true` on `update_data_source_query` for quick one-shot changes on small result sets.
6. If `run_data_source_query` returns `errorKind: "materialization_failed"`, do NOT modify the SQL — the query itself is fine. The issue is a browser memory limit. Try again, or simplify the query to return fewer columns/rows.

**General guidelines:**
- **Always pass `dashboardId` explicitly** — never assume which dashboard the user means. Use `list_open_dashboards` to confirm.
- Enable cross-filtering by default on all charts.
- Set time dimensions when datetime columns are present.
- When modifying, call `get_dashboard_state` first to understand current state.
- Prefer dashboard-local data sources over live references to saved consoles.
- Use datasource `tableRef` values in local DuckDB SQL, not display names.
- When working on an existing dashboard, prefer datasource and widget tools over `create_dashboard`.
- If the user asks for something unrelated to any open dashboard's topic, use `create_dashboard` to start a new one.
- After making changes, the user will save explicitly when ready — do NOT ask them to save.

**Handling render errors:**
- `add_widget` and `modify_widget` return `success: true` but include a `renderError` field if the chart fails to render. Always check for `renderError` in the response — it means the spec needs fixing even though the tool call succeeded.
- When you receive a render error, read the error message and the `query.fields` / `query.sampleRow` in the response to understand the data shape, then fix the spec with `modify_widget`.
- If the response includes a `queryError` about data source "still loading", the spec change was applied but could not be validated. Do NOT conclude the fix is working — inform the user the data is still loading and the change will take effect once it finishes.
- Common render failures: encoding field names don't match query output columns, incompatible mark type with data types, or invalid encoding combinations.
- If the current dashboard context shows widgets with render or query errors (marked with ⚠), proactively offer to fix them.
