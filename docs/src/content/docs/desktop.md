---
title: Mako Desktop
description: The native desktop app — including the Mako Agent for querying databases on localhost.
---

Mako Desktop is a native app for macOS, Windows, and Linux. It wraps the live Mako web app (the product self-updates with every cloud deploy) and bundles the **Mako Local Agent**, so databases running on your own machine — `localhost` Postgres, MongoDB, MySQL — work out of the box.

## Download

Grab the installer from [mako.ai/download](https://mako.ai/download), or directly:

- [macOS (Apple Silicon)](https://github.com/mako-ai/mako/releases/latest/download/Mako-mac-arm64.dmg)
- [macOS (Intel)](https://github.com/mako-ai/mako/releases/latest/download/Mako-mac-x64.dmg)
- [Windows (x64)](https://github.com/mako-ai/mako/releases/latest/download/Mako-win-x64.exe)
- [Linux (AppImage)](https://github.com/mako-ai/mako/releases/latest/download/Mako-linux-x86_64.AppImage)

These links always serve the latest release. The app keeps itself up to date automatically (the web app updates instantly with every deploy; the shell and bundled agent update via the GitHub release feed).

## Signing in

Mako Desktop never asks for credentials inside its own window. Every sign-in and registration method — email/password included — runs in your **system browser**, where your password manager, Google/GitHub sessions, and the URL bar are available, and hands the session back to the app via a `mako://` deep link. The handoff uses one-time, PKCE-bound codes that expire after 60 seconds, so an intercepted link can't be replayed.

## Local databases (Mako Agent)

Browsers can't open raw TCP connections to databases, so the cloud app can only reach databases with a public address. The desktop app solves this with the bundled **Mako Local Agent** — a small daemon on `127.0.0.1:41720` that executes queries and browses schemas on the web app's behalf (the same model as the Postman Desktop Agent).

How it behaves:

- **Automatic detection** — when you add a connection with a local address (`localhost`, `127.x`, `::1`, private LAN ranges, `*.local`, `*.internal`), it's routed through the agent automatically. No toggle, no extra setup.
- **Credentials stay local** — connection credentials for local databases are AES-256-GCM encrypted at rest under `~/.mako/agent/` and are **never sent to Mako Cloud**.
- **Identical behavior** — the agent reuses the exact same database drivers as the cloud API, so query execution, preview safety checks, schema trees, and autocomplete work identically. All connection types are supported locally, including PostgreSQL, MySQL, MongoDB, ClickHouse, Redshift, BigQuery, Cloud SQL, and Cloudflare D1/KV.
- **Loopback only** — the agent listens on `127.0.0.1` exclusively and allows requests only from Mako origins. It is never reachable from the network.

Beyond local databases, the bundled agent also hosts the **ACP bridge** for [Coding Agents](/coding-agents-acp/) — running Claude Code or Codex inside Mako Chat on your own subscription.

Using the **web app** instead of the desktop app? You can still query local databases by running the agent standalone — see [`packages/local-agent`](https://github.com/mako-ai/mako/tree/master/packages/local-agent) for details. Your browser will ask once for permission to reach the local agent (Chromium's Local Network Access prompt).

## Troubleshooting

- **"Agent not running" on a local connection** — make sure you're using Mako Desktop (the agent is bundled and started automatically), or start the standalone agent. In the web app, accept the browser's local-network permission prompt when it appears.
- **Editing an old cloud connection that points at a local address** — cloud connections can't reach your local network. Create a new connection instead; local addresses connect through the agent automatically.
