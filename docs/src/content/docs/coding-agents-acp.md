---
title: Coding Agents (ACP)
description: Run Claude Code, Codex, or Cursor Agent (Grok) inside Mako via the Agent Client Protocol — on your machine, on your subscription.
---

Mako can host **Claude Code**, **Codex (ChatGPT)**, and **Cursor Agent**
(Grok, Composer, …) inside the app using the
[Agent Client Protocol](https://agentclientprotocol.com/) (ACP).

This is the reverse of [MCP Server](/mcp-server/):

| Surface | Direction | Who pays for model tokens |
| --- | --- | --- |
| **Connect Agents** (MCP) | External agent → Mako tools/data | Your Claude / Cursor / Codex sub |
| **Coding Agents** (ACP) | Mako UI → Claude Code / Codex / Cursor Agent | Your Claude Pro/Max, ChatGPT, or Cursor sub |
| **In-product chat** | Mako → AI Gateway | Mako / workspace billing |

## Requirements

1. **Mako Desktop** (recommended) — bundles the Local Agent automatically. You
   should **not** need `pnpm agent:start` for day-to-day use. That command is
   only for developers testing an unreleased agent from a PR branch.
2. An ACP adapter on `PATH`:
   - Claude: `npm i -g @agentclientprotocol/claude-agent-acp`
   - Codex: `npm i -g @zed-industries/codex-acp`
   - Cursor: no adapter needed — Cursor CLI speaks ACP natively
     (`cursor-agent acp`). Install it with
     `curl https://cursor.com/install -fsS | bash`.
3. Sign in with the provider when prompted. **Claude Code** uses a **Terminal**
   login (`claude auth login` / Claude subscription) — Mako’s **Sign in** button
   opens Terminal; it is not a browser popup inside the app. **Cursor Agent**
   uses `cursor-agent login` (Cursor subscription).

## How to use

1. Ensure Local Agent is running and adapters are installed (above).
2. Optional: **Settings → Coding Agents** to sign in and set the default
   working directory.
3. Open **Chat**, open the model dropdown, and under **On this machine** pick
   **Claude Code · Fable (local)** (or Sonnet / Opus / Haiku / Default),
   **Codex (local)**, or **Cursor · Grok 4.6 (local)** (or Grok 4.5 /
   Composer / Default) to run Grok on your Cursor subscription. Mako applies
   the choice via ACP `session/set_config_option` — no Terminal `/model`
   required.
4. Send messages in the normal Chat composer. Mako starts the local ACP session
   automatically and attaches workspace data tools.
5. Optional: attach images in the composer (screenshots, diagrams). They are
   sent to Claude Code / Codex as ACP image blocks, same as cloud chats.
   Requires **Desktop 0.3.11+** — older Local Agents reject the turn with an
   "update Mako Desktop" error instead of silently dropping the image.
   Non-image and remote attachments are not supported on the local ACP path
   and fail loudly.

ACP traffic stays on loopback (`127.0.0.1:41720`). Mako Cloud does **not** proxy
the ACP stdio pipe — prompts and tool calls do not transit Mako servers.

## Mako data tools (MCP attach)

When you start a Coding Agents session (or select **Claude Code (local)** /
**Codex (local)** in the main Chat model picker), Mako mints a short-lived MCP
access token and attaches `POST /api/mcp` on ACP `session/new`.

Claude Code / Codex then get the same workspace data tools as
[Connect Agents](/mcp-server/): list connections, run SQL, consoles, apps, etc.
Database queries stay **read-only**; apps/consoles can be authored over MCP.
File and shell tools still run on your machine via the adapter.

**Apps in Desktop:** `app_open_app` opens the app tab in the Desktop window
with a live dev preview (same as in-app chat).

To feel like the in-app agent, Mako:

- Attaches an already-authenticated MCP server named `mako-workspace` (Bearer
  token) — not Claude.ai’s optional “Mako” connector
- Allowlists `mcp__mako-workspace__*` so Mako tools don’t require a click
- Auto-approves those tools + read/search kinds in the Local Agent
- Shows **Allow / Deny in the Chat composer** for Bash and file edits (HITL)
- **Claude ACP:** appends a lean Mako + skills workflow to
  `systemPrompt` (prefer MCP tools; call `get_relevant_skills` early). Full
  skill bodies stay on demand via MCP / `mako://skills/{name}` — not stuffed
  into the system prompt. Workspace **custom prompt** is appended when set.
- **Codex ACP:** skills/tools come from MCP server instructions (Codex adapters
  often ignore Claude-style `systemPrompt` `_meta` today)
- **Cursor ACP:** same as Codex — Mako guidance rides the first prompt; skills
  stay on demand via MCP. Model switches (e.g. Grok 4.6 → Composer) start a
  fresh local session with Chat continuity instead of a mid-chat hot-swap.

If attach fails (offline API, missing workspace), Chat shows an **Enable
workspace tools** banner — one click remints the token and starts a fresh ACP
session with `mako-workspace`. You should **not** run `claude mcp` or authorize
Claude.ai’s separate “Mako” connector.

The minted MCP token is valid for 8 hours and is fixed for the life of the
local session (the adapter cannot refresh it). Chat tracks the expiry and
automatically retires a session whose token is about to expire, starting a
fresh one with a new token on your next message — the transcript carries over.
If you still see `MCP server "mako-workspace" requires re-authorization (token
expired)` in a tool result, the session predates this check: switch the model
away and back, or fully quit and reopen Mako Desktop, then send again. Do not
run `/mcp` in Claude Code — there is no OAuth flow to re-run for this server.

If Claude already replied that Mako needs auth, click **Enable workspace
tools**, then send another message (or start a **New chat**). Local Agent also
probes `/api/mcp` before session start so bad hosts/tokens fail with a clear
error instead of a silent local-only session.

If the Claude/Codex adapter process dies mid-turn (“ACP connection closed”),
Local Agent invalidates that provider’s sessions and Chat **automatically
starts a fresh session on the next send** (one reconnect attempt). You should
not need to restart Desktop for a single adapter crash.

### Desktop updates vs web UI

The Chat UI updates with every cloud deploy. The **Local Agent inside Desktop**
only updates when a new Desktop release ships (or when you install a
[desktop-canary](https://github.com/mako-ai/mako/releases/tag/desktop-canary)
build from a PR). If Coding Agents features misbehave on an older Desktop,
install the latest Desktop / canary — do not rely on `pnpm agent:start`
unless you are developing the agent itself.

## Security notes

- File/shell tools execute **locally** via the adapter.
- Workspace database access goes through Mako MCP and stays **read-only**
  (`mcp` + `query:read`), same as the MCP server.
- The MCP Bearer is session-scoped and never logged by the Local Agent.

## See also

- [MCP Server](/mcp-server/) — point Claude Code *at* Mako
- [Mako Desktop](/desktop/) — Local Agent for localhost databases and ACP
