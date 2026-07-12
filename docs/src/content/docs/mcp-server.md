---
title: MCP Server (Use Mako from Claude Code)
description: Connect Claude Code, Cursor, or Codex to your Mako workspace over MCP — explore data, run read-only queries, and build Mako apps headlessly with your own AI agent and your own AI subscription.
---

Mako is itself an [MCP](https://modelcontextprotocol.io) **server**: point Claude Code, Cursor, Codex, or any MCP client at your workspace and your agent can explore your databases, validate queries, and build full Mako apps — using **your** AI subscription's tokens, not Mako's in-product agent.

Where [MCP Connectors](/mcp-connectors/) let Mako's agent use *other* systems' tools, the MCP server is the reverse: it lets *your* agent use Mako.

**Data access over MCP is read-only by design.** Agents can never write to your databases through Mako — there is no scope or setting that enables it.

## Setup in two steps

### 1. Create an API key

Go to **Workspace Settings → API Keys → Create API Key**. New keys automatically carry the `mcp` and `query:read` scopes — nothing to configure. The key is shown **once**, together with ready-to-paste setup snippets for each client.

:::note[Older keys]
Keys created before scopes existed keep working for the REST API but cannot connect MCP clients (they'd carry more privilege than MCP allows). They're marked **Legacy** in the key list — create a new key for MCP.
:::

### 2. Connect your client

Replace `https://your-mako-host` with your Mako URL and `revops_...` with your key. The key-created dialog shows these exact snippets pre-filled.

**Claude Code**

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

**Cursor** — add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "mako": {
      "url": "https://your-mako-host/api/mcp",
      "headers": { "Authorization": "Bearer revops_..." }
    }
  }
}
```

**Codex** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.mako]
url = "https://your-mako-host/api/mcp"
bearer_token_env_var = "MAKO_API_KEY"
```

```bash
export MAKO_API_KEY="revops_..."
```

**Any other MCP client** — Streamable HTTP (JSON mode, stateless), endpoint `POST /api/mcp`, `Authorization: Bearer` header. No OAuth, no sessions.

Verify the connection (Claude Code): `claude mcp list` should show `mako … ✓ Connected`.

## What your agent can do

Try: *"Using the mako tools, explore my data and build a dashboard app showing revenue by month, then give me a preview link."*

The server ships usage instructions with the handshake, so agents discover this workflow on their own:

1. **Discover** — `list_connections`, `sql_list_tables`, `sql_inspect_table` (schemas + sample rows), plus MongoDB discovery/inspection.
2. **Validate queries** — `sql_execute_query` (read-only, short exploration timeout). Slow warehouse? `create_console` → `run_console` → `check_query_status` for long-running queries.
3. **Build apps** — `create_app`, `app_write_file` / `app_edit_file`, `app_create_data_binding` (bind the validated query), version history and restore.
4. **Verify visually** — `render_app` renders the draft server-side and returns status, errors, filtered console output, and a screenshot. `create_preview_token` mints a short-lived, login-free preview URL to share or open yourself.
5. **Publish** — `app_save_version`.

Read-only tools are annotated per the MCP spec (`readOnlyHint`), so well-behaved clients run the whole discovery/query loop without approval prompts. If you keep a Mako tab open on the app being edited, it live-reloads on every agent change.

## Security model

- **Read-only, no exceptions.** SQL must be a single `SELECT`/`WITH` statement; enforcement also happens *inside the database* where supported (PostgreSQL/Cloud SQL/Redshift read-only transactions, MySQL `START TRANSACTION READ ONLY`, ClickHouse `readonly=2`). Arbitrary MongoDB JavaScript is not exposed at all — Mongo is discovery/inspection only.
- **Engines without a reliable per-query read-only mode fail closed** (BigQuery, MSSQL, Cloudflare D1/KV): queries over MCP are refused unless the connection itself uses read-restricted database credentials.
- **Scoped keys are MCP-only.** A key with scopes is rejected on every other API endpoint, so an MCP key can never be replayed against REST mutation routes.
- **Key management requires a browser session** — API keys cannot create or delete other API keys.
- App data bindings and materializations are always read-only, and preview tokens are signed, single-app, and short-lived (60 s – 30 min).

## Headless & CI usage

Non-interactive runs (`claude -p …`) don't show permission dialogs — allowlist the server explicitly:

```bash
claude -p "explore my mako data and summarize revenue" --allowedTools "mcp__mako"
```

To keep agent context lean, agents can pass `includeScreenshot: false` to `render_app` while iterating (status + errors only, ~100 bytes) and fetch one screenshot at the end.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `403 … created before MCP scopes existed` | Legacy key. Create a new key under Workspace Settings → API Keys. |
| `403 … does not include the mcp scope` | Key was created without the `mcp` scope — create a new key. |
| `Mako MCP access is read-only: the query was rejected…` | The agent attempted a write (`UPDATE`/`INSERT`/DDL). Expected — run writes with your own database tooling. |
| `Read-only execution is not supported for bigquery…` | Fail-closed engine. Connect it with read-restricted database credentials. |
| `Server-side rendering is not configured` | The deployment has no `RENDER_APP_BROWSER_PATH` (headless Chromium). Agents fall back to `create_preview_token` — open the URL in any browser. |
| `Preview base URL … is unreachable` | `CLIENT_URL`/`PUBLIC_URL` on the API server is wrong — it must point at the Mako frontend. |
| Client shows the server but tools error with 401 | The `Authorization: Bearer` header is missing or the key was revoked. |
