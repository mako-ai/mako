# @mako/cli

Mako from your terminal. Two commands matter:

```bash
npx @mako/cli login      # sign in once (browser, OAuth) — kept in ~/.mako/credentials.json
npx @mako/cli dev <app>  # run apps/<app> locally with real workspace data
```

Run inside a clone of your Mako workspace repository. `login` is the same
read-only OAuth sign-in every MCP client does against Mako (PKCE, loopback
redirect, no key to paste); the credential is tied to the workspace of the
checkout you ran it in and refreshed automatically. `dev` installs the app if
needed and starts its Vite dev server; the app's `makoData()` plugin
(`@mako/app-sdk/vite`) streams each binding's parquet from Mako using that
login.

Also: `mako whoami`, `mako logout`, `--api-url <host>` for self-hosted Mako
(or `MAKO_API_URL` in the repo's `.env`). An API key in `.env`
(`MAKO_API_KEY`) is used instead of the login when present — that is the path
for CI.

Node 20+. No dependencies beyond `@mako/app-sdk`.
