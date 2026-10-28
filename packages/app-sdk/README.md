# @makoai/app-sdk

The runtime SDK for [Mako](https://mako.ai) data apps — React hooks over an
app's data bindings, a Vite plugin that serves those bindings during a local
`vite dev`, and Mako's house dashboard kit (`@makoai/app-sdk/ui`).

Apps depend on the published package with a caret range
(`"@makoai/app-sdk": "^2.7.0"`), and Mako's deploys move every app to the
newest release within that range — fixes and design updates reach apps
without anyone copying files. Do not vendor it into a workspace repo.

## Install

Apps use **pnpm** (new apps pin it in `packageManager`; Mako installs each
app with the package manager its lockfile names):

```bash
pnpm add @makoai/app-sdk
```

Do not run `npm install` in a pnpm app — it ignores `pnpm-lock.yaml` and
writes a competing `package-lock.json`.

## In the app

```tsx
import { useQuery, useDuckDB, useSearchParams, useTheme } from "@makoai/app-sdk";

// Rows of bindings/<name>.sql, materialized to parquet by Mako.
const { data, loading, error } = useQuery("latest_sales");

// Analytical SQL over the bindings (DuckDB-WASM in the browser; table
// names are binding names). Only the bindings the SQL names download.
const totals = useDuckDB("select country, sum(revenue) r from latest_sales group by 1");

// Rematerialize on demand: re-runs the binding's query on the warehouse,
// then every hook reading it re-renders with the new rows. The old rows
// stay on screen while `refreshing` is true.
const { refresh, refreshing } = useQuery("latest_sales");
<button onClick={() => refresh().catch(e => alert(e.message))} disabled={refreshing}>
  Refresh
</button>
```

### Which SDK is running: `SDK_VERSION` (2.9+)

`import { SDK_VERSION } from "@makoai/app-sdk"` is this package's version.
Importing the SDK also sets `window.__MAKO_APP_SDK__` to it. In DevTools,
switch the console context to the app's frame and read
`__MAKO_APP_SDK__` to see which release a deployed app's build resolved.

### Preview rows while the parquet loads (2.9+, opt-in)

```tsx
const { data, loading, preview } = useQuery("latest_sales", { snapshot: true });
// loading && preview → paint preview.data as a skeleton table
// !loading           → data is the full binding; preview is null
```

Every build writes its first 500 rows (200 KiB cap) next to the parquet as
`__data/<name>.snapshot.json`. With `snapshot: true` the hook fetches it once
per page (skipped when the parquet is already loaded) and exposes it as
`preview` = `{ data, fields, rowCount, truncated, builtAt }`. `data` and
`loading` behave exactly as without the option, and a failed load clears
`preview`. Preview values have the same types as `data` (DATE →
`"YYYY-MM-DD"`, TIMESTAMP → ISO 8601, a 64-bit integer past 2^53 → BigInt).
The snapshot is the first N rows of the build stream in the query's own
order, with no `ORDER BY` guarantee. Use it for a skeleton or first paint.
Never aggregate it. `preview` is null when a binding has no snapshot (built
before 2.9's server release, live, a laptop draft still building, or a
DECIMAL/LIST/STRUCT column). Without the option no snapshot is fetched.

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

### Custom data work: one engine (2.8)

Never import `@duckdb/duckdb-wasm`, `hyparquet` or `apache-arrow` parquet
readers in an app. Use the page's engine through the SDK:

```ts
import { getDuckDB, withConnection, ensureBinding, unloadBinding, fetchBindingBytes, useDuckDB } from "@makoai/app-sdk";

const big = useDuckDB("select lat, lng from listings", { format: "arrow" }); // data: Arrow Table
const table = await ensureBinding("valuations");          // loaded once, returns "valuations"
const n = await withConnection(c => c.query(`select count(*) from ${table}`));
await unloadBinding("valuations");                         // free its memory
const bytes = await fetchBindingBytes("valuations", { onProgress: p => p && console.log(p.phase, p.bytes, p.bytesTotal) });
const db = await getDuckDB();                              // shared: never close() or terminate()
await db.registerFileBuffer("valuations.parquet", bytes);  // read_parquet with your own options
```

### Loading cost (2.8)

- `useDuckDB` downloads only the bindings its SQL names. A missed name (for
  example `query_table('x')`) loads when DuckDB reports the table missing,
  and the query re-runs. `SHOW TABLES` / `information_schema` load all.
- Each binding is decoded once into a DuckDB table and its file buffer is
  freed. A refresh swaps the table in one commit, so a running query never
  sees it missing. A table costs about 3x the parquet in memory (10 MB of
  parquet, 149k rows: 33 MB).
- The DuckDB engine and its parquet extension start loading on the first
  data hook render, in parallel with the first binding download.
- Rows decode column by column: 149k rows x 16 columns in 190 ms, down
  from 740 ms. Values are unchanged (DATE as `YYYY-MM-DD`, TIMESTAMP as
  ISO 8601, BigInt as Number when safe).

Data arrives from `__data/<name>.parquet`, relative to the page — the same
path in Mako's sandbox, in a published app, and on a laptop.

### What a load is waiting on: `phase` (SDK ≥ 2.7.4)

`useQuery` and `useDuckDB` return `phase` while `loading` or `refreshing`,
plus `rowsWritten`, `bytes` and `bytesTotal` when known. Caption a progress
bar with `bindingPhaseLabel(...)`:

```tsx
import { useQuery, bindingPhaseLabel } from "@makoai/app-sdk";

const q = useQuery("latest_sales");
if (q.loading) return <Spinner label={bindingPhaseLabel(q)} />;
// "Building from warehouse · 120,000 rows" → "Getting download link"
// → "Downloading · 3.1 MB of 10.0 MB" → "Loading into DuckDB" → "Running query"
```

| Stage (`bindingPhaseStage`) | Phases | What is happening |
| --- | --- | --- |
| `building` | `queued`, `querying_warehouse`, `writing_parquet`, `uploading` | Mako runs the query on the warehouse. Seconds to minutes. Only a refresh, a laptop dev build or a sandbox live binding builds. |
| `linking` | `resolving`, `signing` | The file exists. Mako finds it and signs its download link. Under a second. |
| `downloading` | `downloading` | The browser fetches the parquet. |
| `loading` | `loading_duckdb` | DuckDB-WASM boots and registers the file. |
| `querying` | `running_sql` | Your SQL runs. |
| `waiting` | `requesting`, `checking` | Sent; the server has not said which yet. |

The SDK learns the server-side phases on the same request: it sends
`Accept: application/x-ndjson`, and a server that knows phases answers one
JSON event per line, ending with `{"phase":"ready", …}` (a stored file's
event carries the signed `url` and `timings`) or `{"phase":"failed",
"status", "error"}`. A server that predates this answers as before, and the
SDK still reports `requesting` → `downloading` → `loading_duckdb`.
`refreshBinding(name, { onProgress })` hears every phase of one refresh;
`useBindingProgress()` lists every pending binding. `RefreshAllButton`
captions each running source with its phase.

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

## The house style: `@makoai/app-sdk/ui`

Importing the SDK injects Mako's theme tokens (stone, warm canvas, `#527df2`
brand; light and dark): `--background`, `--foreground`, `--card`, `--border`,
`--muted-foreground`, `--brand`, `--canvas`, `--positive` / `--warning` /
`--negative`, `--chart-1`…`--chart-5`, … Style with these names and the app
follows the house palette and dark mode for free. Override a token in your own
stylesheet to re-theme; do not paste the whole block.

The kit is the dashboard furniture every app was re-forking:

```tsx
import "@makoai/app-sdk/ui.css"; // before ./styles.css, so the app wins
import {
  PageHeader, Card, KpiRow, KpiTile, Button, StatusDot,
  MultiSelect, FreshnessBadge, RefreshAllButton, DataTable,
} from "@makoai/app-sdk/ui";

<PageHeader
  title="Spain renewals"
  subtitle="Contracts up for renewal in the next 90 days"
  actions={<>
    <FreshnessBadge tone="ok" headline="Synced 12m ago"
      title="Data as of 09:05" schedule="Refreshes 06:30 / 18:30 Europe/Zurich"
      sources={[{ label: "Stripe", value: "09:05", tone: "ok" }]} />
    <RefreshAllButton bindings={__APP_BINDING_NAMES__}
      labels={{ renewals: "Renewals" }} last={["data_freshness*"]} />
  </>}
/>
<KpiRow>
  <KpiTile label="Up for renewal" value="412" delta="+8%" tone="ok" hint="vs last quarter" />
</KpiRow>
<MultiSelect options={["CH", "ES", "IT"]} value={countries} onChange={setCountries} allLabel="All countries" />
```

- `MultiSelect` — controlled (`value` / `onChange`). An empty selection means
  "all" unless `emptyMeansAll={false}` (then "all" = every value selected).
  Options are strings or `{ value, label, color }`; `showOnly` adds an "Only"
  button per row. On phones the menu is a bottom sheet.
- `FreshnessBadge` — presentational: the app decides what fresh means and
  passes `tone` (`ok` / `warn` / `bad`, or `green` / `amber` / `red`), a
  `headline`, and per-source rows; `action` is a callout slot (e.g. a "Load
  latest" button).
- `RefreshAllButton` — rebuilds every binding (`refreshBinding`),
  `concurrency` at a time (default 3 — keep it low), `first` / `last` / `skip`
  patterns (`*` suffix = prefix), with a progress modal. Give it the binding
  names with a build-time define in `vite.config.ts`:

  ```ts
  import { existsSync, readdirSync } from "node:fs";
  const bindingsDir = new URL("./bindings", import.meta.url);
  // inside defineConfig({ … }):
  define: {
    __APP_BINDING_NAMES__: JSON.stringify(
      // An app with no bindings/ folder yet (a new shell app) has none:
      // without the existsSync guard the config throws ENOENT and
      // `vite build` fails before it starts.
      existsSync(bindingsDir)
        ? readdirSync(bindingsDir)
            .filter(f => f.endsWith(".sql")).map(f => f.slice(0, -4))
        : [],
    ),
  },
  ```

  and declare it once (`src/vite-env.d.ts`):
  `declare const __APP_BINDING_NAMES__: string[];`

### Chart tooltips: `TableTooltip` (2.10+)

Every chart tooltip is a table, never recharts' coloured `name : value` list:
a bold title, small muted column headers, one row per series with a 9px
swatch in the series colour and the label in plain text, right-aligned
tabular numbers, and a bold total row under a rule.

```tsx
import { tableTooltip, tooltipSeriesRows } from "@makoai/app-sdk/ui";

const SEGMENTS = [ // bottom-up, as stacked; drives the bars AND the tooltip
  { key: "new", label: "New", color: "var(--positive)" },
  { key: "churn", label: "Churn", color: "var(--negative)" },
];

<Tooltip
  content={tableTooltip((d) => ({
    title: d.month,
    columns: ["MRR", "Orgs", "% of start"],
    rows: tooltipSeriesRows(d, SEGMENTS, { stacked: true }).map((r) => ({
      ...r, cells: [fmtEur(r.value), fmtInt(d[`orgs_${r.key}`]), fmtPct(r.value / d.start)],
    })),
    total: { label: "Net change", cells: [fmtEur(d.net), fmtInt(d.netOrgs), fmtPct(d.net / d.start)] },
  }))}
/>
```

- `tooltipSeriesRows(datum, series, { stacked })` puts the rows in reading
  order (a stack's top segment first, lines highest first) and drops empty
  values.
- `total` is the stack total, "All selected", or the base the % is of.
  `after` rows follow it, apart: a value on another axis.
- Precompute what the tooltip shows (totals, counts, bases) in each data row.
  The builder only reads and formats.
- On a chart with an HTML overlay (a donut's centre label), lift the tooltip:
  `<Tooltip wrapperStyle={{ zIndex: 20 }} … />`.

### Data tables: `DataTable` (2.11+)

`DataTable` is the table the best workspace dashboards converged on: a card
with click-to-sort headers, a sticky header, an optional pinned first column,
right-aligned tabular numbers, fixed column widths, a pager footer ("1–50 of
312 customers", 25 / 50 / 100 per page, « ‹ Page 2 of 7 › »), an empty state
and CSV export.

```tsx
import { DataTable, type DataTableColumn } from "@makoai/app-sdk/ui";

const COLUMNS: DataTableColumn<Customer>[] = [
  { id: "name", label: "Customer", value: c => c.name, sticky: true, width: 260,
    render: c => <><div>{c.name}</div><SystemLinks c={c} /></> },
  { id: "paid", label: "Paid on", value: c => c.paidDay, date: true, render: c => fmtDay(c.paidDay) },
  { id: "mrr", label: "MRR", num: true, value: c => c.mrr, render: c => fmtEur(c.mrr) },
  { id: "links", label: "Links", value: () => null, sortable: false, csv: false, width: 120, render: c => <Links c={c} /> },
];

<DataTable
  title={`${fmtInt(list.length)} customers not onboarded`}
  actions={<input className="search" value={q} onChange={e => setQ(e.target.value)} />}
  rows={list}
  resetKey={q}
  columns={COLUMNS}
  noun="customers"
  empty="No customers match these filters."
  defaultSort={{ id: "mrr", dir: "desc" }}
  exportFilename="onboarding-customers"
  fill
/>
```

- **Columns.** `value(row)` is what the column sorts by and exports;
  `render(row)` is what the cell shows. `num` right-aligns with tabular
  figures and sorts largest first on the first click (text sorts A→Z). Empty
  values (null, "", NaN) sort last both ways. `sticky` (pin the first column),
  `sortable: false`, `hint` (header hover text), `csv` (`false` to leave a
  column out, a function for a readable cell such as a level name). Numeric
  strings ("1.25", "-10") sort as numbers.
- **Widths: no layout shift.** The table uses `table-layout: fixed` and a
  `<colgroup>`, so a column's width never depends on the rows on screen.
  Sorting, filtering, paging, the empty state and loading all keep the same
  widths. Each column is exactly its `width` (px as a number, or any CSS
  length such as `"12rem"`). Defaults by kind: `num` or right-aligned 96px,
  `date: true` 110px, the first or sticky column 240px, other text 140px.
  When the card is wider than the sum, the `grow: true` columns take the extra
  space. Without one, the first column grows. `minWidth` sets a growing
  column's floor. When the card is narrower than the sum, the table scrolls
  sideways inside the card. `columnLayout(columns)` returns the widths the
  table renders.
- **Cells stay on one line.** A cell ellipsizes at its column's width with the
  raw value (text or number) as the hover title. Headers ellipsize too, and
  the sort icon stays visible. `truncate: false` wraps a cell's text inside
  its column instead: the width holds and the row grows.
- **Sort, page, page size** are each uncontrolled by default or controlled with
  `sort` + `onSortChange`, `page` (1-based) + `onPageChange`, `pageSize` +
  `onPageSizeChange`, so an app can keep them in the URL. Pass your filter
  state as `resetKey` (e.g. `resetKey={{ q, owners }}`): when it changes the
  table goes back to page 1. A sort or page-size click resets the page too.
  New row objects never do, so a load or a background refresh keeps the page.
  A page past the end shows the last page and reports it through
  `onPageChange`. The table scrolls to the top on a page change. `rows`
  defaults to `[]`, so a table can render while its data loads.
- **Page size.** 50 rows by default, with 25 / 50 / 100 in the select.
  `defaultPageSize={100}` opens on 100 rows. `pageSizes` sets the choices (one
  entry hides the select). A size outside the list still shows as the selected
  option.
- **Height.** `fill` makes the card fill its parent's height and the body
  scroll inside it, with the pager always in view: give the parent a height
  (e.g. `<main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>`).
  On phones it falls back to a 70vh scroll box. Without `fill` the body scrolls
  past `maxHeight` (default 70vh).
- **Rows.** `onRowClick(row)` makes rows clickable (and Enter or Space on a
  focused row); clicks on links and buttons inside a cell stay theirs.
  `rowLabel(row)` names a clickable row for screen readers. `rowKey` defaults
  to `row.id`.
- **CSV.** `exportFilename` adds an "Export CSV" button that downloads every
  row on every page, as sorted. Mako's app frames allow downloads. Numbers
  export as is. Text starting with `=`, `+`, `-`, `@`, tab or CR gets a
  leading apostrophe so a spreadsheet never runs it. A Date at local or UTC
  midnight exports as `YYYY-MM-DD`, any other Date as a UTC ISO timestamp. For
  your own button: `saveCsv(filename, toCsv(rows, columns))` returns
  `"downloaded"` or `"failed"`.
- Pure helpers for custom tables: `sortRows`, `compareValues`, `nextSort`,
  `pageSlice`, `pageToSync`, `toCsv`, `csvCell`, `csvDate`, `csvToTsv`.

`ui.css` is plain CSS (no Tailwind needed; it coexists with Tailwind) and
every kit class is prefixed `mk-`. It also sets the house base: Inter 14px on
the warm `--canvas`.

**Native `<select>` (2.11.1+).** macOS draws the native dropdown arrow flush
against the right border. `ui.css` styles every single-line `<select>` like the
MultiSelect trigger: 32px tall, 14px text, a token-coloured chevron 10px in
from the right, 28px of right padding, hover and focus rings, dark mode from
the tokens. It stays a native select, so keyboard and screen readers work as
before. The rule sits in `@layer base`, so any rule of the app wins (plain CSS
and Tailwind utilities alike). `[multiple]` and `[size]` list boxes keep the
native look. A select with `appearance-none` in its classes (shadcn's
`NativeSelect`) draws its own arrow and is left alone. Setting
`appearance: none` or a `padding` shorthand in your own CSS takes the chevron or
its 28px gap away: draw your own arrow at least 10px from the edge, or leave
the base alone.

## In `vite.config.ts`

```ts
import { makoData } from "@makoai/app-sdk/vite";

export default defineConfig({ plugins: [react(), makoData()] });
```

`makoData()` answers `__data/index.json` (the app's `bindings/*.sql`),
`__data/<name>.parquet` and `__data/<name>.snapshot.json` during `vite dev`
from the Mako API, and what it asks
for is **your local binding file**: it sends the text of
`bindings/<name>.sql` and gets back the parquet of exactly that query, run
read-only through the workspace connection its front matter names. When the
text is the committed binding, that is the app's stored artifact (built on
first request if it never was); when you have edited it, Mako builds a draft
from your text and hands it back without storing it — nobody else, and no
published viewer, ever sees uncommitted SQL. Building needs edit access to the
app; read-only members get committed artifacts. `POST __data/<name>/refresh`
(the SDK's `refresh()`) rebuilds from the local text on demand.
`__data/<name>.snapshot.json` is asked for by the same text: the API answers
with the snapshot of exactly the stored artifact that text maps to, and 404
while a draft still needs building. An edited query never paints the
committed query's preview. Snapshots are not cached locally.

Builds run as jobs: the plugin asks for one (`async`), gets a job id back at
once, and polls it until the parquet is ready — so a query that runs for
minutes is waited for instead of failing when a proxy cuts the request at
100 s. `pollIntervalMs` / `buildTimeoutMs` tune the wait (1 s, 30 min).

Results are cached under `node_modules/.mako-data/` next to a fingerprint of
the text they were built from. A cached copy of the current text is served
at once. Once it is older than `revalidateMs` (five minutes), it is also
rebuilt in the background for the next load. `?refresh` waits for a
build. A copy from other text is never served: after an edit the cache is never served, however long
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
