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

dbt: `mako dbt run -s <selector>` (also `build` / `test`, `--env <name>`,
`--full-refresh`, `--no-defer`) runs dbt in Mako's runner on this checkout's
`dbt/` folder — uncommitted edits included, nothing committed — and streams the
log; the exit code is dbt's. Any `mako login` can run it (member role or
above): your dbt code runs with the environment's warehouse credentials. It builds your personal
environment (created on first use) unless you pass `--env`; production is only
built from `main` by a job.

Workflows: `mako workflow run <name> --input '{"limit":3}'` test-runs
`workflows/<name>/workflow.ts` from your checkout, uncommitted edits included,
in one Node process with no Hatchet engine: its steps run once each, parents
first, each given the input and its ancestors' outputs. `../lib/mako` is the
file the workers use, so every Mako call is real and carries your login (or
`MAKO_API_KEY`). Each log line prints as it is written; the whole run (each
step's status, timings, output, error and logs) is kept in
`.mako/runs/<name>.json`, and `--task <step>` reruns one step from that file's
saved outputs. Child runs (`ctx.runChild`, `runNoWaitChild`,
`bulkRunChildren`, with `childIndex()`, `childKey()` and the run ids) run in
the same process; each child's steps and logs are kept under the step that
started it, which ends once all its children have. Other Hatchet features
(durable tasks, concurrency, …) throw "not supported in test runs; run it on
the workers".

Syncs: `mako sync ls` lists every sync with its triggers and state; `mako sync
status <name|id>` shows per-entity mode, backlog, failures and the last runs;
`mako sync backfill <name|id> [--entity a,b]` re-reads now; `mako sync set
<name|id> [--poll <cron|off>] [--webhook on|off] [--resync <cron|off>] [--tz
<zone>]` changes what starts a sync. A name can be any unique short name.
The two writes need an owner/admin and the warehouse-write grant; `--json` prints
the server's answer.

Also: `mako whoami` (says when the token expired, and refreshes it when it
can), `mako logout`, `--api-url <host>` for self-hosted Mako
(or `MAKO_API_URL` in the repo's `.env`). An API key in `.env`
(`MAKO_API_KEY`) is used instead of the login when present — that is the path
for CI.

Node 22+. Besides `@makoai/app-sdk`, the packages workflow code may import
(`ai`, `zod`, `@ai-sdk/gateway`, `@ai-sdk/mcp`) and `tsx`, for `mako workflow run`.
