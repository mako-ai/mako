---
title: Mako for Slack
description: Connect Slack to Mako so your AI agent can search messages, read channels, and (with approval) send replies — using Slack's official MCP server.
---

# Mako for Slack

**Mako** is an open-source AI data platform. Connecting Slack lets the Mako agent search your workspace, read channel and thread history, look up people, and — when you allow it — send messages and reactions. Access is always **as you**: every member signs in with their own Slack account, and write actions ask for approval in chat unless you choose Always allow.

Mako uses Slack's official hosted MCP server at `https://mcp.slack.com/mcp`. We do **not** scrape your workspace or train models on your Slack data.

## Connect Slack (2 minutes)

1. Open [app.mako.ai](https://app.mako.ai) and sign in (or [create a free account](https://app.mako.ai/register)).
2. Go to **Settings → MCP Servers**.
3. Add **Slack** (or open an existing Slack connection).
4. Click **Connect Slack** and approve access on slack.com.

Deep link once you're logged in: [app.mako.ai/settings/mcp](https://app.mako.ai/settings/mcp).

:::tip[Workspace admins]
Only workspace admins can add the Slack MCP server. After it's added, each member connects their own Slack account.
:::

## What Mako can do in Slack

| Capability | When |
| --- | --- |
| Search messages, files, and people | Always (read connection) |
| Read channel, group, DM, and thread history | Always (read connection) |
| Look up users and emoji | Always (read connection) |
| Read canvases | Always (read connection) |
| Send messages, add reactions, edit canvases | Only with a write-enabled connection **and** your approval in chat |
| Manage channels / conversations | Only with the highest write tier **and** your approval |

You choose the connection's write tier in Mako (`read`, `write_safe`, or `write_destructive`). A read-only connection never receives a `chat:write` token from Slack.

## How permissions work

- **Per-user OAuth** — Mako stores your encrypted Slack refresh token and uses it only to call `mcp.slack.com` on your behalf.
- **Human-in-the-loop** — write and destructive tool calls show an approval card in chat (Allow once / Always allow / Deny).
- **Least privilege** — the OAuth scopes requested match the write tier you picked when connecting.
- **Revoke anytime** — disconnect in Mako (**Settings → MCP Servers**) or revoke the app under your Slack account settings.

## Privacy & support

- [Privacy Policy](/privacy/) — what we store (encrypted tokens), retention, and deletion
- [Support](/support/) — how to reach us
- [MCP Connectors docs](/mcp-connectors/) — full technical detail for admins and self-hosters

## Self-hosting

Running Mako yourself? You can either point at the shared Mako Slack app (same Client ID/Secret as hosted) or register your own Slack app. See [Slack app setup](/mcp-connectors/#slack-app-setup-operators--self-hosters).

## Links

- Product: [mako.ai](https://mako.ai)
- App: [app.mako.ai](https://app.mako.ai)
- Source: [github.com/mako-ai/mako](https://github.com/mako-ai/mako)
- Docs: [docs.mako.ai](https://docs.mako.ai)
