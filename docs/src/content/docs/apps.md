---
title: Apps
description: Build live React apps inside your workspace — AI-authored, with secure data bindings to your database connections and fast client-side analytics via DuckDB.
---

Apps are React projects that run live inside a Mako tab. You (or the AI agent) build them by editing files — think Lovable or v0, but with first-class, credential-free access to your workspace's database connections.

## How It Works

An app is three things:

- **A virtual filesystem** — TypeScript/React source files. The entrypoint is `src/App.tsx` (its default export is rendered).
- **An npm dependency manifest** — libraries like `d3`, `recharts`, or `framer-motion`, resolved as ES modules at preview time.
- **Data bindings** — named queries against your workspace connections that the app reads at runtime.

The default runtime is `cdn`: React plus ESM dependencies run directly in a sandboxed preview iframe with no build step. Plain CSS and CSS-in-JS work well; full Tailwind/shadcn builds require the `webcontainer` runtime, which is not yet enabled.

## Building Apps with the AI Agent

Ask the agent to build an app and it scaffolds a React + TypeScript starter, opens it in a tab, and iterates: writing files, adding dependencies, creating data bindings, and reading build/runtime errors from the live preview until it renders clean. The agent can also screenshot the running preview to visually inspect what it built. This is the agent's [React App mode](/ai-agent/#expertise-modes).

You can edit everything yourself too — files open in the editor, and the Apps explorer shows the file tree, dependencies, and data sources.

## Data Bindings

Bindings are how apps reach workspace data. Each binding maps a name to a query (SQL, MongoDB, or JavaScript) against one of your connections. Queries execute server-side through Mako's scoped execute API — **the app code never sees credentials or connection strings**.

Two delivery modes:

| Mode | Behavior | Best for |
| --- | --- | --- |
| `live` | Query runs server-side on every read | Small, always-fresh lookups |
| `parquet` | Query is materialized into a Parquet artifact (same pipeline as dashboards) and loaded into DuckDB-WASM in the browser | Dashboards and aggregations over larger result sets |

Materialized bindings record a run history (row count, size, duration, errors) and can be rebuilt on demand. In the app code, read bindings through the injected `@mako/app-sdk`:

```tsx
import { useQuery, useDuckDB } from "@mako/app-sdk";

// Live binding: fetches through the execute API
const { data, loading, error } = useQuery("recent_orders");

// Parquet binding: analytical SQL against DuckDB-WASM, table name = binding name
const { data: totals } = useDuckDB(
  'SELECT category, SUM(amount) AS total FROM "orders" GROUP BY 1'
);
```

Data sources are visible under **Data sources** in the app's explorer tree, with a Live/Materialized mode control and materialization run history.

## URL State & Routing

Apps can keep view state — the active tab, applied filters, a selected record, a sub-page — in the URL, so a reload restores it and the link is shareable. This works both when the app is embedded in Mako (`/a/:appId`) and in the public share view (`/share/:token`).

Because the app runs in a sandboxed `about:srcdoc` iframe, it can't write the real address bar directly. Reach for the injected `@mako/app-sdk` hooks instead of `window.history`, `window.location`, the URL hash, or a `react-router` `BrowserRouter` — those won't survive a reload or share:

```tsx
import { useLocation, useSearchParams, navigate } from "@mako/app-sdk";

// Read the current location (re-renders on change, including Back/Forward).
const loc = useLocation(); // { pathname, search, hash, href, searchParams }

// React-Router-style query params for tabs / filters.
const [params, setParams] = useSearchParams();
const tab = params.get("tab") ?? "overview";
// Pass { replace: true } for high-frequency updates (typing, sliders) so
// Back/Forward isn't flooded; the default pushes a new history entry.
setParams(new URLSearchParams({ tab: "customers", c: "ES,FR" }), { replace: true });

// Path-style routing for distinct views / detail pages.
navigate("/customers/42");        // push (Back returns to the list)
navigate("/", { replace: true }); // replace the current entry
```

Use distinct **paths** for separate views (`/`, `/customers/42`) and **query params** for filters and sort within a view. The app's pathname rides on the host URL in a reserved `_path` param; query params stay readable on the address bar. Hashes (`#…`) are not carried across the bridge — keep state in the path or query.

## Versioning & Publishing

Apps autosave every edit, so what you (or the AI agent) work on is a **draft**. Every app starts with a v1 `App created` checkpoint (also its first published version), so version history is never empty. To create a further immutable checkpoint, **save a version** — this snapshots the current draft into version history *and* **publishes** it.

- Public and shared links render the **published** version, never the live draft, so viewers never see a half-finished edit.
- **Restoring** a past version reverts the draft (snapshotting the current draft first, so it's never lossy) but does **not** auto-publish — save a version afterward to push the restored state live.
- Materialized binding caches are preserved across restore.

See [Version History](/version-history/) for the REST endpoints, response shapes, and the agent tools (`browse_version_history`, `get_version_snapshot`).

## Access Control

Apps follow the same model as dashboards:

- **`private`** (default): owner-only. Workspace admins and API keys cannot read or modify another member's private app.
- **`workspace`**: visible and editable by any workspace member.

## Security Model

- Binding queries are validated against the workspace's connections and run server-side with read-only enforcement on materialization SQL.
- The preview runs in a sandboxed iframe; in-sandbox DuckDB SQL is gated to read-only `SELECT` / `WITH` and rows posted to the preview are capped.
- App code receives query *results* only — never credentials.
