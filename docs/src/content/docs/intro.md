---
title: Introduction
description: What is Mako and why does it exist?
---

## The Problem

Data lives everywhere. Payments in Stripe, customers in your CRM, product events in PostHog, operational data in your own Postgres. Because the data is scattered:

- You can't join it together to build a single customer view
- Third-party data (Stripe, CRM) isn't queryable with SQL
- Even with a data warehouse, you still need a SQL client or BI tool
- Even with ChatGPT, the LLM can't see your actual schema or test queries against real data

## What Mako Does

Mako stacks four components to solve this:

1. **ETL Pipeline** — Connectors pull data from Stripe, Close CRM, PostHog, REST/GraphQL APIs, and databases into a unified warehouse. Syncs are chunked and resumable.
2. **Universal Database Client** — A console that talks to PostgreSQL, MongoDB, BigQuery, MySQL, ClickHouse, Redshift, SQLite, and Cloudflare D1. One interface for everything.
3. **AI Agent** — An assistant with real tools: it inspects your schemas, writes queries, executes them, reads results, and places the working query in your console. Not a chatbot — a copilot.
4. **Collaboration** — Multi-tenant workspaces with shared consoles, saved queries, API keys, and team management.

## Architecture at a Glance

```
┌─────────────┐  ┌──────────────┐  ┌──────────────┐
│  React App  │  │  Hono API    │  │  Inngest     │
│  (Vite)     │──│  (Node.js)   │──│  (Job Queue) │
└─────────────┘  └──────┬───────┘  └──────────────┘
                        │
          ┌─────────────┼─────────────┐
          │             │             │
   ┌──────┴──────┐ ┌───┴────┐ ┌─────┴─────┐
   │ Connectors  │ │ Query  │ │ AI Agent  │
   │ (ETL)       │ │ Runner │ │ (Vercel   │
   │             │ │        │ │  AI SDK)  │
   └─────────────┘ └────────┘ └───────────┘
```

- **Web App** (`app/`): React + Vite + Tailwind. Console editor, database explorer, chat interface, flow configuration.
- **API** (`api/`): Hono on Node.js. MongoDB for application state. Lucia Auth + Arctic for OAuth.
- **Sync Engine** (`api/src/sync/`): Chunked, resumable ETL with retry logic and Inngest orchestration.
- **Query Runner** (`api/src/databases/`): Uniform interface across 9 database drivers.
- **AI Agent** (`api/src/agent-lib/`): Vercel AI SDK with schema inspection, query execution, and console management tools.

## Tech Stack

| Component | Technology |
|---|---|
| Frontend | React, Vite, Tailwind CSS, React Router |
| API | Hono, Node.js |
| App Database | MongoDB (Mongoose ODM) |
| Auth | Lucia Auth + Arctic (Google, GitHub OAuth) |
| Job Queue | Inngest |
| AI | Vercel AI SDK, OpenAI, Anthropic, Google |
| Deployment | Docker, Google Cloud Run, Cloudflare |
