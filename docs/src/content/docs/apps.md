---
title: Apps
description: Build live React apps inside your workspace — git-backed Vite projects with a real sandbox, secure data bindings to your database connections, and fast client-side analytics via DuckDB.
---

Apps are real Vite + React + TypeScript projects that live in your workspace's git repository and run in a per-user sandbox. You (or the AI agent) build them the way a developer does: edit files, run shell commands, commit, and merge — with first-class, credential-free access to your workspace's database connections.

## How It Works

An app is a folder in the workspace monorepo — `users/<handle>/apps/<slug>/` while it is personal, `apps/<slug>/` once you share it with the workspace (see [Personal and workspace apps](#personal-and-workspace-apps)):

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
-- row_limit: 3000000
SELECT category, amount, created_at FROM orders
```

`row_limit` is optional. A binding holds up to 2,000,000 rows by default and may declare up to 5,000,000 (`3000000`, `3_000_000` or `3M`). Operators set both numbers with `PARQUET_ROW_LIMIT` and `PARQUET_MAX_ROW_LIMIT`. Each binding downloads whole into the viewer's browser tab and sits in DuckDB-WASM memory. That costs about 950 bytes per row for a 43-column binding and about 180 bytes for a 14-column one. DuckDB-WASM stops at 3.1 GB per page, for all bindings together, so a 43-column binding runs out near 3.3M rows. Past a million rows, select fewer columns, pre-aggregate in SQL, or shard the binding by year or country. In the page, `useQuery(name)` turns at most 500,000 rows into JS objects and sets `truncated` past that (the `rowLimit` option). Aggregate bigger bindings in `useDuckDB` SQL or read them with `{ format: "arrow" }`.

Queries execute server-side through Mako's scoped execute API — **the app code never sees credentials or connection strings**. The query is materialized into a Parquet artifact; at runtime the preview serves each artifact at the app-relative URL `__data/<name>.parquet`, In app code, read bindings through `@makoai/app-sdk` — the published npm package (apps depend on it with a caret range; it is no longer vendored into the workspace repo):

```tsx
import { useQuery, useDuckDB } from "@makoai/app-sdk"; // apps created before 2026-09: "@mako/app-sdk" (older alias, same package)

const { data, loading, error } = useQuery("recent_orders");

const { data: totals } = useDuckDB(
  'SELECT category, SUM(amount) AS total FROM "orders" GROUP BY 1'
);

// Rematerialize on demand (SDK 2.3+): re-runs the binding's query and
// re-renders every hook reading it; the old rows stay while `refreshing`.
const { refresh, refreshing } = useQuery("recent_orders");
```

`useDuckDB` downloads only the bindings its SQL names (SDK 2.8+). Before 2.8 it fetched every binding in `__data/index.json` before running any query. Joins across bindings still work by name, and a binding the name scan misses loads when DuckDB reports its table missing. Each binding is decoded once into an in-memory DuckDB table, so repeated queries skip the parquet decode. `SHOW TABLES` and `information_schema` queries still load every binding.

For anything the hooks do not cover, use the SDK's escape hatches (2.8+) on the same engine. Never import `@duckdb/duckdb-wasm`, `hyparquet` or `apache-arrow` parquet readers yourself. A second engine means a second ~1 s boot and a second copy of the data.

| Need | Use |
|---|---|
| Arrow Table instead of rows | `useDuckDB(sql, { format: "arrow" })` |
| Your own SQL session | `getDuckDB()` returns the shared engine (never close or terminate it). `withConnection(conn => conn.query(sql))` |
| A binding as a table | `await ensureBinding("orders")` returns `"orders"`. `unloadBinding(name)` frees it |
| Raw parquet bytes | `fetchBindingBytes(name, { onProgress, fresh })` |

`refresh()` POSTs to `__data/<name>/refresh`, the data URL's sibling, so the same server that serves the data rebuilds it — signed-in viewers can always refresh; a public share link only when its owner enabled live queries, throttled per binding. A refused refresh rejects with `status` 403/429 (with `retryAfterMs`), a failed query with 502 and its error message.

From SDK 2.7.4 every hook also returns `phase`: what `loading` or `refreshing` is waiting on. `bindingPhaseLabel(q)` turns it into a caption. "Building from warehouse" means the query is running (a refresh, a laptop dev build, a sandbox live binding). "Getting download link" means the file exists and Mako is signing its URL (well under a second; a published app never builds on a read). "Downloading" and "Loading into DuckDB" are the browser's own work. The server reports its phases on the same request as NDJSON when asked with `Accept: application/x-ndjson`; older servers answer as before.

### Preview rows while the data loads (SDK 2.9+)

`useQuery(name, { snapshot: true })` adds a `preview` field. Every build since this release also writes its first 500 rows (200 KiB cap) next to the parquet, served as `__data/<name>.snapshot.json`. That file is a few KB of JSON, so it arrives before DuckDB-WASM boots.

```tsx
const { data, loading, preview } = useQuery("recent_orders", { snapshot: true });
if (loading) return <OrdersTable rows={preview?.data ?? []} skeleton />;
return <OrdersTable rows={data ?? []} />;
```

- `data` stays null and `loading` stays true until the full parquet is in. Code that sums or filters `data` never sees the preview.
- `preview` is `{ data, fields, rowCount, truncated, builtAt }` while loading. It turns null when the rows arrive or the load fails.
- Preview values have the same types as `data`: DATE → `"YYYY-MM-DD"`, TIMESTAMP → ISO 8601, a 64-bit integer past 2^53 → BigInt.
- The snapshot holds the first N rows of the build stream, in the query's own order. Without an `ORDER BY` that order is the warehouse's choice. Use it for a skeleton or a first paint. Never sum, count or filter it.
- `preview` stays null for a binding with no snapshot: built before this release (refresh it once), a live binding, a draft still building on a laptop, or a DECIMAL, LIST or STRUCT column. The hook then behaves exactly as without the option.
- Without the option, `useQuery` behaves exactly as before and fetches no snapshot. `useDuckDB` never reads snapshots.

A binding can pin a workspace [dbt project](/transforms/) via `-- dbt_project: <id>` front matter for environment-aware schemas.

## House Style: `@makoai/app-sdk/ui`

Importing the SDK injects Mako's theme tokens (stone palette, warm `--canvas`, `--brand`, `--positive` / `--warning` / `--negative`, `--chart-1`…`--chart-5`; light and dark). Style with those names and the app follows the house palette for free. To re-theme, override a single token in your own stylesheet rather than pasting the whole token block.

The SDK also ships a small UI kit — plain ESM and plain CSS (no Tailwind required, classes prefixed `mk-`), and new apps are scaffolded on it:

```tsx
import "@makoai/app-sdk/ui.css"; // before ./styles.css, so the app wins
import { PageHeader, Card, KpiRow, KpiTile, Button, StatusDot,
  MultiSelect, FreshnessBadge, RefreshAllButton } from "@makoai/app-sdk/ui";
```

- `PageHeader`, `Card`, `KpiRow` / `KpiTile`, `Button`, `StatusDot` — page furniture.
- `MultiSelect` — controlled filter; an empty selection means "all" unless `emptyMeansAll={false}`. On phones the menu is a bottom sheet.
- `FreshnessBadge` — presentational: the app decides what "fresh" means and passes a `tone`, a `headline` and per-source rows.
- `RefreshAllButton` — rebuilds every binding (`refreshBinding`) a few at a time, with a progress modal. Feed it the binding names through a build-time `__APP_BINDING_NAMES__` define in `vite.config.ts` (the scaffold sets this up).

## SDK Versions

Apps declare `@makoai/app-sdk` with a caret range. On every deploy, Mako moves each app's `@makoai/*` dependencies to the newest release inside that range after install, so SDK fixes and design updates reach published apps without anyone copying files. This is best-effort and never fails a build; third-party dependencies stay locked.

## URL State & Routing

Apps can keep view state — the active tab, applied filters, a selected record, a sub-page — in the URL, so a reload restores it and the link is shareable. Reach for the `@makoai/app-sdk` hooks rather than `window.history` directly, and they work both embedded in Mako (`/a/:app`) and in the public share view (`/share/:token`):

```tsx
import { useLocation, useSearchParams, navigate } from "@makoai/app-sdk";

const loc = useLocation();
const [params, setParams] = useSearchParams();
navigate("/customers/42");
```

Use distinct **paths** for separate views and **query params** for filters and sort within a view.

## Local binding builds

During `vite dev`, the app SDK sends the local contents of
`bindings/<name>.sql` to Mako so uncommitted edits can be previewed. The
`POST /api/workspaces/:wid/apps/:id/bindings/:name/dev-build` endpoint builds
exactly that SQL with the connection named in its front matter; it does not
store the draft as a committed binding. Identical text can reuse the committed
artifact.

For long-running builds, add `?async=1` to the materialize endpoint, or send
`"async": true` in the dev-build request body (the SDK's dev flow does). When a
build is needed the API returns `202` with a job id (a stored artifact is served
directly); poll
`GET /api/workspaces/:wid/apps/:id/binding-jobs/:jobId` until the job is
`ready` or `error`, then fetch the parquet from
`GET .../binding-jobs/:jobId/artifact`. Jobs are retained for one hour. See also
[Working from a local checkout](/mcp-server/#working-from-a-local-checkout).

## Publishing & Sharing

- The **dev preview** is your branch's working copy, live (vite + HMR) — visible to you while you build.
- **Publishing** builds a commit on `main` into an immutable deployment; public and shared links serve the **published** build, never a draft, so viewers never see a half-finished edit.
- **Rollback** repoints the published deployment at an earlier build.
- History is git history: every commit, by person or agent, is browsable in Source Control.
- **Live status:** the published chip and `GET /api/workspaces/:wid/apps/:id/publish-state` show the deployed commit (author, time, and subject), publication time, whether app changes on the default branch are still pending, and the most recent deploy error. Reading this status does not start a sandbox.

## Discovery: Apps home and thumbnails

The **Apps home** (`/apps`, or the grid button in the Apps explorer) is the workspace's catalogue: Popular this month, New this week, Recently viewed, My apps, a **Recommended** grid through every other app (ranked server-side from popularity, recency, your own reads and quality, paged with infinite scroll), and — for an app's owner — Needs attention (failed deploy, failing data refresh, stale scheduled data). Its search, the `search_apps` agent tool and the command palette (Cmd/Ctrl+K) all search title, description, folder, owner and the warehouse tables each app's bindings read.

Each card shows the app's own **thumbnail**: an image at the app's root, named `thumbnail.png` (or `thumbnail.webp`, `.jpg`, `.jpeg`, `.svg` — the first one found wins), ideally **1200×750 (16:10)** and under 3 MB. Mako never screenshots apps; the builder ships the picture, and it updates with the next commit on `main`. New apps start with a placeholder `thumbnail.svg` (the app's title and the Mako mark); an app without any thumbnail gets a generated placeholder.

**Prefer `thumbnail.png`.** The thumbnail is also the app's **link preview**: a public share link (no password) posted in WhatsApp, Slack, LinkedIn, iMessage, Teams or X unfurls with the app's title, its `mako.json` description and the thumbnail. Those crawlers ignore SVG, so an app with only an SVG thumbnail unfurls with a generic Mako image. Mako serves cards a resized WebP and crawlers a JPEG re-encoded to at most 1200 px wide and ~300 KB (so WhatsApp shows the large preview), so the PNG can be full quality; keep the key content inside the centred **1200×630** band of the 1200×750 image, because previews crop to that. Password-protected shares unfurl generically (no title, no picture).

In-app links — the app viewer (`/view/<workspace>/<app>`, which the Share dialog copies), an app's tab URL (`/apps/<id>` or `/apps/<slug>`, query string and all), and a raw deployment link (`…/apps/<id>/live/`) — unfurl the same way, but only for an app every member of the workspace can already see: an app in the workspace `apps/` tree whose access is workspace-wide. Apps in a personal tree (`users/<handle>/…`), apps restricted to some people, and unknown links unfurl generically. The preview never contains data — only the title, the `mako.json` description and the thumbnail. A workspace owner or admin can turn in-app previews off with `PUT /api/workspaces/:id/link-previews` (`{ "enabled": false }`); they are on by default. A tab URL carries no workspace: `/apps/<id>` names its app directly, and `/apps/<slug>` is used only when exactly one workspace app (in a workspace with previews on) has that folder name — an ambiguous slug unfurls generically.

Go wild with it: a thumbnail is the app's poster. Headline it with the question the app answers, add one stylised motif of what it shows (a leaderboard, a funnel, a radar), bold type on a strong background — like a YouTube thumbnail rather than a screenshot. Never put numbers on it that look like real data. Design it as an SVG (and export to PNG if it uses fonts or filters), or ask an image model for one. SVG thumbnails are displayed as images only: scripts, external fonts and external images do not load.

**Related apps.** Search lists the word matches first, then appends up to 12 semantically **related** apps (`matchedOn: ["related"]` in `GET /api/workspaces/:wid/apps/search` and `search_apps`), so "acquisition" can find an app that never uses the word in its title. Each app is embedded once per content change from its title, description, folder, tables, UI labels and the start of its README. Related matches need a relative score well above the query's average, so a vague query adds few or none. Without an embedding key, or when the embedding service is slow (over 1.5 s) or fails, search quietly falls back to word matches only. The Apps home search box and the command palette have a clear (x) button.

**Write a one-line description.** The `description` in an app's `mako.json` is shown under the title on the Apps home and is read by search, so say what the app measures, for whom and which markets. The agent's `app_create_app` tool requires it.

## Access Control

Apps have two access levels:

- **`private`** (default): owner-only. Workspace admins and API keys cannot read or modify another member's private app.
- **`workspace`**: visible and editable by any workspace member.

Public links (optionally password-protected) render the published deployment for anonymous viewers.

## Personal and workspace apps

New apps are **personal by default**. A personal app lives under your own tree, `users/<handle>/apps/<slug>/`; the **handle** is the local part of your email (`joan@example.com` → `joan`, with `-2`, `-3` … on a collision inside the workspace; the longest-standing member keeps the bare one). The same `users/<handle>/` tree holds your personal consoles and notebooks. A folder's name grants nothing: ownership comes from the workspace's handle mapping, so a folder named after anything else (a user id, a typo) belongs to nobody.

Sharing is a deliberate move. **Share with workspace** (in the app's context menu, or `POST /api/workspaces/:wid/apps/:id/share-with-workspace`) commits a move of the folder into the workspace `apps/` tree and writes a one-line description into `mako.json`. The app keeps its id, so its deployment, sharing and favourites follow it. Only the app's owner, with an editing role, can do this. The agent's `app_list_apps` returns your `personalFolder` and its `app_create_app` files new apps there; `search_apps` searches first, so the agent can propose extending a close match instead of scaffolding a near-copy.

Workspace admins can mark a workspace app **verified** (context-menu toggle, `PUT /api/workspaces/:wid/apps/:id/verified`). Verified apps are never marked stale by the lifecycle job below.

## Usage and popularity

Every view of a published app is recorded: the in-Mako app tab and the `/view/` page report an `open` plus a heartbeat every 60 seconds while the app is visible (the dev preview never reports), and share links, raw `/live/` links and embeds are counted server-side when their HTML entry is served. Viewers on share links and embeds are keyed by a first-party random cookie (`mako_viewer`), not their IP address; crawlers and link unfurlers are logged as bots and counted nowhere.

Counts roll up per viewer per UTC day (`app_usage_daily`), and every event is also kept raw (`app_usage_events`, 13-month TTL). `GET /api/workspaces/:wid/apps/usage?days=28` returns per app the viewers, non-author viewers, visit-days, opens, active seconds, last opens and a **popularity score**: the sum over non-author viewers of their distinct active days, each weighted by `0.5^(age_days/14)`. `GET .../apps/recent` returns the caller's recently viewed apps. The Apps home cards show visit-days (person-days in the last 28 days, authors included, plus anonymous viewers) and "Data last refreshed" for the app's current bindings only.

## App lifecycle: stale and archived apps

A daily job (`apps-lifecycle-daily`, 06:00 UTC) keeps the catalogue from filling up with abandoned apps:

- **Stale** — nobody except the app's authors opened it in **60 days** and it has had no commit in that time. The owner (or, for an app without one, the workspace admins) gets an email notice. Apps younger than 14 days, verified apps, and apps restored in the last 60 days are never marked stale. A commit that touches many apps at once (an SDK bump) does not count as editing any of them.
- **Archived** — **14 days** after the notice, unless the app was opened or edited meanwhile, a Mako bot commit moves it to `archive/<path>` in the repo. That folder is outside both app trees, so the app is neither indexed nor built.
- **Paused schedules** — an app with scheduled bindings that nobody opened in **30 days** has its binding schedules skipped (its front matter is untouched) until the next open.

Owners see their archived apps behind the **Archived** chip on the Apps home (`GET .../apps/archived`) and can **Restore** them (`POST .../apps/archived/restore`): the folder moves back to where it was, keeps its id, and starts a fresh 60-day grace period. Workspace admins can preview what the job would do with `GET .../apps/lifecycle/plan`.

The job is a **dry run** (it only logs its plan) unless the `APPS_LIFECYCLE_ENFORCE` environment variable names the workspaces to enforce in: a comma-separated list of workspace ids, or `all`. See [Deployment](/deployment/#environment-variables).

## Chat with an app

Anyone who opens an app's live link (`/api/workspaces/:wid/apps/:id/live`) in a browser lands on a **viewer page** (`/view/<workspace>/<app>`): the published app full-screen, with an **Ask** chat beside it (resizable and hideable). The redirect only applies to top-level browser navigations to the app's page — the bundle's own requests (assets, `__data/`), API clients and embeds are served as before, and `?raw=1` opts out. The app's query string (filters, tabs) is carried over.

Chat is **off by default**. The app's owner or a workspace admin turns it on with **Let viewers chat with this app** in the Share dialog (or `PATCH /api/workspaces/:wid/apps/:id/chat` with `{ "enabled": true }`). It works for people who can open the live link (they need read access to the app) and only once the app is published.

The chat runs a closed `app_chat` agent that answers **only** from what the app has published, never from the underlying warehouse:

- `describe_app_data` — the app's bindings (tables) with their SQL, columns, row counts and sample rows
- `query_app_data` — read-only SQL over the published binding data (a locked-down DuckDB)
- `read_app_source` — the app's source files at the published commit

It cannot change the app, its data or its filters. If a question needs data the app doesn't have, it says so. Each viewer's own chats with the app are listed by `GET /api/workspaces/:wid/apps/:id/chats` (the 50 most recent).

## Identity: `useViewer()`

Apps can ask who's looking. `@makoai/app-sdk` (v2.4+) exports a `useViewer()`
hook:

```ts
const { viewer, loading, error } = useViewer();
```

`viewer` is `null` for an anonymous visitor on a public share link.
Otherwise it resolves to:

```ts
{
  id: string;
  email: string; // lowercased
  workspace: { id: string; name: string; role: "owner" | "admin" | "member" | "viewer" | null };
  app: { id: string; slug: string; role: "owner" | "editor" | "viewer" | null };
}
```

`workspace.role` is the person's access role on the workspace itself;
`app.role` is their role on this specific app (owner/editor/viewer). Mako
resolves both server-side from the session or a signed token — the app's
own code cannot forge them. A standalone `getViewer()` promise is also
available for non-React contexts.

This is UI-shaping data, not access control: every binding an app can read
is downloaded whole to the browser regardless of who's viewing, so don't
rely on `useViewer()` to hide data — gate what a binding *contains*
instead if that's the goal. Team, seniority, quota, or any other business
attribute isn't part of the viewer shape by design; join a roster binding
on `lower(viewer.email)` if the app needs it.

For local development, set `MAKO_VIEWER_AS=<email>` in the app's `.env` to
preview the app as a specific workspace member during `pnpm dev`.

## Security Model

- Binding queries are validated against the workspace's connections and run server-side with read-only enforcement on materialization SQL.
- A binding is the app's whole data, so one past its row limit (2,000,000 by default, `-- row_limit:` up to 5,000,000) **fails its build** instead of being silently cut. The run records the error, and the previously built artifact keeps being served. The error names the binding, the rows its query returned and the `-- row_limit:` that would fit them. Raise the limit, or aggregate or shard the binding's SQL.
- The sandbox is an isolated microVM per workspace; app code and shell commands never run in Mako's API process.
- The preview iframe is sandboxed; app code receives query *results* only — never credentials.

## API Surface

Apps are managed under `/api/workspaces/:wid/apps` (list/create/delete, files, exec, branches, commit/merge, bindings and materialization, publish/rollback, public share, sandbox lifecycle; plus `/discovery` and `/feed` for the Apps home, `/usage` and `/recent`, `/archived` and `/lifecycle/plan`). The workspace repo itself is served over git HTTP at `/api/apps-git/:workspaceId.git`, authorized by a scoped workspace git token. See the OpenAPI spec for full schemas, and [MCP Server](/mcp-server/) for driving all of this headlessly with the `app_*` tools.
