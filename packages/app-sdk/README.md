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

### Performance: SQL does the work

One 193k-row app froze ~10 s on every filter click. It loaded the binding
with `useQuery` and filtered it in a component. The rules:

1. Filters, joins and aggregation run in SQL through `useDuckDB(sql)`, filters
   in the `WHERE` clause. Only the rows a panel draws come back to JS.
   `withConnection` serves a result several panels share. `useQuery(name)` is
   for bindings under ~10k rows or already aggregated to what the page shows.
2. One query per panel. Each panel returns a skeleton of its final size while
   `loading`, never a "0" or an empty chart. Filter controls update on the
   click frame; panels read filters through `useDeferredValue` or
   `startTransition`.
3. Measure before calling a UI done: the clicked control updates in under
   50 ms, no main-thread task runs over 200 ms during a filter change.
4. Keep bindings small: aggregate in the binding, drop unused columns, split
   a binding when one view needs far more rows.
5. One engine: never a private parquet reader or a second DuckDB.

```tsx
const f = useDeferredValue(country);
const q = useDuckDB(`select day, sum(revenue) r from latest_sales
  where country = '${f.replace(/'/g, "''")}' group by 1 order by 1`);
if (q.loading) return <div className="skeleton" style={{ height: 280 }} />;
```

In dev (`import.meta.env.DEV`), `useQuery` logs one `console.warn` per
binding that returns more than 20,000 rows, pointing to
`useDuckDB` (2.16+). Production builds never warn.

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
import { getDuckDB, withConnection, ensureBinding, unloadBinding, fetchBindingBytes, useDuckDB, getBindingMemory, setBindingMemoryBudget } from "@makoai/app-sdk";

const big = useDuckDB("select lat, lng from listings", { format: "arrow" }); // data: Arrow Table
const table = await ensureBinding("valuations");          // loaded once, returns "valuations"
const n = await withConnection(c => c.query(`select count(*) from ${table}`));
await unloadBinding("valuations");                         // free its memory
const bytes = await fetchBindingBytes("valuations", { onProgress: p => p && console.log(p.phase, p.bytes, p.bytesTotal) });
const mem = await getBindingMemory();                      // { usedBytes, budgetBytes, bindings }
await setBindingMemoryBudget(800 * 1024 ** 2);             // cap binding tables at 800 MiB
const db = await getDuckDB();                              // shared: never close() or terminate()
await db.registerFileBuffer("valuations.parquet", bytes);  // read_parquet with your own options
```

### Memory: least recently read goes first (2.12)

Each app frame has its own DuckDB with a 3.1 GiB heap. Before 2.12 every
binding table stayed in it for good, and an app with many bindings ran out
of memory. Now bindings aim to stay under a 1.5 GiB budget, and the rest of the
heap is for queries.

| 8 panels over 15 shards (6M rows, 23 columns) | Heap for bindings | All 8 panels |
| --- | --- | --- |
| Tables | 2,068 MiB | 5.3 s |
| Views over the parquet in the heap | about 150 MiB | 7.4 s |

- The budget counts what the SDK placed. Your own tables do not shrink it.
- A new table lands if the parquet's metadata says it fits, after evicting tables
  no one holds, least recently read first. It is an estimate, so the budget can
  overshoot (measured: 1,700 MiB against 1,536).
- A mostly empty heap lets one table past the budget, up to twice its size. An
  app with one large parquet keeps table speed.
- A binding that does not fit lands as a view: same name, same rows, slower. A
  later read makes it a table when there is room, with no download.
- A table you changed loses the change when it becomes a view. The view reads the
  parquet again. Copy a binding to your own table before you `UPDATE` or `ALTER` it.
- The parquet stays in JS memory as a Blob, so a table can become a view with no
  download. Past 512 MiB of Blobs, the oldest unpinned views are dropped and
  download again on their next read. If a Blob stops being readable, its table is
  dropped and downloads again on its next read.
- Parquet copies in the heap stop at 2.5 GiB. Past it, the least recently read view
  goes, even a pinned one, and downloads again on its next read. A parquet with no
  room fails with a clear error.
- A binding a mounted `useQuery`/`useDuckDB` reads is pinned: it goes last.
  `ensureBinding` bindings can become views but are never dropped.
- "Out of Memory" on a hook's query demotes unpinned tables, then the pinned tables
  that query reads, and runs again until it answers or none is left. Other panels'
  tables stay. For the next minute no table grows back past what is left, then
  pinned views promote by themselves. `withConnection` does not retry: your `fn`
  may not be safe to run twice.
- A mounted hook whose query still fails on memory reruns after 1, 2, 4, 8 and 15 s,
  then waits. Another hook letting go of its bindings, a budget change, or the tab
  coming back starts one more run. A hidden tab never reruns. The error stays up
  until a run answers.
- Do not `registerFileHandle` a Blob with `BROWSER_FILEREADER`. In duckdb-wasm
  1.29.0 its size is lost when the allocator returns a pointer past 2 GiB, and
  reads fail with "too small to be a Parquet file". Use `registerFileBuffer`.
- A hook's query can name at most 50 bindings. A double-read `UNION ALL` of about 60
  overflows the WASM stack and breaks the engine for every panel, so the SDK refuses
  it with a clear error. `withConnection` and `getDuckDB()` have no such check.
- If the engine traps anyway, a hook's query restarts it, at most once a minute and
  3 times a page. Every panel reruns and every binding downloads again. A
  `getDuckDB()` handle held across a restart is dead: call it again.

`setBindingMemoryBudget(bytes)` changes the 1.5 GiB default. `getBindingMemory()`
shows what is loaded, oldest first, `bindingBytes` against the budget, `usedBytes`
for the whole heap, and `pressure`.

### Failed downloads (2.12)

- A page runs at most 12 downloads at once, and one after a failure.
- A rejected fetch, a 429 or a 503 closes a page-wide gate for 1, 3, 9, 27, then
  60 s, with jitter. Past 3 failures in a row, a request while it is closed fails
  at once with no network. Any other answer opens it.
- A download tries 3 times, on the first request and on the signed download alike,
  and only until headers arrive. A `retryAfterMs` up to 30 s sets the wait.
- A mounted hook then reruns after 5, 20 and 60 s, or after `retryAfterMs` if that
  is longer. Then it waits for the tab or the network to come back, or for another
  request to get an answer.
- A failed build never runs again by itself: not a `failed` event, whatever its
  text, and not a build stream cut halfway. Other HTTP statuses and SQL errors stay
  as they are too. A new query or a reload asks again.
- A failed `__data/index.json` is kept for 10 s. A query that needs no binding still
  answers. A query that fails then shows the index failure and retries.

### Compressed tables on DuckDB 1.4 (2.14)

The engine moved from duckdb-wasm 1.29.0 (DuckDB 1.1.1) to 1.32.0 (DuckDB 1.4.3).
Binding tables live in `ATTACH ':memory:' (COMPRESS)`, and a view with the
binding's name reads them.

| Stored as tables, real parquet | 1.29.0 | 1.32.0 | Saved |
| --- | --- | --- | --- |
| Web Performance 7d, 10.9M rows | 3,003 MiB | 176 MiB | 94.1% |
| Traffic Performance, 2.4M rows | 977 MiB | 75 MiB | 92.4% |
| Financial Model, 489k rows | 153 MiB | 26 MiB | 83.1% |
| INTL Sales, 1.9M rows | 601 MiB | 109 MiB | 81.9% |
| Who's Looking, 198k rows | 33 MiB | 10 MiB | 69.1% |

- Very long strings stay uncompressed: `comps_*`, at 720 KB a row, saved 0%.
- A table you create is uncompressed: it lives in the default database.
- A binding's name is a view. `INSERT`, `ALTER`, `DROP TABLE` and
  `CREATE OR REPLACE TABLE <binding>` fail: copy it into a table with another name.
- A CTE read twice is held whole in scratch, and no setting stops that. Write
  `WITH u AS NOT MATERIALIZED (...)` over big bindings: 1.29.0 parses it too.
- `TIMESTAMPTZ` reads UTC, as it did on 1.29.0: the SDK runs
  `SET GLOBAL TimeZone='UTC'` at boot.
- Boot also fetches ICU from extensions.duckdb.org. If that fails the boot fails,
  and a hook retries at 5, 20 and 60 s.
- Row order changes where a query has no `ORDER BY`, and so does `any_value`.

### Memory across apps (2.13)

Inside Mako, each app frame posts what its heap holds. Past 2 GiB across the
open app tabs, Mako asks the least recently shown ones to release, and asks a
busy frame again 10 s later. A WASM heap never shrinks, so a release ends that
frame's DuckDB worker. Its rows stay on screen and its parquet stays as Blobs.
The next query there boots a new engine and reloads its parquet with no
download. A reboot takes 0.6 s on the app's own origin and 0.6 to 2.6 s in an
opaque frame, which has no HTTP cache and fetches the 35 MiB WASM again.

- A frame keeps its engine for the page's life once app code calls
  `getDuckDB()`, `withConnection()` or `ensureBinding()`, or sends `useDuckDB`
  SQL that is not a plain read (`CREATE TABLE`, `SET`, anything the SDK does
  not recognise). Only that worker has what they made. Mako counts its heap and
  asks another frame, so an app that needs to be a good neighbour sticks to
  read-only `useQuery` and `useDuckDB`.
- A release is not a crash. It does not count toward the 3 restarts a page gets,
  reruns no panel and leaves the download gate as it is. A parked binding reads
  with no network even while the gate is closed.
- Frames on an older SDK, the dev-mode preview and apps that boot their own
  DuckDB send no report. Mako cannot count or ask them. An app gets 2.13 on its
  next commit.
- A report covers tables and parquet copies. Query scratch stays in the heap
  unseen, so the real heap is larger (1037 MiB reported, about 1500 MiB in the
  renderer).

### Loading cost (2.8)

- `useDuckDB` downloads only the bindings its SQL names. A missed name (for
  example `query_table('x')`) loads when DuckDB reports the table missing,
  and the query re-runs. `SHOW TABLES` / `information_schema` load all.
- Each binding is decoded once into a DuckDB table and its file buffer is
  freed. A refresh swaps the table in one commit, so a running query never
  sees it missing. A table costs about 15 bytes a cell (400k rows x 23 columns:
  138 MiB from a 10 MiB parquet).
- Tables are evicted least recently read first (2.12). Over the memory
  budget (default 1.5 GiB of DuckDB's 3.1 GiB heap), the oldest table becomes
  a view over its compressed parquet. Its next read turns it back into a table
  without a download when it fits. See Memory above.
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

- `MultiSelect` — controlled (`value` / `onChange`). Options are strings or
  `{ value, label, color }`; `showOnly` adds an "Only" button per row. On
  phones the menu is a bottom sheet. See "MultiSelect: the All rule" below.
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

### MultiSelect: the All rule and one open popover (2.16+)

**All.** Nothing is filtered when `value` is empty or holds every option. The
All row is then ticked and every option row unticked, whichever of the two the
app passes. A click on an option under All selects only that option.
Unticking the last option, or ticking the last missing one, returns to All.
`emptyMeansAll` (default `true`) only sets what All emits: `[]`, or every
option's value when `false`.

**Trigger.** It reads the All label, the one selected label, or "3 selected".
`formatMany={n => `${n} markets`}` changes the last one. The trigger's `title`
lists the selected labels. Chips and `maxChips` are gone.

**Checkbox.** `Checkbox` (`checked`: `true` / `false` / `"mixed"`) is the
kit's one checkbox, coloured from `--primary` and `--input`. Draw the rows of
an app's own Radix menu with it, so every menu on the page ticks alike.

**One open at a time.** Opening a kit popover (`MultiSelect`,
`FreshnessBadge`) closes any other. Escape, a pointerdown outside and focus
leaving it close it too. The kit listens for pointerdown in the capture phase,
because Radix triggers cancel the mouse events of their pointerdown. When an
app's own menu opens, call `closePopovers()`:

```tsx
<DropdownMenu modal={false} onOpenChange={o => o && closePopovers()}>
```

Pure helpers for app-side menus: `multiSelectState(value, optionValues)`,
`multiSelectToggle(value, optionValues, v, emptyMeansAll)`,
`multiSelectText(value, options, allLabel, formatMany)`.

### Chart tooltips: `TableTooltip` (2.10+, every series from 2.15)

Every chart tooltip is a table, never recharts' coloured `name : value` list:
a bold title, small muted column headers, one row per series with a 9px
swatch in the series colour and the label in plain text, right-aligned
tabular numbers, and a bold total row under a rule.

The tooltip lists every legend series, in legend order, in every bucket. Its
height and column widths never change while the pointer moves.

- A zero shows a muted "0", or a muted "0%" for a rate.
- A missing value shows a muted "–". Missing means the bucket has no data, or
  the metric cannot be computed (a rate over a zero base).
- The value columns have a fixed minimum width (`--mk-tip-col`, default
  `7ch`).

```tsx
import { tableTooltip, tooltipCell, tooltipSeriesRows } from "@makoai/app-sdk/ui";

const SEGMENTS = [ // bottom-up, as stacked; drives the bars, the legend AND the tooltip
  { key: "new", label: "New", color: "var(--positive)" },
  { key: "churn", label: "Churn", color: "var(--negative)" },
];

<Tooltip
  content={tableTooltip((d) => ({
    title: d.month,
    columns: ["MRR", "Orgs", "% of start"],
    rows: tooltipSeriesRows(d, SEGMENTS, { stacked: true }).map((r) => ({
      ...r,
      cells: [
        tooltipCell(r.value, fmtEur),
        tooltipCell(d[`orgs_${r.key}`], fmtInt),
        tooltipCell(r.value == null || !d.start ? null : r.value / d.start, fmtPct, { percent: true }),
      ],
    })),
    total: { label: "Net change", cells: [fmtEur(d.net), fmtInt(d.netOrgs), fmtPct(d.net / d.start)] },
  }))}
/>
```

- `tooltipSeriesRows(datum, series, { stacked })` returns one row per series,
  `{ key, label, color, value, state }`. A stack reads top segment first.
  Other charts keep the series order, which is the legend order. `state` is
  `"value"`, `"zero"` or `"missing"`. A missing `value` is `null`.
- `tooltipCell(value, format, { percent })` renders a cell: a muted "–" when
  missing, a muted "0" or "0%" when zero, else `format(value)`.
  `tooltipCellText` returns the same as `{ text, muted }` for non-React code.
- A `null` or `undefined` cell in `TableTooltip` shows a muted "–". An empty
  string stays blank.
- `total` is the stack total, "All selected", or the base the % is of.
  `after` rows follow it, apart: a value on another axis.
- Precompute what the tooltip shows (totals, counts, bases) in each data row.
  The builder only reads and formats.
- On a chart with an HTML overlay (a donut's centre label), lift the tooltip:
  `<Tooltip wrapperStyle={{ zIndex: 20 }} … />`.

**Opt-out.** Before 2.15, `tooltipSeriesRows` dropped zero and missing values
and sorted line charts highest value first. A caller that truly needs that
passes `{ hideEmpty: true, byValue: true }`. `hideEmpty` drops zero and
missing rows. `byValue` sorts non-stacked rows highest first, missing last.
Both make the tooltip change height or order between buckets, so the house
rule is to leave them off.

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
