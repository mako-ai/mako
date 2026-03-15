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

| Aspect | Technology |
|---|---|
| Framework | React + Vite |
| Styling | Tailwind CSS |
| State | React Context + Hooks |
| Routing | React Router |
| Editor | Monaco / CodeMirror |

Key UI components: Console editor, Database explorer, Chat interface, Flow editor, Connector configuration, Collection/View editors, Onboarding flow.

### API Server (`api/`)

| Aspect | Technology |
|---|---|
| Framework | Hono (on Node.js adapter) |
| Database | MongoDB (Mongoose ODM) |
| Auth | Lucia Auth + Arctic (Google, GitHub OAuth) |
| Job Queue | Inngest |
| AI | Vercel AI SDK |

The API handles:
- Authentication and session management
- Database connection management (encrypted credentials)
- Query execution via the [Query Runner](/query-runner/)
- AI agent streaming via the [Chat API](/api-reference/)
- Sync orchestration via [Connectors](/connectors/) and [Flows](/data-sync/)

### Sync Engine (`api/src/sync/`)

The sync engine moves data from sources to destinations:

1. **Connector** fetches a chunk of records using `fetchEntityChunk`
2. **Orchestrator** saves the cursor and progress after each chunk
3. On failure, resumes from the last saved cursor
4. All writes are upsert-based (idempotent)

Orchestrated by **Inngest** for serverless-friendly execution with automatic retry.

### Query Runner (`api/src/databases/`)

A driver registry with implementations for:
- PostgreSQL, Cloud SQL (Postgres), Redshift
- BigQuery
- MongoDB
- MySQL
- ClickHouse
- SQLite, Cloudflare D1

Each driver implements: connection pooling, query execution, schema inspection, and dialect handling.

### AI Agent (`api/src/agent-lib/`)

Multi-agent architecture with specialized agents:
- **Console Agent**: Database query assistant
- **Flow Agent**: Sync configuration assistant

Both share a common toolset (database discovery, query execution, console management) but have different system prompts and specialized tools.

The agent uses the **Vercel AI SDK** for streaming, tool calling, and multi-provider support.

### Background Jobs (Inngest)

Inngest handles:
- Scheduled and triggered sync flows
- Webhook-triggered flows
- Long-running sync operations with step-based retry

## Data Flow

```
User Question
    │
    ▼
Chat API (/api/agent/chat)
    │
    ▼
Agent selects tools based on question
    │
    ├── list_connections → discover databases
    ├── sql_inspect_table → understand schema
    ├── sql_execute_query → run query via Query Runner
    ├── modify_console → deliver working query to UI
    └── update_self_directive → remember for next time
    │
    ▼
Streaming SSE response to frontend
```

## Security

- Database credentials are encrypted at rest with `ENCRYPTION_KEY`
- Sessions use HTTP-only cookies with CSRF protection
- API keys are hashed (bcrypt) before storage
- OAuth via Lucia Auth + Arctic (no password storage for social login)
- Rate limiting on authentication endpoints
