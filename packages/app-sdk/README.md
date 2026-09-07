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

### Viewer roles

An app can show different views by role — team leads see everything, a rep
sees their own rows — and Mako enforces it before the data reaches the
browser. Declare the roles in `mako.json`:

```json
"viewers": {
  "default": "bdr",
  "roles": {
    "team_lead": { "members": { "lead@acme.com": {} } },
    "bdr":       { "members": { "sam@acme.com": { "rep": "Sam Ple" } } }
  }
}
```

Roles are tried in declaration order; the first one listing the viewer's
email wins, else `default`, else the viewer is refused.

Nobody's email has to live in the repo: name a **`source`** binding and the
roster the warehouse already holds decides. Its rows carry `email`, `role`
and any other column as a claim; a viewer with no row gets `default`:

```json
"viewers": {
  "source": "fr_viewers",
  "default": "team_lead",
  "roles": { "team_lead": {}, "bdr": {} }
}
```

```sql
-- bindings/fr_viewers.sql
-- connection: <id>
-- roles: team_lead
SELECT LOWER(u.email) AS email, 'bdr' AS role, u.full_name AS rep
FROM crm.users u JOIN crm.group_members m ON m.user_id = u.id
WHERE m.group_name = 'BDR'
```

A role the source names but `roles` does not declare, or a source that was
never materialized, refuses the viewer — the roster and the repo must agree.
Then scope each binding in its front matter:

```sql
-- roles: team_lead, bdr                                 (who may read it; omit = everyone)
-- row_filter_bdr: sales_rep_email = {{ viewer.email }}  (rows a role gets; omit = all rows)
```

`{{ viewer.<claim> }}` is bound as a parameter, never spliced into SQL;
`email` and `role` are always available, plus the member's own claims.
In the app:

```tsx
import { useViewer } from "@makoai/app-sdk";

const { viewer, loading } = useViewer();
// viewer.role is "team_lead" | "bdr" | … — or null when the app declares no roles.
```

Who may *open* the app is still the app's access setting in Mako; the
`viewers` block only narrows what an admitted viewer sees. An app with a
`viewers` block cannot be shared anonymously.

## In `vite.config.ts`

```ts
import { makoData } from "@makoai/app-sdk/vite";

export default defineConfig({ plugins: [react(), makoData()] });
```

`makoData()` answers `__data/index.json` (the app's `bindings/*.sql`) and
`__data/<name>.parquet` during `vite dev` by streaming each binding's
materialized artifact from the Mako API — a binding that was never
materialized is built on first request, and `POST __data/<name>/refresh`
(the SDK's `refresh()`) rebuilds one on demand. Results are cached under
`node_modules/.mako-data/` for five minutes (`?refresh` bypasses; a stale
copy is served if the API is unreachable). It is `apply: "serve"` only —
production builds never load it.

It also answers `__data/viewer.json` (the developer's own role), and
`MAKO_VIEWER_AS=<email>` — in the environment or the repo's `.env` — previews
the app as that viewer: role, binding list and row filters exactly as Mako
would serve them.

Credentials, in order: `MAKO_API_URL` / `MAKO_API_KEY` in the environment,
then in the repo-root `.env`. The workspace id comes from
`.mako/workspace.json` (or `MAKO_WORKSPACE_ID`). Without a key the app runs
and every binding answers `503` with a hint.

Dependency-free: the DuckDB engine loads from jsDelivr at runtime; the plugin
uses only Node built-ins.
