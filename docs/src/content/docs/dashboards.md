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

Widgets use a grid layout system with responsive breakpoints. The `lg` breakpoint (12 columns) is the **authored source of truth** — the only one you (or the AI agent) need to set. The smaller breakpoints `md` (10 cols), `sm` (6 cols), and `xs` (4 cols) are **deterministically reflowed** from `lg`: rows of widgets wrap and tile cleanly so the board stays balanced on narrower screens.

Each widget carries position (`x`, `y`) and size (`w`, `h`) per breakpoint. To keep the reflow balanced, use grid-friendly widths that evenly tile a row (e.g. four KPIs at `w: 3`, three cards at `w: 4`, two charts at `w: 6`, or one full-width widget at `w: 12`).

Reflow is skipped per breakpoint when a user manually arranges that breakpoint: the affected widgets carry `layouts[bp].custom === true`, and Mako keeps the stored arrangement instead of recomputing it. Minimum widget sizes are enforced — widgets smaller than their type minimum are automatically enlarged.

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

## Version History

Every save of a dashboard creates an immutable version snapshot (widgets, data sources, layout). Authors, timestamps, and commit comments are preserved. Restoring a past version creates a new version record referencing the one it came from — the timeline is append-only. See [Version History](/version-history/) for the full API and agent tools.

### Commit Messages

When you save, the **Save version** dialog asks for a **Commit message** describing what changed — this labels the saved version in its history, not the dashboard itself.

Mako can suggest the commit message for you. On save, it diffs the pending dashboard definition against the latest saved snapshot (volatile cache state stripped) and folds in the chat prompts that drove the changes, then drafts a message with the cheap [utility model](/ai-agent/#utility--fast-model). This mirrors how console versions work.

```
POST /api/workspaces/:wid/dashboards/:did/version-comment
```

Returns `{ comment, diff }` — the suggested message for the changes about to be saved (plus the diff it was based on). You can accept it as-is or edit before confirming the save.

## Sharing & Collaborators

Dashboards, [consoles](/console/), and apps use a single **Google Workspace-style** sharing model, managed from each resource's **Share** dialog. Three layers stack on top of each other:

1. **Owner** — the creator (`owner_id`, falling back to `createdBy`) always has full access and can manage sharing.
2. **Per-user collaborators** (`sharedWith`) — specific users granted a `viewer` (read-only) or `editor` (read + write) role, independent of the resource's general access scope.
3. **General access** (`access`) — `private` (only the owner + collaborators) or `workspace` (every workspace member). When `workspace`, the `workspaceRole` field sets the role members get: `viewer` (default) or `editor`. Workspace admins/owners always resolve to `editor`; the `viewer` member role caps them at read-only.

Access resolution is first-match-wins in that order (see `api/src/utils/resource-acl.ts`). Admins do **not** gain access to private resources they neither own nor are shared on — this preserves the privacy guarantee. Only the **owner**, or a workspace **owner/admin** for non-private resources, can change sharing settings or manage collaborators.

Collaborators are stored on the resource's `sharedWith` array (`{ userId, role, addedAt, addedBy }`), indexed for fast "shared with me" lookups.

### Public links (dashboards & apps)

Dashboards and apps can be published as read-only **public links** at `/share/:token`, served without authentication:

- Public links serve **materialized snapshots only** (the last-materialized Parquet artifacts), never live database connections.
- An optional **password** protects the link. It is stored as a bcrypt hash, plus an AES-encrypted copy so the owner/admin can reveal it later in the UI.
- Links get a readable workspace/title **slug** (with conflict suffixes), support inline rename, **token rotation**, and a throttled anonymous **refresh** endpoint.
- Consoles do **not** support public links — they share via collaborators and workspace access only.

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
