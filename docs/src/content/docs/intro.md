---
title: Introduction
description: What is Mako and why does it exist?
---

## The Problem

Every team has databases. PostgreSQL, MongoDB, BigQuery, MySQL, ClickHouse, Redshift — often several at once. The tools to work with them haven't changed in years:

- **SQL clients** (pgAdmin, DataGrip, DBeaver) give you a query editor and a schema tree. That's it. No intelligence, no memory, no assistance.
- **ChatGPT/Claude** can write SQL, but can't see your actual schema, can't execute queries, and hallucinate column names.
- **BI tools** (Metabase, Looker) are for dashboards, not exploration. Building a one-off query means leaving the tool.

You end up copying schemas into ChatGPT, pasting queries into your SQL client, fixing errors, going back to ChatGPT — a manual loop that shouldn't exist.

## What Mako Does

Mako is a SQL client where the AI is the interface.

1. **Universal Database Client** — One console that connects to PostgreSQL, MongoDB, BigQuery, MySQL, ClickHouse, Redshift, SQLite, and Cloudflare D1. Switch between databases without switching tools.
2. **AI Agent with Real Access** — The agent inspects your actual schemas, writes queries, executes them against your real data, reads the results, and iterates. No copy-pasting. No hallucinated column names.
3. **Console-First Design** — The agent doesn't just answer in chat. It places working queries directly in your console editor, ready to run, save, or modify.
4. **Learns Your Database** — A self-directive system lets the agent build persistent knowledge about your schema, naming conventions, and common patterns. It gets better the more you use it.
5. **Collaboration** — Multi-tenant workspaces with shared consoles, saved queries, and team management.

## Architecture at a Glance

```
┌─────────────┐  ┌──────────────┐
│  React App  │  │  Hono API    │
│  (Vite)     │──│  (Node.js)   │
└─────────────┘  └──────┬───────┘
                        │
                 ┌──────┴───────┐
                 │              │
          ┌──────┴──────┐ ┌────┴─────┐
          │ Query       │ │ AI Agent │
          │ Runner      │ │ (Vercel  │
          │ (9 drivers) │ │  AI SDK) │
          └─────────────┘ └──────────┘
```

## Next Steps

- [Getting Started](/getting-started/) — Run Mako locally in 5 minutes
- [AI-Powered SQL Client](/ai-agent/) — How the AI agent works
- [Console](/console/) — The query editor and its API
- [Query Runner](/query-runner/) — Supported databases and drivers
