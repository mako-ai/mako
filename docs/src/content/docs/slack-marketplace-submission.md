---
title: Slack Marketplace submission kit
description: Paste-ready listing copy, scope justifications, security answers, and a pre-submit checklist for the shared Mako Slack app.
---

# Slack Marketplace submission kit

Internal runbook for publishing the **shared** Mako Slack app (`A0BH41R61KP`) so every Mako workspace can one-click **Connect Slack**.

:::caution[Do not activate public distribution early]
Slack MCP rejects **unlisted** public apps. Keep the app **internal** until you submit for Marketplace review. Activating public distribution *without* listing breaks MCP for everyone.
:::

## Public URLs (submit these)

| Field | URL |
| --- | --- |
| Landing / installation page | https://docs.mako.ai/slack/ |
| Privacy policy | https://docs.mako.ai/privacy/ |
| Support | https://docs.mako.ai/support/ |
| Connect deep link (logged-in) | https://app.mako.ai/settings/mcp |
| OAuth redirect (prod) | `https://app.mako.ai/api/mcp/oauth/callback` |
| OAuth redirect (local) | `http://localhost:5173/api/mcp/oauth/callback` |

Deploy docs to production **before** submitting so reviewers can open the links.

## Listing copy (paste into Slack)

### App name

`Mako`

### Short description (≤140 chars)

```
AI data platform agent for Slack — search messages, read channels, and send replies with per-action approval.
```

### Long description

```
Mako is an open-source AI data platform (SQL, dbt, dashboards, apps). The Mako Slack app lets each user connect their Slack account so Mako’s agent can use Slack’s official MCP server (mcp.slack.com).

What you get
• Search messages, files, and people across channels you can access
• Read channel, thread, and DM history in context while analyzing data
• Look up users and emoji
• Optionally send messages, reactions, and canvas updates — only when the connection allows writes and you approve the action in Mako chat

How it works
1. Sign in at app.mako.ai
2. Settings → MCP Servers → Slack → Connect Slack
3. Approve access on slack.com

Privacy & control
• Each member connects their own Slack account (no shared bot identity for tools)
• OAuth tokens are encrypted at rest
• Slack content is not used to train foundation models
• Disconnect anytime in Mako or revoke the app in Slack

Support: https://docs.mako.ai/support/
Privacy: https://docs.mako.ai/privacy/
Landing: https://docs.mako.ai/slack/
```

### Categories (suggested)

- AI & ML
- Developer tools
- Productivity

## Scope justifications (write_safe — recommended for first submit)

Register these **User Token Scopes** on the Slack app and paste the justifications into the submission form. Prefer submitting **`write_safe`** first; add `channels:write` / `groups:write` / `im:write` / `mpim:write` later (re-review) if you need `write_destructive` in Mako.

| Scope | Justification |
| --- | --- |
| `search:read.public` | Agent searches public-channel messages the user can already see, via Slack MCP search tools. |
| `search:read.private` | Agent searches private-channel messages the user can already see. |
| `search:read.im` | Agent searches DM content the user can already see. |
| `search:read.mpim` | Agent searches multi-person DM content the user can already see. |
| `search:read.files` | Agent finds files relevant to a question via Slack search. |
| `search:read.users` | Agent finds people by name/email via Slack search. |
| `channels:history` | Agent reads public channel history/threads when answering questions. |
| `groups:history` | Agent reads private channel history the user can access. |
| `im:history` | Agent reads DM history the user can access. |
| `mpim:history` | Agent reads group-DM history the user can access. |
| `channels:read` | Agent lists/resolves public channels the user can see. |
| `groups:read` | Agent lists/resolves private channels the user can see. |
| `mpim:read` | Agent lists/resolves MPIMs the user can see. |
| `users:read` | Agent resolves user IDs to display names in search/history results. |
| `users:read.email` | Agent matches people by email when the user asks (e.g. “message jane@…”). |
| `canvases:read` | Agent reads Slack canvases when the user asks about documented playbooks/notes. |
| `reactions:read` | Agent reads reaction context on messages. |
| `emoji:read` | Agent resolves custom emoji names when composing or interpreting messages. |
| `files:read` | Agent reads file metadata/content the user can access when asked. |
| `chat:write` | Agent sends messages **only** after the user approves a write tool call in Mako (or has Always allow). |
| `reactions:write` | Agent adds reactions when the user approves. |
| `canvases:write` | Agent updates canvases when the user approves. |

### Optional later (`write_destructive` — do **not** include in v1 submit unless required)

| Scope | Justification |
| --- | --- |
| `channels:write` | Create/manage public channels when the user explicitly approves a destructive-tier tool. |
| `groups:write` | Create/manage private channels with explicit approval. |
| `im:write` | Open DMs when required for an approved write action. |
| `mpim:write` | Manage MPIMs when required for an approved write action. |

## Security & compliance answers (draft)

Use these as starting text in Slack’s Security & compliance questionnaire; adjust if legal asks for changes.

**What data do you access?**  
User-authorized Slack content (messages, files, channel metadata, user profiles) via Slack’s MCP APIs, limited by the OAuth scopes granted and the user’s existing Slack ACLs.

**How is data stored?**  
OAuth tokens encrypted at rest (AES-256-CBC). Tool results may appear in the user’s Mako chat history. We do not maintain a separate mirror of the Slack workspace.

**Is customer Slack data used to train ML models?**  
**No.** Slack content is not used to train foundation models.

**Do you have a privacy policy / DPA?**  
Privacy policy: https://docs.mako.ai/privacy/ — contact support@mako.ai for DPA requests.

**How do users revoke access?**  
Disconnect in Mako Settings → MCP Servers, or revoke the app in Slack. Deleting the Mako account removes stored tokens.

**Vulnerability reporting**  
support@mako.ai with subject `Security`.

## App config checklist (api.slack.com)

Before **Submit for review**:

1. **Basic Information** — name `Mako`, 512×512 icon, short/long description matching above
2. **Agents & AI Apps** — **Model Context Protocol = On**
3. **OAuth & Permissions → Redirect URLs**
   - `https://app.mako.ai/api/mcp/oauth/callback`
   - (dev only, optional) `http://localhost:5173/api/mcp/oauth/callback`
4. **OAuth & Permissions → User Token Scopes** — register the `write_safe` set above
5. **Manage Distribution** — complete checklist; install landing URL = `https://docs.mako.ai/slack/`
6. **Remove unused Event Subscriptions / Interactivity URLs** if empty (HTTPS only if present)
7. Confirm **Client ID / Secret** are in GitHub Actions: `vars.SLACK_MCP_CLIENT_ID`, `secrets.SLACK_MCP_CLIENT_SECRET`
8. Confirm prod Cloud Run has those env vars after deploy of the Slack MCP PR

## Slack’s gate: 5 workspace installs

Marketplace submission typically requires **≥5 active workspace installs**. Until then:

| Audience | App distribution | How they connect |
| --- | --- | --- |
| Your org | Keep app **internal** | One-click with `SLACK_MCP_CLIENT_*` |
| Design partners | Temporary: their own Slack app + paste Client ID/Secret in Mako | Per-workspace fallback |
| Public | After Marketplace **approve + publish** | Shared app, one-click |

## Reviewer test plan (attach / paste)

1. Create account at https://app.mako.ai/register  
2. Open https://docs.mako.ai/slack/ (no login required)  
3. Follow Connect steps → land on Slack consent with PKCE  
4. Approve → return to Mako Settings → MCP shows Connected  
5. In chat, ask to search a public channel the reviewer can access  
6. With write enabled, ask to send a message to a test channel → approval card appears → Allow once  

## After approval

1. Click **Publish** on the Marketplace listing  
2. Verify MCP still works (listed ≠ unlisted)  
3. Announce one-click Connect for all hosted workspaces  

## Related code

- Preset + scopes: `api/src/mcp/presets.ts` (`SLACK_MCP_PRESET`)
- OAuth: `api/src/services/mcp-oauth.service.ts`
- Operator docs: [MCP Connectors](/mcp-connectors/)
