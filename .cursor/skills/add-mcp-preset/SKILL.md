---
name: add-mcp-preset
description: Add a new MCP server preset (connector) to Mako's MCP client system — server URL, auth model (OAuth DCR, pre-registered app, or API key), scopes, icon, tests, and docs. Use when connecting a new external MCP server (like Slack or Close CRM) or changing how MCP connections authenticate.
---

# Add a New MCP Server Preset

## Overview

Mako acts as an MCP **client**: workspace admins register remote MCP servers (Settings → MCP Servers) and the in-product agent gets their tools with Claude-style per-tool approval. Presets pre-fill the "Add MCP server" form for known providers. All the heavy machinery — CRUD routes, encrypted credentials, OAuth flows, tool discovery/caching, risk tiers, approval grants, chat wiring, settings UI — is **generic**. Adding a provider is usually just one preset object.

This is deliberately separate from `api/src/connectors/**` (data-sync connectors): MCP servers are agent-runtime tooling with a different lifecycle. Do not create a data-sync connector for an MCP integration.

Reference implementations: **Close CRM** (`close`, OAuth via Dynamic Client Registration + API-key fallback + provider scope header) and **Slack** (`slack`, OAuth with a pre-registered confidential app + per-write-scope OAuth scopes).

## Checklist

```
- [ ] Add <NAME>_MCP_PRESET to api/src/mcp/presets.ts and register it in MCP_PRESETS
- [ ] Pick the auth model (see decision table below)
- [ ] Icon: api/src/mcp/icons/<type>.svg, served at /api/mcp/presets/<type>/icon.svg
      (or reuse an existing connector icon at /api/connectors/<type>/icon.svg)
- [ ] Extend api/src/services/mcp-client.service.test.ts (preset shape, scopes)
- [ ] pnpm run openapi:sync   # only if you added/changed routes
- [ ] pnpm --filter api run lint && pnpm --filter app run typecheck && pnpm --filter app run lint
- [ ] tsx api/src/services/mcp-client.service.test.ts
- [ ] Update docs/src/content/docs/mcp-connectors.md
- [ ] Manual test: add the server in Settings → MCP Servers, verify the OAuth
      redirect / credential save, Test connection discovers tools
```

## Key files

| File | Role |
| --- | --- |
| `api/src/mcp/presets.ts` | Preset registry — usually the only file you must change |
| `api/src/mcp/icons/<type>.svg` | Preset icon (auto-copied to dist by the api build) |
| `api/src/services/mcp-client.service.ts` | Discovery, tool building, risk tiers, SSRF guard (generic) |
| `api/src/services/mcp-oauth.service.ts` | OAuth flows: DCR, manual clients, PKCE, refresh (generic) |
| `api/src/routes/mcp.routes.ts` | CRUD + credentials + `/oauth/client` + `/oauth/connect` + presets/icon routes (generic) |
| `api/src/database/workspace-schema.ts` | `mcp_servers`, `mcp_connection_configs`, `mcp_oauth_flows`, `mcp_tool_grants` |
| `app/src/store/mcpStore.ts` / `app/src/components/McpServersSection.tsx` | Settings UI — renders from preset metadata, no per-provider branching |
| `docs/src/content/docs/mcp-connectors.md` | User-facing docs |

## Preset anatomy

```typescript
export const EXAMPLE_MCP_PRESET: McpPreset = {
  type: "example",              // stable key, stored on mcp_servers.connectorType
  label: "Example",
  description: "One sentence: what the agent can do with this connection.",
  icon: "/api/mcp/presets/example/icon.svg",
  url: "https://mcp.example.com/mcp",  // Streamable HTTP endpoint (exact path!)
  urlEditable: false,           // true only for the custom preset
  authType: "oauth",            // recommended default (first UI selection)
  authOptions: ["oauth", "api_key"],
  headerFields: [               // api_key auth: credential headers to collect
    { name: "Example-API-Key", label: "API Key", type: "password", required: true },
  ],
  scopeHeader: {                // only if the provider caps writes via a header
    name: "Example-Scope",
    scopeValues: { read: "r", write_safe: "w", write_destructive: "d" },
  },
  oauth: {                      // only for OAuth presets that deviate from DCR
    clientMode: "manual",       // "dcr" (default) | "manual" (pre-registered app)
    helperText: "Where/how the admin creates the provider app.",
    docsUrl: "https://example.com/apps",
    scopes: {                   // per-write-scope OAuth scopes (least privilege)
      read: ["thing:read"],
      write_safe: ["thing:read", "thing:write"],
      write_destructive: ["thing:read", "thing:write", "thing:admin"],
    },
  },
};
```

Register it: add to `MCP_PRESETS` in the same file. The settings gallery, add-server dialog, credential forms, and chat approval cards all render from this metadata — **never** add `if (connectorType === "example")` branching in UI or shared services.

## Auth model decision table

Probe the provider before writing the preset:

```bash
curl -s https://mcp.example.com/.well-known/oauth-protected-resource   # scopes_supported?
curl -s https://mcp.example.com/.well-known/oauth-authorization-server # registration_endpoint?
```

| Provider behavior | Preset config |
| --- | --- |
| OAuth + `registration_endpoint` (DCR works) | `authType: "oauth"`, no `oauth` block (Close) |
| OAuth, but only pre-registered confidential apps | `oauth: { clientMode: "manual", ... }` (Slack). Prefer also setting `clientEnvVars` so the operator can ship ONE deployment-wide app (`SLACK_MCP_CLIENT_ID`/`SLACK_MCP_CLIENT_SECRET`) and users get Claude-style one-click connect. Without an env client, the admin saves Client ID/Secret via `PUT .../oauth/client`; connect is blocked until then |
| Capability gated by OAuth **scopes** | fill `oauth.scopes` per write scope so read-only connections never hold write tokens |
| Capability gated by a request **header** | `scopeHeader` (Close's `Close-Scope`) |
| Static API key / token headers | `authType: "api_key"` + `headerFields` |

Client resolution order at auth time: workspace-saved client (encrypted `mcp_servers.oauth.clientInformation`) → deployment env client (`clientEnvVars`) → DCR. The MCP SDK's `auth()` only attempts DCR when `clientInformation()` returns nothing. Saving a new manual client wipes previously issued member tokens (they belonged to the old app). The UI hides the client form when the env client is the effective source (`oauthClientSource === "environment"`), and the add-server dialog deep-links straight into the OAuth consent screen whenever a client is already available ("Connect Slack" instead of "Add server").

## What you get for free

- Encrypted credentials at rest (AES-256-CBC), per-user or workspace-shared.
- SSRF-guarded URLs, short-lived per-call MCP clients (no cross-tenant pooling).
- Tool discovery/caching (`cachedTools`), `mcp_<server>_<tool>` prefixing, 64-char provider-safe names.
- Risk tiers from MCP annotations (`readOnlyHint`/`destructiveHint`) + write scope, admin per-tool ceilings, per-user Always allow / Ask / Block grants, chat approval cards.
- OAuth: metadata discovery, PKCE, token refresh, multi-instance-safe flows (state in Mongo).

## Testing

- **Unit**: extend `api/src/services/mcp-client.service.test.ts` — preset registration, scope sets (read ⊂ write_safe ⊂ write_destructive), any new service behavior. Runs in `pnpm --filter api run test` (CI: `api-contract.yml`).
- **Manual (required)**: run `pnpm dev`, log in, Settings → MCP Servers → add the preset. For OAuth verify `POST .../oauth/connect` returns the provider's authorization URL (the redirect landing on the provider's consent page is sufficient evidence without real credentials); for manual-client presets verify connect is blocked until the app is saved. With real credentials: complete consent → auto-discovery caches tools → tools appear in chat with approval cards.
- Local-network MCP servers are SSRF-blocked by default; set `MCP_ALLOW_PRIVATE_URLS=true` in `.env` to test against localhost servers.

## Gotchas

- The endpoint must be the **exact** Streamable HTTP path (`/mcp` suffix usually) — the host alone won't connect. SSE-only servers are not supported.
- Single-instance presets: the gallery hides a preset card once a server with that `connectorType` exists (only `custom` allows multiples).
- `writeScope` lives on the server document; OAuth scopes are chosen at connect time from it. Changing writeScope after members connected does **not** re-consent them — tokens keep the old scopes until reconnect.
- Renaming a server changes the agent-facing tool prefix (`mcp_<slug>_*`) but keeps credentials/grants (keyed by id).
- If you add REST endpoints, run `pnpm run openapi:sync` so `app/src/api/schema.d.ts` knows the new path — the app store uses typed `openapi-fetch` calls.
