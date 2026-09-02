# @makoai/cli

Mako from your terminal. Two commands matter:

```bash
npx @makoai/cli login      # sign in once (browser, OAuth) — kept in ~/.mako/credentials.json
npx @makoai/cli dev <app>  # run apps/<app> locally with real workspace data
```

Run inside a clone of your Mako workspace repository. `login` is the same
read-only OAuth sign-in every MCP client does against Mako (PKCE, loopback
redirect, no key to paste); the credential is tied to the workspace of the
checkout you ran it in and refreshed automatically. `dev` installs the app if
needed and starts its Vite dev server; the app's `makoData()` plugin
(`@makoai/app-sdk/vite`) streams each binding's parquet from Mako using that
login.

Connectors: `mako connector test connectors/<slug>` runs a connector's code
from your checkout against its own contract (offline checks without
`--config`, the full check/discover/read with one). `mako connector probe
<id|name> [--entity <name>] [--limit <n>]` runs a connector Mako has
*configured*, with the credential Mako holds, live against its platform: the
credential check plus one bounded page of an entity, written nowhere — the
way to see that a new key works, or what a platform's data looks like before
a flow lands it in the warehouse.

Also: `mako whoami`, `mako logout`, `--api-url <host>` for self-hosted Mako
(or `MAKO_API_URL` in the repo's `.env`). An API key in `.env`
(`MAKO_API_KEY`) is used instead of the login when present — that is the path
for CI.

Node 20+. No dependencies beyond `@makoai/app-sdk`.
