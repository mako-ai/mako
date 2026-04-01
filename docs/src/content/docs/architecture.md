---
title: Architecture
description: How Mako is built — components, data flow, and design decisions.
---

Mako is a TypeScript monorepo with three main packages: a React frontend, a Hono API server, and an Astro documentation site.

## Repository Structure

```
mono/
├── app/           # React + Vite frontend
├── api/           # Hono API server (Node.js)
├── docs/          # Documentation (Astro Starlight)
├── website/       # Marketing site (Next.js)
├── cloudflare/    # Cloudflare Workers
├── scripts/       # Build and validation scripts
└── package.json   # Root workspace config (pnpm)
```

## System Components

### Web Application (`app/`)

| Aspect    | Technology            |
| --------- | --------------------- |
| Framework | React + Vite          |
| Styling   | Tailwind CSS          |
| State     | React Context + Hooks |
| Routing   | React Router          |
| Editor    | Monaco / CodeMirror   |

Key UI: Console editor, Database explorer, Chat interface, Collection/View editors, Onboarding flow.

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

The agent system uses a multi-agent architecture:

| Agent               | Purpose                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| **Console Agent**   | SQL generation, schema inspection, query execution. The primary agent. |
| **Flow Agent**      | Experimental. Orchestrates data sync pipelines.                        |
| **Universal Tools** | Shared tooling: schema inspection, query execution, self-directive     |

The console agent has access to real database schemas via `inspect_schema` and can execute queries via `sql_execute_query` / `mongodb_execute_query`. Results flow back to the chat and — critically — get placed directly in the console editor via `write_to_interface`.

### Query Runner (`api/src/databases/`)

Supports 9 database drivers through a unified interface:

PostgreSQL, MongoDB, BigQuery, MySQL, ClickHouse, Redshift, SQLite, Snowflake, Cloudflare D1.

Each driver implements `executeQuery()` and `inspectSchema()`. Connections are encrypted at rest and pooled per workspace.

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
AI Agent → inspect_schema → sql_execute_query → write_to_interface
        │
        ▼
Streaming response → Chat UI + Console editor updated
```

## Design Decisions

**Why Hono?** Lightweight, fast, runs everywhere (Node, Cloudflare Workers, Deno). Good TypeScript support.

**Why MongoDB for the app database?** Flexible schema for workspaces, connections, and consoles that evolve rapidly. User databases are whatever the user connects — Mako's own storage is separate.

**Why Vercel AI SDK?** Provider-agnostic streaming. Swap between OpenAI, Anthropic, and Google models without changing the agent code.

**Why Monaco/CodeMirror?** Professional SQL editing with syntax highlighting, auto-completion, and multi-cursor support. The console is the product — it needs to feel like a real editor.
