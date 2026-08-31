---
title: Apps
description: Build live React apps inside your workspace — git-backed Vite projects with a real sandbox, secure data bindings to your database connections, and fast client-side analytics via DuckDB.
---

Apps are real Vite + React + TypeScript projects that live in your workspace's git repository and run in a per-user sandbox. You (or the AI agent) build them the way a developer does: edit files, run shell commands, commit, and merge — with first-class, credential-free access to your workspace's database connections.

## How It Works

An app is a folder (`apps/<slug>/`) in the workspace monorepo:

- **A real git repository** — Mako hosts the bare repo and serves it over git's own HTTP protocol; every commit is also mirror-pushed to a private GitHub repo (Mako-hosted, or your own connected repo).
- **A real working copy** — each editor gets a sandbox (an isolated microVM) that is an ordinary git clone with a real filesystem, a real shell, and a real remote. Committed-and-pushed work survives the sandbox dying; uncommitted work lives only in the sandbox, exactly as on a laptop.
- **Data bindings as files** — `bindings/<name>.sql` files that map a name to a query against one of your workspace connections.

You work on your own branch (`user/<id>`) — the same one the agent and the built-in terminal use — and merge to `main` from the branch menu. `main` is what publishes.

## Building Apps with the AI Agent

Ask the agent to build an app and it scaffolds a Vite + React starter, opens it live in a tab (vite dev server + hot reload), and iterates: editing files, running shell commands, materializing bindings, and reading the dev log and a real headless browser's view of the running app until it renders clean. Your accumulated changes are committed and pushed automatically at the end of every agent turn.

You can edit everything yourself too — files open in the editor, the Apps explorer shows the file tree, the terminal drops you into the app's folder in the sandbox, and Source Control shows branches, diffs, and history.

## Data Bindings

Bindings are how apps reach workspace data. A binding is one file — `bindings/<name>.sql` — whose front matter is a leading block of `-- key: value` SQL comments:

```sql
-- connection: <workspace connection id>
-- materialization: parquet
-- schedule: 0 6 * * *
SELECT category, amount, created_at FROM orders
```

Queries execute server-side through Mako's scoped execute API — **the app code never sees credentials or connection strings**. The query is materialized into a Parquet artifact (same pipeline as dashboards); at runtime the preview serves each artifact at the app-relative URL `__data/<name>.parquet`, ready for hyparquet or DuckDB-WASM. In app code, read bindings through `@mako/app-sdk` — a real package committed into the workspace repo:

```tsx
import { useQuery, useDuckDB } from "@makoai/app-sdk"; // apps created before 2026-09: "@mako/app-sdk" (older alias, same package)

const { data, loading, error } = useQuery("recent_orders");

const { data: totals } = useDuckDB(
  'SELECT category, SUM(amount) AS total FROM "orders" GROUP BY 1'
);
```

A binding can pin a workspace [dbt project](/transforms/) via `-- dbt_project: <id>` front matter for environment-aware schemas.

## URL State & Routing

Apps can keep view state — the active tab, applied filters, a selected record, a sub-page — in the URL, so a reload restores it and the link is shareable. Reach for the `@mako/app-sdk` hooks rather than `window.history` directly, and they work both embedded in Mako (`/a/:app`) and in the public share view (`/share/:token`):

```tsx
import { useLocation, useSearchParams, navigate } from "@makoai/app-sdk";

const loc = useLocation();
const [params, setParams] = useSearchParams();
navigate("/customers/42");
```

Use distinct **paths** for separate views and **query params** for filters and sort within a view.

## Publishing & Sharing

- The **dev preview** is your branch's working copy, live (vite + HMR) — visible to you while you build.
- **Publishing** builds a commit on `main` into an immutable deployment; public and shared links serve the **published** build, never a draft, so viewers never see a half-finished edit.
- **Rollback** repoints the published deployment at an earlier build.
- History is git history: every commit, by person or agent, is browsable in Source Control.

## Access Control

Apps follow the same model as dashboards (see [Sharing & Collaborators](/dashboards/#sharing--collaborators)):

- **`private`** (default): owner-only. Workspace admins and API keys cannot read or modify another member's private app.
- **`workspace`**: visible and editable by any workspace member.

Public links (optionally password-protected) render the published deployment for anonymous viewers.

## Security Model

- Binding queries are validated against the workspace's connections and run server-side with read-only enforcement on materialization SQL.
- The sandbox is an isolated microVM per workspace; app code and shell commands never run in Mako's API process.
- The preview iframe is sandboxed; app code receives query *results* only — never credentials.

## API Surface

Apps are managed under `/api/workspaces/:wid/apps` (list/create/delete, files, exec, branches, commit/merge, bindings and materialization, publish/rollback, public share, sandbox lifecycle). The workspace repo itself is served over git HTTP at `/api/apps-git/:workspaceId.git`, authorized by a scoped workspace git token. See the OpenAPI spec for full schemas, and [MCP Server](/mcp-server/) for driving all of this headlessly with the `app_*` tools.
