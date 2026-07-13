---
title: MCP Connectors
description: Connect external MCP servers (like Close CRM) so the AI agent can act in other tools — search, create, and update records — with Claude-style per-tool approval.
---

MCP connectors let Mako's AI agent use tools from external [Model Context Protocol](https://modelcontextprotocol.io) servers. Where [SaaS Sync (Connectors)](/connectors/) pulls data *into* your warehouse for querying, MCP connectors let the agent *act* in other systems — search leads, create contacts, log activities, and more — directly from chat.

MCP servers are agent-runtime tooling, deliberately separate from data-sync connectors: they have a different lifecycle, credentials, and permission model.

## Adding a server

Go to **Settings → MCP Servers** (workspace admins only) and choose a preset:

- **Close CRM** — the official `mcp.close.com` server. Lets the agent search leads, manage opportunities, create contacts, and log activities in your Close organization. Defaults to OAuth login; API-key auth is also supported.
- **Custom MCP server** — connect any MCP server reachable over Streamable HTTP. Provide the server URL and choose OAuth, API-key, or no authentication.

After adding a server, use **Test connection** to verify credentials and discover the server's tool list. Discovered tools are cached in the workspace so chat startup never blocks on an MCP round-trip.

## Authentication

Two credential modes, both encrypted at rest (AES-256-CBC):

- **OAuth 2.0 personal login** — each user signs in with their own account. Mako uses Dynamic Client Registration + PKCE against the server's OAuth metadata, then persists per-user refresh tokens and auto-refreshes them. This is the recommended mode for Close.
- **API key / headers** — for preset servers, fill in the provider's credential fields (e.g. Close's `Close-API-Key`). For custom servers, supply free-form HTTP headers. Credentials can be **shared** across the workspace or **per-user**.

:::note[Mandatory individual sign-in]
For OAuth servers, every user must complete their own sign-in before the agent can use that server's tools on their behalf. Credentials are never shared across accounts for OAuth connections.
:::

## Write scope and risk tiers

Each connection carries a **write scope** that caps what its tools can do. For Close, this maps to the provider's `Close-Scope` header:

| Write scope | Meaning |
| --- | --- |
| `read` | Read-only. Every tool is treated as read-tier regardless of its own hints. |
| `write_safe` | Reads plus non-destructive writes. |
| `write_destructive` | Reads plus destructive writes (deletes, irreversible changes). |

Within an allowed scope, each discovered tool is assigned a **risk tier**:

- **read** — the whole connection is read-tier when write scope is `read`, or the tool declares `readOnlyHint: true`.
- **destructive** — the tool declares `destructiveHint: true`.
- **write** — the default when hints are absent.

## Approval flow

MCP tool calls use a Claude-style human-in-the-loop approval, surfaced as an **approval card** in chat with an input preview and risk badge. Three choices:

- **Allow once** — run this call now.
- **Always allow** — run now and persist an `always_allow` grant so future calls of this tool skip the prompt.
- **Deny / Block** — refuse this call; a persisted `always_deny` grant refuses future calls at execution without prompting.

Default behavior by tier:

- **read** tools auto-run (no prompt).
- **write** tools prompt unless you've granted **always allow**.
- **destructive** tools always prompt and can only be unlocked by a workspace admin.

Grants are per-user and per-tool. Manage or revoke them under **Settings → MCP Servers**.

Tools are namespaced `mcp_<server>_<tool>` in the agent runtime, and are treated as cross-cutting across modes. The [plan gate](/skills/) keeps only read-tier MCP tools available during planning.

## Security

- Server URLs are SSRF-guarded (no internal/loopback targets).
- Each tool execution opens a short-lived, credential-scoped MCP client — there is no cross-tenant connection pooling.
- Credentials and OAuth client registrations are encrypted at rest with the same wire format as data-sync connector configs.

## REST API

Server management lives under `/api/workspaces/:workspaceId/mcp-servers` (admin-gated); presets and the OAuth callback live under `/api/mcp`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/mcp/presets` | List MCP connector presets |
| `GET` | `/api/mcp/oauth/callback` | OAuth authorization callback (redirects to `/settings/mcp`) |
| `GET` | `/api/workspaces/:workspaceId/mcp-servers` | List MCP servers |
| `POST` | `/api/workspaces/:workspaceId/mcp-servers` | Create a server |
| `PATCH` | `/api/workspaces/:workspaceId/mcp-servers/:id` | Update a server |
| `DELETE` | `/api/workspaces/:workspaceId/mcp-servers/:id` | Delete a server |
| `PUT` | `/api/workspaces/:workspaceId/mcp-servers/:id/credentials` | Save credentials |
| `POST` | `/api/workspaces/:workspaceId/mcp-servers/:id/oauth/connect` | Start OAuth flow (returns authorization URL) |
| `POST` | `/api/workspaces/:workspaceId/mcp-servers/:id/test` | Test connection and refresh tool list |
| `GET` | `/api/workspaces/:workspaceId/mcp-servers/tool-info` | Tool metadata for the chat UI |
| `GET` | `/api/workspaces/:workspaceId/mcp-servers/:id/grants` | List your tool grants |
| `POST` | `/api/workspaces/:workspaceId/mcp-servers/:id/grants` | Create/update a tool grant |
| `DELETE` | `/api/workspaces/:workspaceId/mcp-servers/:id/grants/:grantId` | Revoke a tool grant |

See the auto-generated [REST API reference](/api/) for full request and response schemas.
