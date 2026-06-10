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
