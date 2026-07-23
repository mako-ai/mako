---
title: Coding Agents (ACP)
description: Run Claude Code or Codex inside Mako via the Agent Client Protocol — on your machine, on your subscription.
---

Mako can host **Claude Code** and **Codex (ChatGPT)** inside the app using the
[Agent Client Protocol](https://agentclientprotocol.com/) (ACP).

This is the reverse of [MCP Server](/mcp-server/):

| Surface | Direction | Who pays for model tokens |
| --- | --- | --- |
| **Connect Agents** (MCP) | External agent → Mako tools/data | Your Claude / Cursor / Codex sub |
| **Coding Agents** (ACP) | Mako UI → Claude Code / Codex | Your Claude Pro/Max or ChatGPT sub |
| **In-product chat** | Mako → AI Gateway | Mako / workspace billing |

## Requirements

1. **Mako Local Agent** running on the machine (bundled with [Mako Desktop](/desktop/),
   or `pnpm agent:start`).
2. An ACP adapter on `PATH`:
   - Claude: `npm i -g @agentclientprotocol/claude-agent-acp`
   - Codex: `npm i -g @zed-industries/codex-acp`
3. Sign-in with the provider (Claude Pro/Max or ChatGPT / API key) when prompted.

## How to use

1. Open **Settings → Coding Agents**.
2. Pick **Claude Code** or **Codex (ChatGPT)**.
3. Set a working directory (absolute path on your machine).
4. Click **Sign in** if needed, then **Start session**.
5. Chat. Permission prompts appear when the agent wants to edit files or run tools.

ACP traffic stays on loopback (`127.0.0.1:41720`). Mako Cloud does **not** proxy
the ACP stdio pipe — prompts and tool calls do not transit Mako servers.

## Mako data tools (MCP attach)

When you start a Coding Agents session (or select **Claude Code (local)** /
**Codex (local)** in the main Chat model picker), Mako mints a short-lived MCP
access token and attaches `POST /api/mcp` on ACP `session/new`.

Claude Code / Codex then get the same **read-only** workspace tools as
[Connect Agents](/mcp-server/): list connections, run SQL, consoles, etc. —
while file/shell tools still run on your machine via the adapter.

If attach fails (offline API, missing workspace), the session still starts with
local tools only; start a **new** session after fixing auth to pick up Mako MCP.

## Security notes

- File/shell tools execute **locally** via the adapter.
- Workspace database access goes through Mako MCP and stays **read-only**
  (`mcp` + `query:read`), same as the MCP server.
- The MCP Bearer is session-scoped and never logged by the Local Agent.

## See also

- [MCP Server](/mcp-server/) — point Claude Code *at* Mako
- [Mako Desktop](/desktop/) — Local Agent for localhost databases and ACP
