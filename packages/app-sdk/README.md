# @mako/app-sdk

The runtime SDK for [Mako](https://mako.ai) data apps — React hooks over an
app's data bindings, plus a Vite plugin that serves those bindings during a
local `vite dev`.

Every Mako workspace repository carries this package at `packages/app-sdk`;
apps depend on it with `"@mako/app-sdk": "file:../../packages/app-sdk"`. Mako
keeps the vendored copy current — do not edit it in a workspace repo.

## In the app

```tsx
import { useQuery, useDuckDB, useSearchParams, useTheme } from "@mako/app-sdk";

// Rows of bindings/<name>.sql, materialized to parquet by Mako.
const { data, loading, error } = useQuery("latest_sales");

// Analytical SQL over every binding (DuckDB-WASM in the browser; table
// names are binding names).
const totals = useDuckDB("select country, sum(revenue) r from latest_sales group by 1");
```

`useLocation` / `useSearchParams` / `navigate` keep filter state in the URL;
`useTheme` follows the OS preference. Theme tokens (`--background`,
`--chart-1`, …) match the ones the scaffold's `styles.css` declares.

Data arrives from `__data/<name>.parquet`, relative to the page — the same
path in Mako's sandbox, in a published app, and on a laptop.

## In `vite.config.ts`

```ts
import { makoData } from "@mako/app-sdk/vite";

export default defineConfig({ plugins: [react(), makoData()] });
```

`makoData()` answers `__data/index.json` (the app's `bindings/*.sql`) and
`__data/<name>.parquet` during `vite dev` by streaming each binding's
materialized artifact from the Mako API — a binding that was never
materialized is built on first request. Results are cached under
`node_modules/.mako-data/` for five minutes (`?refresh` bypasses; a stale
copy is served if the API is unreachable). It is `apply: "serve"` only —
production builds never load it.

Credentials, in order: `MAKO_API_URL` / `MAKO_API_KEY` in the environment,
then in the repo-root `.env`. The workspace id comes from
`.mako/workspace.json` (or `MAKO_WORKSPACE_ID`). Without a key the app runs
and every binding answers `503` with a hint.

Dependency-free: the DuckDB engine loads from jsDelivr at runtime; the plugin
uses only Node built-ins.
