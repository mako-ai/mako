# Mako Local Agent

A small daemon bound to `127.0.0.1:41720` that lets the Mako web app
(`app.mako.ai` or local dev) execute queries and browse schemas on databases
that are only reachable from this machine (e.g. `localhost` Postgres).

This is the same architecture as the Postman Desktop Agent and the Figma Font
Helper: the browser cannot open raw TCP connections to databases, so a tiny
native process does it on the web app's behalf.

## How it works

- Reuses the exact same driver layer as the cloud API (`api/src/databases/**`
  and `api/src/services/database-connection.service.ts`), so query execution,
  preview safety checks, schema trees, and autocomplete behave identically.
- The frontend routes any connection whose id starts with `local_` to the
  agent instead of the cloud API (see `app/src/lib/local-agent-client.ts`).
- Browser → agent requests use `fetch(..., { targetAddressSpace: "loopback" })`
  so Chromium's Local Network Access permission flow applies (one-time prompt
  on `app.mako.ai`).

## Security model

- Listens on loopback only — never reachable from the network.
- CORS origin allowlist: `app.mako.ai`, `pr-*.mako.ai`, `localhost:5173`,
  plus `MAKO_AGENT_ALLOWED_ORIGINS` (comma-separated) for extras.
- Connection credentials are AES-256-GCM encrypted at rest under
  `~/.mako/agent/` (key generated on first run, mode 0600) and are **never
  sent to Mako Cloud**. The list endpoint never returns credentials.

## Run

```bash
pnpm agent:dev          # from repo root (watch mode)
pnpm agent:start        # from repo root
MAKO_AGENT_PORT=41720   # optional override
MAKO_AGENT_HOME=~/.mako/agent  # optional override
```

## Build (standalone bundle)

```bash
pnpm --filter @mako/local-agent build   # -> dist/index.js (single file)
node dist/index.js                      # runs with plain node, no deps
```

The bundle inlines the api driver sources and npm dependencies; optional
native add-ons (pg-native, ssh2's crypto binding, mongodb optional deps) are
stubbed — every one has a pure-JS fallback. The desktop app
(`packages/desktop`) ships this bundle as `resources/agent/index.js`.

## HTTP API (mirrors the cloud envelopes)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness/version probe |
| GET | `/connections` | List local connections (no credentials) |
| POST/PUT/DELETE | `/connections[/:id]` | Manage local connections |
| POST | `/test-connection` | Test an unsaved config |
| GET | `/connections/:id/tree` | Schema explorer tree |
| GET | `/connections/:id/autocomplete` | Editor autocomplete schema |
| GET | `/connections/:id/console-template` | Default console snippet |
| GET | `/connections/:id/table-definition` | Table DDL (Postgres family) |
| POST | `/execute` | Execute query (preview mode + safety checks) |
| POST | `/execute/cancel` | Cancel a running query |

## ACP coding agents (Claude Code / Codex)

The agent also hosts an **ACP client bridge**: it spawns a local stdio ACP
adapter (`claude-agent-acp` or `codex-acp`) and exposes sessions to the Mako
web app over loopback HTTP + SSE. Model tokens stay on the user's Claude /
ChatGPT subscription — nothing is proxied through Mako Cloud.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/acp/status` | Provider readiness (adapter found, auth methods) |
| POST | `/acp/authenticate` | Trigger adapter login for a provider |
| GET/POST | `/acp/sessions` | List / create sessions |
| POST | `/acp/sessions/:id/prompt` | Send a user prompt (blocks until turn ends) |
| GET | `/acp/sessions/:id/events` | SSE stream of updates / permissions |
| POST | `/acp/sessions/:id/permissions/:requestId` | Answer a permission prompt |
| POST | `/acp/sessions/:id/cancel` | Cancel the current turn |
| DELETE | `/acp/sessions/:id` | Close a session |
| POST | `/desktop/mcp` | Stateless MCP (`mako-desktop`) for `run_app` / `get_preview_errors` |
| POST | `/desktop/bridge/hello` | Desktop Chat heartbeat for the bridge |
| POST | `/desktop/bridge/claim` | Long-poll for a pending Desktop tool job |
| POST | `/desktop/bridge/jobs/:id/result` | Complete a claimed job |

Overrides for tests/custom installs:

- `MAKO_ACP_AGENT_COMMAND` / `MAKO_ACP_AGENT_ARGS` — spawn this instead of the
  default adapter (`MAKO_ACP_PROVIDER` scopes the override to one provider id)
- `MAKO_ACP_DEFAULT_CWD` — default working directory for new sessions

```bash
pnpm --filter @mako/local-agent test   # mock ACP agent round-trip
```
