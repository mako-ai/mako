# @makoai/app-sdk

The runtime SDK for [Mako](https://mako.ai) data apps — React hooks over an
app's data bindings, plus a Vite plugin that serves those bindings during a
local `vite dev`.

Every Mako workspace repository carries this package at `packages/app-sdk`;
apps depend on it with `"@makoai/app-sdk": "file:../../packages/app-sdk"`. Mako
keeps the vendored copy current — do not edit it in a workspace repo.

## In the app

```tsx
import { useQuery, useDuckDB, useSearchParams, useTheme } from "@makoai/app-sdk";

// Rows of bindings/<name>.sql, materialized to parquet by Mako.
const { data, loading, error } = useQuery("latest_sales");

// Analytical SQL over every binding (DuckDB-WASM in the browser; table
// names are binding names).
const totals = useDuckDB("select country, sum(revenue) r from latest_sales group by 1");

// Rematerialize on demand: re-runs the binding's query on the warehouse,
// then every hook reading it re-renders with the new rows. The old rows
// stay on screen while `refreshing` is true.
const { refresh, refreshing } = useQuery("latest_sales");
<button onClick={() => refresh().catch(e => alert(e.message))} disabled={refreshing}>
  Refresh
</button>
```

`useDuckDB(...).refresh()` refreshes every binding; `refreshBinding(name)` /
`refreshBindings()` do the same outside a component. A refresh POSTs to
`__data/<name>/refresh`, the data URL's sibling, so whoever serves the app's
data (Mako, the sandbox dev server, the Vite plugin below) rebuilds it with
its own authorization: a signed-in member can always refresh; a public share
only when its owner enabled live queries, and at most once every few minutes
per binding. A refused refresh rejects with `status` (403, 429 + `retryAfterMs`)
or 502 with the query's error.

`useLocation` / `useSearchParams` / `navigate` keep filter state in the URL;
`useTheme` follows the OS preference. Theme tokens (`--background`,
`--chart-1`, …) match the ones the scaffold's `styles.css` declares.

Data arrives from `__data/<name>.parquet`, relative to the page — the same
path in Mako's sandbox, in a published app, and on a laptop.

### Who is looking: `useViewer()`

```tsx
import { useViewer } from "@makoai/app-sdk";

const { viewer, loading } = useViewer();
// viewer === null       → anonymous share link (or still loading)
// viewer.email          → "sam@acme.com"
// viewer.workspace.role → "owner" | "admin" | "member" | "viewer" | null
// viewer.app.role       → "owner" | "editor" | "viewer" | null
```

Mako resolves the viewer server-side from the session or the signed view
token — the page cannot forge it — and reports only what the platform
knows: identity, the workspace and the person's **access** role in it, and
their role on this app. There is no job title, team or country in the
platform, on purpose: those are your data. Put a roster in a binding and
join on the email:

```sql
-- bindings/viewers.sql
SELECT lower(email) AS email, team, country, is_lead FROM hr.people
```

```tsx
const { viewer } = useViewer();
const me = useDuckDB(
  viewer ? `select * from viewers where email = '${viewer.email.replace(/'/g, "''")}'` : "select 1 where false",
);
const board = useDuckDB(
  me.data?.[0]?.is_lead
    ? "select * from pipeline"
    : `select * from pipeline where team = '${me.data?.[0]?.team ?? ""}'`,
);
```

Keep the roster binding to the columns the app needs for its logic: every
binding the app can read is downloaded whole into the viewer's browser, so
this shapes the UI rather than enforcing access. Who may *open* the app is
the app's access setting in Mako; server-side row filtering is a follow-up
on the same identity (apps.md §28).

## In `vite.config.ts`

```ts
import { makoData } from "@makoai/app-sdk/vite";

export default defineConfig({ plugins: [react(), makoData()] });
```

`makoData()` answers `__data/index.json` (the app's `bindings/*.sql`) and
`__data/<name>.parquet` during `vite dev` from the Mako API, and what it asks
for is **your local binding file**: it sends the text of
`bindings/<name>.sql` and gets back the parquet of exactly that query, run
read-only through the workspace connection its front matter names. When the
text is the committed binding, that is the app's stored artifact (built on
first request if it never was); when you have edited it, Mako builds a draft
from your text and hands it back without storing it — nobody else, and no
published viewer, ever sees uncommitted SQL. Building needs edit access to the
app; read-only members get committed artifacts. `POST __data/<name>/refresh`
(the SDK's `refresh()`) rebuilds from the local text on demand.

Results are cached under `node_modules/.mako-data/` for five minutes
(`revalidateMs`; `?refresh` bypasses), next to a fingerprint of the text they
were built from: after an edit the cache is never served, however long
`revalidateMs` is, and while the API is unreachable a stale copy is served
only if it was built from the same text. It is `apply: "serve"` only —
production builds never load it.

### dbt models you are still building

A binding linked to dbt (`-- dbt_project: <id>`) writes `{{ dbt_schema }}`,
which renders to the production schema. To preview models you built into
your own dbt environment, point the dev server at it:

```ts
makoData({ dbtEnvironment: "joan" }) // or MAKO_DBT_ENV=joan in the repo's .env
```

The environment must exist in the linked dbt project (`dbt/environments.yml`),
and a personal environment (`owner_user_id`) renders only for its owner.
These builds are drafts too: never stored, never what a published app reads.

It also answers `__data/viewer.json` (you, as Mako sees you), and
`MAKO_VIEWER_AS=<email>` — in the environment or the repo's `.env` —
previews the app as that member instead (editors of the app only).

Credentials, in order: `MAKO_API_URL` / `MAKO_API_KEY` in the environment,
then in the repo-root `.env`. The workspace id comes from
`.mako/workspace.json` (or `MAKO_WORKSPACE_ID`). Without a key the app runs
and every binding answers `503` with a hint.

Dependency-free: the DuckDB engine loads from jsDelivr at runtime; the plugin
uses only Node built-ins.
