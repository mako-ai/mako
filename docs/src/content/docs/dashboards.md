---
title: Dashboards
description: Build interactive data dashboards from your saved queries — charts, KPI cards, tables, and cross-filtering powered by in-browser DuckDB.
---

Dashboards turn your saved queries into interactive visual boards. Instead of exporting data to a separate BI tool, you build dashboards directly in Mako — same workspace, same connections, same AI agent.

## How It Works

A dashboard is a collection of **widgets** (charts, KPI cards, data tables) powered by **data sources** (queries from your database connections). The data pipeline:

1. **Data sources** — Each data source is a query tied to a database connection. When materialized, Mako executes the query server-side and builds a Parquet file.
2. **Materialization** — The Parquet artifact is stored (filesystem, GCS, or S3 depending on deployment) and served to the browser.
3. **In-browser DuckDB** — The browser loads the Parquet file into a local [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) instance. All widget queries run locally — no round-trips to the server after initial load.
4. **Widgets** — Each widget has a `localSql` query that runs against the DuckDB instance. Charts use [Vega-Lite](https://vega.github.io/vega-lite/) specs; KPI cards and tables have their own renderers.
5. **Cross-filtering** — Powered by [Mosaic](https://uwdata.github.io/mosaic/). Clicking a bar or slice in one chart automatically filters all other widgets sharing the same data source.

```
Database (Postgres, BQ, etc.)
        │
        ▼  server-side query
   Parquet artifact (GCS/S3/filesystem)
        │
        ▼  HTTP fetch
   DuckDB-WASM (in browser, per-dashboard instance)
        │
        ▼  localSql per widget
   Vega-Lite charts / KPI cards / data tables
        │
        ▼  Mosaic cross-filtering
   Selection changes propagate across widgets
```

## Data Sources

A data source connects a dashboard to a database query. Each data source has:

- **`id`** — unique identifier within the dashboard
- **`name`** — human-readable label
- **`tableRef`** — the DuckDB table name used in widget `localSql` queries
- **`query`** — the SQL/JavaScript/MongoDB query to execute against a database connection
- **`origin`** — optional link to a saved console (so you can trace where the query came from)
- **`timeDimension`** — optional column name for time-based filtering
- **`rowLimit`** — optional cap on rows materialized
- **`computedColumns`** — optional derived columns (SQL expressions computed at materialization time)

Data sources support SQL, JavaScript, and MongoDB query languages.

### Materialization

When you create or refresh a dashboard, Mako:

1. Executes each data source query against its database connection
2. Streams results through server-side DuckDB (`@duckdb/node-api`) to build Parquet files
3. Stores the artifacts with version-based cache keys
4. Tracks build status per data source: `missing` → `queued` → `building` → `ready` (or `error`)

Materialization can be triggered manually or on a schedule (cron-based via Inngest). Each data source tracks its own status independently.

### Artifact Storage

Parquet artifacts are stored in one of three backends depending on deployment:

| Backend      | Use Case                  |
| ------------ | ------------------------- |
| `filesystem` | Local / self-hosted       |
| `gcs`        | Google Cloud deployments  |
| `s3`         | AWS deployments           |

The browser fetches artifacts via the API (`/api/workspaces/:wid/dashboards/:did/materialization/stream/:dsId`), which handles range requests for efficient loading.

## Widgets

Dashboards support three widget types:

### Charts (Vega-Lite)

Standard Vega-Lite specifications with a twist: the `data` block is omitted because data comes from the DuckDB instance. The widget's `localSql` query feeds the chart.

Supported mark types: `bar`, `line`, `area`, `point`, `arc` (pie/donut), `rect` (heatmap), and more — anything Vega-Lite supports.

### KPI Cards

Single-value displays with optional comparison (delta). Configuration:

- `valueField` — which column to display
- `format` — number formatting (currency, percentage, etc.)
- `comparisonField` — optional field for period-over-period comparison

### Data Tables

Tabular display of query results. Supports column sorting, formatting, and pagination.

### Responsive Layouts

Widgets use a grid layout system with responsive breakpoints (`lg`, `md`, `sm`, `xs`). Each widget has position (`x`, `y`) and size (`w`, `h`) per breakpoint, with automatic derivation from `lg` to smaller sizes.

## Cross-Filtering

Cross-filtering is powered by [Mosaic](https://uwdata.github.io/mosaic/) (`@uwdata/mosaic-core`). When a user clicks a bar, slice, or data point in one widget:

1. A Mosaic **selection** is created with the filter predicate
2. The Mosaic **coordinator** propagates the selection to all connected clients (widgets)
3. Each widget re-runs its `localSql` with the filter clause appended
4. Charts and tables update in real-time — all locally in DuckDB, no server calls

Cross-filtering can be disabled per widget via `crossFilter.enabled: false`.

## Global Filters

Dashboard-level filters that apply across all widgets:

- **Date range pickers** — filter by a time dimension column
- **Dropdowns** — filter by categorical values
- **Search fields** — text-based filtering

Global filters are defined at the dashboard level and injected into widget queries.

## Multi-Dashboard Support

Multiple dashboards can be open simultaneously, each with its own isolated DuckDB instance. The AI agent requires an explicit `dashboardId` on every tool call — there is no implicit "current dashboard."

## Edit Mode & Locking

Dashboards use an edit lock to prevent concurrent editing conflicts:

1. Call `enter_edit_mode` to acquire the lock
2. Make changes (add/remove widgets, modify data sources, etc.)
3. Changes are saved automatically
4. Lock releases when the user exits edit mode or navigates away

If another user holds the lock, a confirmation dialog offers to take over.

## Scheduled Refresh

Data sources can be refreshed on a schedule using cron expressions:

```json
{
  "enabled": true,
  "cron": "0 6 * * *",
  "timezone": "Europe/Zurich",
  "dataFreshnessTtlMs": 3600000
}
```

Scheduled refreshes run via Inngest, re-executing the source queries and rebuilding Parquet artifacts. The `dataFreshnessTtlMs` field controls how long cached data is considered fresh before triggering a new materialization.

## AI Agent Integration

The Dashboard Agent is a specialized agent that helps create and manage dashboards via natural language. It can:

- Create dashboards from scratch or from saved consoles
- Add, modify, and remove widgets
- Write `localSql` queries and Vega-Lite specs
- Configure cross-filtering, global filters, and layouts
- Manage data sources and materialization

The agent activates automatically when you're working on a dashboard tab. In the unified agent, modality triage routes dashboard-related requests to the dashboard toolset.
