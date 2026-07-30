---
title: MCP Server (Use Mako from Claude Code)
description: Connect Claude Code, Cursor, or Codex to your Mako workspace over MCP — explore data, run read-only queries, and build Mako apps headlessly with your own AI agent and your own AI subscription.
---

Mako is itself an [MCP](https://modelcontextprotocol.io) **server**: point Claude Code, Cursor, Codex, or any MCP client at your workspace and your agent can explore your databases, validate queries, and build full Mako apps — using **your** AI subscription's tokens, not Mako's in-product agent.

Where [MCP Connectors](/mcp-connectors/) let Mako's agent use *other* systems' tools, the MCP server is the reverse: it lets *your* agent use Mako.

Want Claude Code or Codex **inside** the Mako UI instead? See [Coding Agents (ACP)](/coding-agents-acp/).

**Data access over MCP is read-only by design.** Agents can never run raw SQL writes against your databases through Mako — there is no scope or setting that enables DML/DDL. The one deliberate, opt-in exception is governed dbt execution: an API key explicitly created with the `warehouse:write` scope may trigger dbt runs (which build model definitions that live in your project, not ad-hoc statements). OAuth sign-in grants remain fully read-only.

## Connect by signing in (no API key)

Give your client one URL — `https://your-mako-host/api/mcp` — and it discovers the OAuth sign-in flow itself. Your browser opens once: sign in with your Mako account, pick a workspace, approve **read-only** access. Done.

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

Under the hood this is standard OAuth 2.1 for MCP: RFC 9728 protected-resource discovery, dynamic client registration, PKCE, and rotating refresh tokens. Grants are always scoped to the read-only MCP set — an OAuth token can never do more than a fresh MCP API key.

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

Try: *"Using the mako tools, explore my data and build a dashboard app showing revenue by month, then give me a preview link."*

The server ships usage instructions with the handshake, so agents discover this workflow on their own:

1. **Discover** — `list_connections`, `sql_list_tables`, `sql_inspect_table` (schemas + sample rows), plus MongoDB discovery/inspection. `search_consoles` / `search_dashboards` find existing workspace work. Skills: `list_skills` (index), `get_relevant_skills` (ranked bodies for your task — same retrieval as the in-product agent), then `load_skill` / `read_skill_resource` as needed.
2. **Validate queries** — `sql_execute_query` (read-only, short exploration timeout). Slow warehouse? `create_console` → `run_console` → `check_query_status` for long-running queries.
3. **Build apps** — `create_app`, `app_write_file` / `app_edit_file`, `app_create_data_binding` (bind the validated query), version history and restore.
4. **Verify visually** — `run_app` renders the draft server-side and returns status, errors, filtered console output, and a screenshot (same tool name the in-product and Desktop agents use; `render_app` remains as a deprecated alias). `create_preview_token` mints a short-lived, login-free preview URL to share or open yourself.
5. **Publish** — `app_save_version`.
6. **dbt** — `read_dbt_project_tree` and the dbt file tools author models headlessly; `dbt_parse` / `dbt_compile_model` / `dbt_show` validate them asynchronously (start a run, poll `dbt_get_run`). Warehouse-mutating runs (`dbt_run_model`, `dbt_run_job`, plus `dbt_cancel_run`) only appear for API keys carrying the opt-in `warehouse:write` scope — see the security model below.
7. **dbt Git** — `dbt_git_status` / `dbt_list_branches` / `dbt_compare_branches` / `dbt_list_pull_requests` are always available, so a headless agent can see that its edits are uncommitted working-tree drafts instead of leaving them stranded on the tracked branch. Git mutations (`dbt_commit_to_branch`, `dbt_commit_and_push`, branch create/switch/delete, PR open/update/merge/close, `dbt_sync_from_repo`) require the opt-in `git:write` scope.

Optional helpers: `web_search` / `fetch_url` for public docs (annotated `openWorldHint`).

The MCP tool surface is a curated subset of the in-product agent tools. Classification lives in `api/src/mcp/bridge-policy.ts` — every agent tool is either bridged, MCP-only, or explicitly excluded (client-only UI, security, in-product UX, or deferred). Adding an agent tool without classifying it fails the MCP inventory test.

Read-only tools are annotated per the MCP spec (`readOnlyHint`), so well-behaved clients run the whole discovery/query loop without approval prompts. If you keep a Mako tab open on the app being edited, it live-reloads on every agent change.

## Security model

- **SQL is read-only, no exceptions.** SQL must be a single `SELECT`/`WITH` statement; enforcement also happens *inside the database* where supported (PostgreSQL/Cloud SQL/Redshift read-only transactions, MySQL `START TRANSACTION READ ONLY`, ClickHouse `readonly=2`). Arbitrary MongoDB JavaScript is not exposed at all — Mongo is discovery/inspection only. There is no scope that unlocks raw DML/DDL over MCP.
- **Warehouse mutations are opt-in and governed.** The only write path to a warehouse over MCP is dbt execution (`dbt_run_model` / `dbt_run_job`), which builds committed, reviewable model definitions — never ad-hoc SQL. These tools are hidden unless a workspace admin creates an API key with the `warehouse:write` scope (never granted by default; OAuth grants stay pinned to the read-only set).
- **Git mutations are opt-in the same way.** dbt repository writes (commits, branches, pull requests) require the `git:write` scope; without it the agent can read Git state but every mutation tool stays hidden. Repository-side protections (protected branches, PR reviews) apply on top.
- **Non-SQL engines fail closed** (MongoDB shell code, Cloudflare KV): the lexical analyzer cannot validate them, so read-only execution refuses them outright. SQL engines without a session-level read-only mode (BigQuery, MSSQL, Cloudflare D1) rely on the validated single-`SELECT`/`WITH` statement instead.
- **MCP credentials are MCP-only.** OAuth access tokens and scoped keys are rejected on every other API endpoint, so an MCP credential can never be replayed against REST mutation routes.
- **OAuth grants are least-privilege by construction**: public clients with mandatory PKCE, single-use authorization codes, rotating refresh tokens, hashed at rest, always scoped to the read-only MCP set, and bound to the one workspace chosen at consent.
- **Key management requires a browser session** — API keys cannot create or delete other API keys.
- App data bindings and materializations are always read-only, and preview tokens are signed, single-app, and short-lived (60 s – 30 min).

## Headless & CI usage

Non-interactive runs (`claude -p …`) don't show permission dialogs — allowlist the server explicitly:

```bash
claude -p "explore my mako data and summarize revenue" --allowedTools "mcp__mako"
```

To keep agent context lean, agents can pass `includeScreenshot: false` to `run_app` while iterating (status + errors only, ~100 bytes) and fetch one screenshot at the end.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Client never opens the sign-in browser | The client predates MCP OAuth support — update it, or fall back to an API key header. |
| `401 Invalid or expired MCP access token` | The OAuth grant was revoked or fully expired — reconnect the server in your client (it re-runs the sign-in). |
| `403 … created before MCP scopes existed` | Legacy key. Sign in via OAuth or create a new key under Workspace Settings → API Keys. |
| `403 … does not include the mcp scope` | Key was created without the `mcp` scope — create a new key. |
| `Mako MCP access is read-only: the query was rejected…` | The agent attempted a write (`UPDATE`/`INSERT`/DDL). Expected — run writes with your own database tooling. |
| `Read-only execution is not supported for mongodb…` (or `cloudflare-kv`) | Non-SQL engine — the SQL analyzer can't validate it, so it fails closed. For MongoDB, use the discovery/inspection tools instead; arbitrary Mongo execution is not available over MCP. |
| `Server-side rendering is not configured` | The deployment has no `RENDER_APP_BROWSER_PATH` (headless Chromium). Agents fall back to `create_preview_token` — open the URL in any browser. |
| `Preview base URL … is unreachable` | `CLIENT_URL`/`PUBLIC_URL` on the API server is wrong — it must point at the Mako frontend. |
| Client shows the server but tools error with 401 | The OAuth token or `Authorization: Bearer` key is missing/revoked — reconnect or rotate. |
