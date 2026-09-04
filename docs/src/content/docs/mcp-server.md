---
title: MCP Server (Use Mako from Claude Code)
description: Connect Claude Code, Cursor, Codex, or ChatGPT to your Mako workspace over MCP — explore data, run read-only queries, and build Mako apps headlessly with your own AI agent and your own AI subscription.
---

Mako is itself an [MCP](https://modelcontextprotocol.io) **server**: point Claude Code, Cursor, Codex, ChatGPT, or any MCP client at your workspace and your agent can explore your databases, validate queries, and build full Mako apps — using **your** AI subscription's tokens, not Mako's in-product agent.

Where [MCP Connectors](/mcp-connectors/) let Mako's agent use _other_ systems' tools, the MCP server is the reverse: it lets _your_ agent use Mako.

Want Claude Code or Codex **inside** the Mako UI instead? See [Coding Agents (ACP)](/coding-agents-acp/).

**Data access over MCP is read-only by default, everywhere.** A client may request `warehouse:write` during OAuth sign-in to run governed dbt models and jobs; the consent screen presents a separate, unchecked approval for that permission and warns that it can modify warehouse relations. Raw SQL writes remain a narrower, double-gated API-key opt-in requiring **both** a key with `query:write` and a connection explicitly marked _Allow agent writes_. Neither write permission is granted by default.

## Connect by signing in (no API key)

Give your client one URL — `https://your-mako-host/api/mcp` — and it discovers the OAuth sign-in flow itself. Your browser opens once: sign in with your Mako account, pick a workspace, and approve the requested access. Normal connections are read-only against warehouse data; clients requesting dbt execution show a separate, unchecked `warehouse:write` approval.

Inside the app, everything lives at **Settings → Connect Agents**: per-client setup with one-click **Add to Claude** / **Add to Cursor** buttons, plus a **Connected agents** list showing every agent with access (who connected it, when it was last used) with one-click disconnect.

**Claude Code**

```bash
claude mcp add --transport http mako https://your-mako-host/api/mcp
```

Then type `/mcp` inside a session to trigger the sign-in.

**Claude (web / desktop)** — **Settings → Connect Agents** has a one-click **Add to Claude** button that opens claude.ai with the connector prefilled (you review and confirm, then click **Connect** and sign in). Manually: **Settings → Connectors → Add custom connector**, name it `mako`, paste the URL. The install-link format, if you want to share it, is:

```text
https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=mako&connectorUrl=<percent-encoded MCP URL>
```

**ChatGPT** — Mako implements ChatGPT's connector contract (top-level `search` / `fetch` tools), so it can be added as a ChatGPT connector and used in regular chat and deep research with citations back into your workspace. In ChatGPT (Plus/Pro/Business/Enterprise): **Settings → Connectors → Create** — if you don't see the option, enable **Developer mode** under **Settings → Connectors → Advanced settings** first. Name it `mako`, paste `https://your-mako-host/api/mcp`, choose **OAuth** authentication, and sign in when prompted (same consent flow: pick a workspace, read-only). In chat and deep research ChatGPT uses `search` / `fetch` to find and cite saved consoles, dashboards, apps, and skills; with developer mode on, the full Mako tool surface (SQL exploration, the apps loop, dbt) is available too.

**Cursor** — add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global); Cursor prompts you to sign in on first use. **Settings → Connect Agents** also has a one-click **Add to Cursor** button.

```json
{
  "mcpServers": {
    "mako": { "url": "https://your-mako-host/api/mcp" }
  }
}
```

**Codex** — add to `~/.codex/config.toml`; Codex opens your browser to sign in on first use:

```toml
[mcp_servers.mako]
url = "https://your-mako-host/api/mcp"
```

Verify the connection (Claude Code): `claude mcp list` should show `mako … ✓ Connected`.

Under the hood this is standard OAuth 2.1 for MCP: RFC 9728 protected-resource discovery, dynamic client registration, PKCE, and rotating refresh tokens. Grants default to `mcp query:read`; `warehouse:write` is the only OAuth write scope and must be requested and approved explicitly.

## Headless / CI: API keys

Where a browser sign-in isn't possible, use a workspace API key instead. Go to **Workspace Settings → API Keys → Create API Key** — new keys carry the `mcp` and `query:read` scopes and the key-created dialog shows ready-to-paste per-client snippets with the key filled in:

```bash
claude mcp add --transport http mako https://your-mako-host/api/mcp \
  --header "Authorization: Bearer revops_..."
```

Or team-shared via `.mcp.json` in your repo (key kept in an env var):

```json
{
  "mcpServers": {
    "mako": {
      "type": "http",
      "url": "https://your-mako-host/api/mcp",
      "headers": { "Authorization": "Bearer ${MAKO_API_KEY}" }
    }
  }
}
```

:::note[Older keys]
Keys created before scopes existed keep working for the REST API but cannot connect MCP clients (they'd carry more privilege than MCP allows). They're marked **Legacy** in the key list — sign in via OAuth or create a new key.
:::

## What your agent can do

Try: _"Using the mako tools, explore my data and build a dashboard app showing revenue by month, then give me a preview link."_

The server ships usage instructions with the handshake, so agents discover this workflow on their own:

1. **Discover** — `list_connections` lists every configured credential, of two kinds: `database` connections (BigQuery, Postgres, MongoDB, …) that `list_databases` / `list_tables` / `inspect_table` describe (schemas + sample rows; they dispatch on engine) and SQL queries, and `source` connections (a Stripe key, a Vercel key, …) that flows read from and `probe_connection` reads live. Every row names its `kind` and its `connector` — the code it was configured with. `search_consoles` / `search_dashboards` find existing workspace work. Skills: `list_skills` (index), `get_relevant_skills` (ranked bodies for your task — same retrieval as the in-product agent), then `load_skill` / `read_skill_resource` as needed.
2. **Validate queries** — `sql_execute_query` (read-only, short exploration timeout). Slow warehouse? `create_console` → `run_console` → `check_query_status` for long-running queries.
3. **Build apps** — `app_list_apps` / `app_create_app` to discover or scaffold (`apps/<slug>/`, a real Vite project), then `app_write_file` / `app_edit_file` / `app_bash` for ordinary file and shell work, and `app_materialize` to build a binding's parquet artifact (bindings are `bindings/<name>.sql` files with the validated query).
4. **Verify with real eyes** — `app_open_app` starts the dev server (and focuses the app in the user's UI), `app_dev_log` returns the boot/vite log plus browser-console output, and `app_browse` drives a headless browser against the running dev server: click, navigate, and screenshot what a user would actually see.
5. **Publish** — `app_commit` (durability, `git push` semantics) and `app_merge_to_main` (`main` is what publishes buildable state).
6. **Dashboards** — `search_dashboards` finds existing dashboards and `update_data_source_query` edits them in place: rewrite a source query (replace/patch/append), toggle live vs. materialized (`parquet`), and set the dashboard-level cron refresh schedule (`materializationSchedule`). Server writes bump the dashboard version, push a `dashboard.updated` realtime poke to open tabs, and queue a Parquet rebuild when the definition changes (schedule-only changes don't). Widget/layout editing stays in-product — those tools are client-only.
7. **dbt** — `dbt_create_project` and `read_dbt_project_tree` manage projects; `create_dbt_file` / `read_dbt_file` / `edit_dbt_file` / `modify_dbt_file` / `delete_dbt_file` provide model and config CRUD; `dbt_parse` / `dbt_compile_model` / `dbt_show` validate asynchronously (start a run, poll `dbt_get_run`); and `dbt_create_job` / `dbt_update_job` / `dbt_delete_job` manage jobs and schedules. Project and job mutations require an admin/owner role; file mutations and runs require at least member. Warehouse-mutating operations (`dbt_ensure_dev_environment`, `dbt_run_model`, `dbt_run_job`, and `dbt_cancel_run`) additionally require the explicit `warehouse:write` OAuth/API-key scope.
8. **Connectors and connections** — a _connector_ is code (`stripe`, `ws:vercel-ai-gateway`); a _connection_ is a credential configured with one. `list_connectors` is the catalog of code available to the workspace, with the connections configured with each; `inspect_connector` describes a type (entities, incremental support, config field names — never values); `inspect_connection` describes one configured connection of either kind; and `probe_connection` runs a source connection _live_ against the platform behind it: the credential check plus one bounded page of an entity (default 20 records, max 200; `fields` to keep only some columns, `since` where the connector supports it), written nowhere. That is how an agent verifies a freshly configured key, sees the real shape of an entity before authoring a `flows/<slug>.yml`, or answers an exploratory question from a platform that is not in the warehouse yet. Credential values never appear in a result; the probe scrubs them even out of vendor error messages. `probe_connection` reads external data, so like `sql_execute_query` it needs the `query:read` scope.

If an expected tool is absent, call `get_mcp_capabilities`. It reports the connection's effective scopes and grants, every available tool, and hidden grant-gated tools with the exact scope needed to enable them.

Optional helpers: `web_search` / `fetch_url` for public docs (annotated `openWorldHint`).

For ChatGPT compatibility the server also exposes a top-level `search` / `fetch` pair — workspace-wide search over saved consoles, dashboards, apps, and skills, plus document retrieval by id (`console:…`, `dashboard:…`, `app:…`, `skill:…`). ChatGPT requires exactly these two tools to accept a connector for chat and deep research; other clients can use them as a quick workspace search.

The MCP tool surface is a curated subset of the in-product agent tools. Classification lives in `api/src/mcp/bridge-policy.ts` — every agent tool is either bridged, MCP-only, or explicitly excluded (client-only UI, security, in-product UX, or deferred). Adding an agent tool without classifying it fails the MCP inventory test.

Read-only tools are annotated per the MCP spec (`readOnlyHint`), so well-behaved clients run the whole discovery/query loop without approval prompts. If you keep a Mako tab open on the app being edited, it live-reloads on every agent change.

## Security model

- **SQL is read-only unless double-gated otherwise.** By default SQL must be a single `SELECT`/`WITH` statement; enforcement also happens _inside the database_ where supported (PostgreSQL/Cloud SQL/Redshift read-only transactions, MySQL `START TRANSACTION READ ONLY`, ClickHouse `readonly=2`). Arbitrary MongoDB JavaScript is not exposed at all — Mongo is discovery/inspection only. SQL writes require an API key with the `query:write` scope **and** a connection a workspace admin marked `allowAgentWrites` — the key scope alone stays read-only against every other connection, the connection flag alone does nothing for read-scoped keys, and console runs, app data bindings, and materializations stay read-only regardless.
- **Warehouse mutations are opt-in and governed.** The only write path to a warehouse over MCP is dbt execution, which builds committed, reviewable model definitions — never ad-hoc SQL. These tools are hidden unless the OAuth client requests `warehouse:write` and the user checks its separate consent option, or a workspace admin creates an API key with that scope. It is never granted by default.
- **Non-SQL engines fail closed** (MongoDB shell code, Cloudflare KV): the lexical analyzer cannot validate them, so read-only execution refuses them outright. SQL engines without a session-level read-only mode (BigQuery, MSSQL, Cloudflare D1) rely on the validated single-`SELECT`/`WITH` statement instead.
- **MCP credentials are MCP-only.** OAuth access tokens and scoped keys are rejected on every other API endpoint, so an MCP credential can never be replayed against REST mutation routes.
- **OAuth grants are least-privilege by construction**: public clients use mandatory PKCE, single-use authorization codes, rotating refresh tokens hashed at rest, and a binding to the one workspace chosen at consent. Grants default to read-only warehouse access; `warehouse:write` requires an explicit request and a conspicuous consent warning.
- **Key management requires a browser session** — API keys cannot create or delete other API keys.
- App data bindings and materializations are always read-only.
- **Dashboard writes edit definitions, never data.** `update_data_source_query` changes the dashboard document (query text, live/parquet toggle, refresh schedule) under the same query-access check as app bindings — an agent can point a source at a different saved query, but the query itself still executes read-only. Widget and layout mutations stay client-only and are not bridged.

## Headless & CI usage

Non-interactive runs (`claude -p …`) don't show permission dialogs — allowlist the server explicitly:

```bash
claude -p "explore my mako data and summarize revenue" --allowedTools "mcp__mako"
```

To keep agent context lean, agents can pass `includeScreenshot: false` to `app_browse` while iterating and fetch one screenshot at the end.

## Working from a local checkout

Every workspace repo carries a small template Mako keeps current: `AGENTS.md`
(imported by `CLAUDE.md`) telling your agent what the repo is and how to work
in it, `.mcp.json` wiring the `mako` MCP server, `.envrc` for direnv, and the
vendored `@makoai/app-sdk`. The whole setup, no key to paste:

```bash
git clone <your workspace repo> && cd <repo>
claude                 # the mako MCP server prompts a browser sign-in
npx @makoai/cli login    # same sign-in for the app dev server, kept in ~/.mako/credentials.json
npx @makoai/cli dev <app>   # or: cd apps/<app> && npm install && npm run dev
```

The app renders with **real data**: the scaffold's `vite.config.ts` includes
`makoData()` from `@makoai/app-sdk/vite`, which serves `__data/<binding>.parquet`
by streaming the binding's materialized artifact from your Mako host with that
login (a binding that was never materialized is built on first request;
results are cached for five minutes under `node_modules/.mako-data/`,
`?refresh` bypasses). This is the one place MCP credentials — OAuth tokens and
scoped keys alike — are accepted outside `/api/mcp`: with `query:read` they may
call the three read-only binding routes (`GET …/bindings`,
`GET …/bindings/<name>/artifact`, `POST …/bindings/<name>/materialize`) and
nothing else.

Headless / CI: put a workspace API key in the repo's gitignored `.env`
(`MAKO_API_KEY=revops_…`, scopes `mcp` + `query:read`) and register the server
with the header (`claude mcp add --transport http mako
$MAKO_API_URL/api/mcp --header "Authorization: Bearer $MAKO_API_KEY"`); the
dev server picks the key up automatically. Self-hosted: `MAKO_API_URL` in
`.env`, exported (`.envrc` does it for direnv users) — `.mcp.json` expands
`${MAKO_API_URL:-https://app.mako.ai}`.

Two things `AGENTS.md` tells the agent that are easy to get wrong:

- Edit files with your own tools. The `app_*` file tools (`app_write_file`,
  `app_bash`, `app_commit`, …) act on Mako's _sandbox_ copy of the repo, not
  on your checkout.
- Push to deploy. `main` is production; a commit on `main` — from your
  terminal, a merged PR, or the Publish button — is what builds and serves the
  app.

The hosted server is described for MCP directories in `server.json` at the
repository root (`ai.mako/mako`, streamable HTTP at `https://app.mako.ai/api/mcp`).

## Apps toolset

The app is a folder in the workspace's git monorepo and the agent works like
a developer in a checkout:

1. `app_list_apps` / `app_create_app` — discover or scaffold (`apps/<slug>/`, a real Vite project).
2. `app_read_file` / `app_write_file` / `app_edit_file` / `app_glob` / `app_grep` — ordinary file work; `app_bash` runs any shell command in the app's sandbox.
3. `app_materialize` — build a binding's parquet artifact (bindings are `bindings/<name>.sql` files with front matter, not documents).
4. **Verify with real eyes** — `app_open_app` starts the dev server (and focuses the app in the user's UI), `app_dev_log` returns the boot/vite log plus browser-console output, and `app_browse` drives a headless browser against the running dev server: click, navigate, and screenshot what a user would actually see.
5. `app_status` / `app_commit` / `app_merge_to_main` — commits are durability (`git push` semantics); merging to `main` is what publishes buildable state.

Use `app_list_apps` first: if the workspace has v2 apps (or you're asked to
create one), stay in the `app_*` loop and skip the v1 tools above; the two
systems must not be mixed on one app.

## Troubleshooting

| Symptom                                                                  | Cause / fix                                                                                                                                                                            |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client never opens the sign-in browser                                   | The client predates MCP OAuth support — update it, or fall back to an API key header.                                                                                                  |
| `401 Invalid or expired MCP access token`                                | The OAuth grant was revoked or fully expired — reconnect the server in your client (it re-runs the sign-in).                                                                           |
| `403 … created before MCP scopes existed`                                | Legacy key. Sign in via OAuth or create a new key under Workspace Settings → API Keys.                                                                                                 |
| `403 … does not include the mcp scope`                                   | Key was created without the `mcp` scope — create a new key.                                                                                                                            |
| `Mako MCP access is read-only: the query was rejected…`                  | The agent attempted a write (`UPDATE`/`INSERT`/DDL). Expected — run writes with your own database tooling.                                                                             |
| `Read-only execution is not supported for mongodb…` (or `cloudflare-kv`) | Non-SQL engine — the SQL analyzer can't validate it, so it fails closed. For MongoDB, use the discovery/inspection tools instead; arbitrary Mongo execution is not available over MCP. |
| Client shows the server but tools error with 401                         | The OAuth token or `Authorization: Bearer` key is missing/revoked — reconnect or rotate.                                                                                               |
| ChatGPT rejects the connector ("does not implement our spec")            | The deployment predates the `search` / `fetch` connector tools — update Mako. Custom MCP connectors also require Developer mode to be enabled under ChatGPT's connector settings.      |
