---
title: Architecture
description: How Mako is built — components, data flow, and design decisions.
---

Mako is a TypeScript monorepo with three main packages: a React frontend, a Hono API server, and an Astro documentation site.

## Repository Structure

```
mako/
├── app/           # React + Vite frontend
├── api/           # Hono API server (Node.js)
├── packages/      # Shared workspace packages (see below)
├── docs/          # Documentation (Astro Starlight)
├── cloudflare/    # Cloudflare Workers
├── scripts/       # Build and validation scripts
└── package.json   # Root workspace config (pnpm)
```

The pnpm workspace spans `app`, `api`, `docs`, and everything under `packages/*` (the marketing site lives in a separate repo):

| Package | Purpose |
| ------- | ------- |
| `@mako/agent-tools` | Shared agent tool definitions (console, dashboard, chart, data-source, dbt, flow, app) reused across surfaces |
| `@mako/schemas` | Shared Zod/JSON schemas — app scaffold, dashboard, chart templates, flow form, table refs |
| `@mako/local-agent` | localhost daemon (`127.0.0.1:41720`) that lets `app.mako.ai` query databases on the user's machine; credentials stay encrypted on disk |
| `@mako/desktop` | Electron shell that loads the web app and bundles the local agent for on-machine database connections |

## System Components

### Web Application (`app/`)

| Aspect    | Technology            |
| --------- | --------------------- |
| Framework | React + Vite          |
| Styling   | Tailwind CSS          |
| State     | React Context + Hooks |
| Routing   | React Router          |
| Editor    | Monaco / CodeMirror   |

Key UI: Console editor, Database explorer, Chat interface, Dashboard builder, Collection/View editors, Onboarding flow.

Dashboard-specific: [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) for in-browser SQL, [Mosaic](https://uwdata.github.io/mosaic/) for cross-filtering, [Vega-Lite](https://vega.github.io/vega-lite/) for charts.

### API Server (`api/`)

| Aspect    | Technology                                 |
| --------- | ------------------------------------------ |
| Framework | Hono (on Node.js adapter)                  |
| Database  | MongoDB (Mongoose ODM)                     |
| Auth      | Lucia Auth + Arctic (Google, GitHub OAuth) |
| Job Queue | Inngest                                    |
| AI        | Vercel AI SDK                              |

The API handles:

- Authentication and session management
- Database connection management (encrypted credentials)
- Query execution via the [Query Runner](/query-runner/)
- AI agent streaming via the [Chat API](/api-reference/)

### AI Agent (`api/src/agent-lib/`)

The agent system is a **single unified agent** that switches *expertise modes* mid-conversation (query, dashboard, sync flow, React app, transforms, notebook, explore) via the `enable_mode` tool. Each mode unlocks a domain-specific toolset on top of a small always-on core (memory, skill retrieval, web access, planning, tool discovery). See [AI Agent](/ai-agent/) for the full mode model.

The agent inspects real database schemas before writing anything — the cross-engine discovery family (`list_connections`, `list_databases`, `list_tables`, `inspect_table`) dispatches on connection type, SQL or MongoDB — and executes queries via `sql_execute_query` / `mongo_execute_query`. Results flow back to the chat and — critically — get placed directly in the console editor via `modify_console`.

### Query Runner (`api/src/databases/`)

Supports 9 database drivers through a unified interface:

PostgreSQL, MongoDB, BigQuery, MySQL, ClickHouse, Redshift, Cloud SQL (Postgres), Cloudflare D1, Cloudflare KV.

Each driver implements `executeQuery()` and `inspectSchema()`. Connections are encrypted at rest and pooled per workspace.


### Dashboard Engine (`app/src/dashboard-runtime/`, `api/src/services/dashboard-*`)

The dashboard system uses a split architecture:

| Layer   | Technology                  | Role                                               |
| ------- | --------------------------- | -------------------------------------------------- |
| Server  | DuckDB (`@duckdb/node-api`) | Executes source queries, builds Parquet artifacts   |
| Browser | DuckDB-WASM                 | Loads Parquet files, runs widget SQL locally         |
| Browser | Mosaic (`@uwdata/mosaic-core`) | Cross-filtering coordination between widgets     |
| Browser | Vega-Lite                   | Chart rendering                                     |

Data flows: database → server-side DuckDB → Parquet → browser DuckDB-WASM → Vega-Lite/tables/KPIs. See [Dashboards](/dashboards/) for the full breakdown.
### Authentication

Lucia Auth with Arctic OAuth providers (Google, GitHub). Sessions stored in MongoDB. API key authentication available for programmatic access.

## Data Flow

```
User types in console
        │
        ▼
React App → POST /api/chat (streaming)
        │
        ▼
Hono API → Build agent context (schema + self-directive + history)
        │
        ▼
AI Agent → list_databases / inspect_table → sql_execute_query → modify_console
        │
        ▼
Streaming response → Chat UI + Console editor updated
```

## Design Decisions

**Why Hono?** Lightweight, fast, runs everywhere (Node, Cloudflare Workers, Deno). Good TypeScript support.

**Why MongoDB for the app database?** Flexible schema for workspaces, connections, and consoles that evolve rapidly. User databases are whatever the user connects — Mako's own storage is separate.

**Why Vercel AI SDK?** Provider-agnostic streaming. Swap between OpenAI, Anthropic, and Google models without changing the agent code.

**Why Monaco/CodeMirror?** Professional SQL editing with syntax highlighting, auto-completion, and multi-cursor support. The console is the product — it needs to feel like a real editor.
