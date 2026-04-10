# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Canonical rules live in `.cursor/rules/`** — they cover project structure, API routing, auth, sync, MongoDB, frontend, engineering ops, build/deploy, migrations, connectors, and MUI theme. This file supplements them with commands, env config, and tech stack details for Claude Code CLI.

## Project Overview

**Mako - The AI-native SQL Client**

Mako is a production-ready, multi-tenant AI-powered SQL client built with a PNPM workspace monorepo structure. It combines multi-database query execution (MongoDB, PostgreSQL, BigQuery, ClickHouse, etc.), AI-powered query generation with multi-provider LLM support (OpenAI, Anthropic, Google), team collaboration features, and optional data source connectors (Stripe, Close CRM, GraphQL APIs, PostHog, REST APIs) with event-driven synchronization (batch and CDC/streaming) via Inngest.

**Architecture:** Five main packages:

- **Root**: Data sync scripts, database migrations, and shared configuration
- **API**: Hono-based backend server (Node.js 20+, TypeScript, MongoDB with Mongoose, Arctic OAuth)
- **App**: React/Vite frontend (React 18, MUI v7, Zustand, Monaco Editor, Vercel AI SDK)
- **Website**: Next.js 14 marketing site with Tailwind CSS
- **Docs**: Astro-based documentation site

## Essential Commands

### Development

```bash
pnpm dev                    # Start API (8080) + App (5173) + Inngest Dev Server concurrently
pnpm app:dev               # Frontend only (Vite dev server on port 5173)
pnpm api:dev               # Backend only (Hono server on port 8080)
pnpm website:dev           # Marketing website (Next.js)
pnpm docs:dev              # Documentation site (Astro)
```

### Building & Production

```bash
pnpm build                 # Lint + build all packages in workspace
pnpm start                 # Start production server (serves both API and static frontend)
pnpm app:build             # Build frontend only (outputs to app/dist)
pnpm api:build             # Build backend only (TypeScript compilation)
pnpm lint:all              # Lint all packages
pnpm lint:fix:all          # Auto-fix linting issues across workspace
```

### Data Operations

```bash
pnpm docker:up             # Start MongoDB and services (docker-compose up -d)
pnpm docker:down           # Stop all services
pnpm docker:logs           # View service logs
pnpm docker:rebuild        # Rebuild and restart containers
pnpm docker:clean          # Clean volumes and reset data
pnpm sync                  # Interactive sync CLI (legacy system)
pnpm query <query_file>    # Execute MongoDB queries from file
```

### Database Migrations

```bash
pnpm migrate               # Run all pending migrations
pnpm migrate status        # Show migration status (pending/applied)
pnpm migrate create "name" # Create a new migration file with timestamp
```

### Infrastructure & Deployment

```bash
pnpm cf:login              # Login to Cloudflare
pnpm cf:deploy             # Deploy to Cloudflare Workers
pnpm preview-db:*          # Manage preview databases (create, destroy, list, seed)
```

## Configuration

### Environment Variables (.env)

Create a `.env` file in the root directory. See `.env.example` for reference.

```env
# Database
DATABASE_URL=mongodb://localhost:27017/myapp
MONGODB_CONNECTION_STRING=mongodb://localhost:27018
MONGODB_MAX_POOL_SIZE=10
MONGODB_MIN_POOL_SIZE=2

# OAuth
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GH_CLIENT_ID=your_github_client_id
GH_CLIENT_SECRET=your_github_client_secret

# Session & Security
SESSION_SECRET=generate_32_char_random_string
ENCRYPTION_KEY=32_byte_hex_key

# Server
WEB_API_PORT=8080
BASE_URL=http://localhost:8080
CLIENT_URL=http://localhost:5173
PUBLIC_URL=http://localhost:5173

# AI/LLM Providers (at least one required)
OPENAI_API_KEY=your_openai_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
GOOGLE_GENERATIVE_AI_API_KEY=your_google_api_key

# Email (SendGrid)
SENDGRID_API_KEY=your_sendgrid_api_key
SENDGRID_FROM_EMAIL=noreply@yourdomain.com
SENDGRID_INVITATION_TEMPLATE_ID=d-xxxxxxxxx
SENDGRID_VERIFICATION_TEMPLATE_ID=d-xxxxxxxxx

# Inngest (optional)
INNGEST_EVENT_KEY=your_inngest_event_key
INNGEST_SIGNING_KEY=your_inngest_signing_key
```

## Technology Stack

### Backend

| Technology    | Version    | Purpose                |
| ------------- | ---------- | ---------------------- |
| Node.js       | 20+        | Runtime                |
| TypeScript    | 5.8.3      | Type safety            |
| Hono          | 4.7.11     | Web framework          |
| Mongoose      | 8.15.1     | MongoDB ODM            |
| Arctic        | 3.7.0      | OAuth                  |
| Inngest       | 3.39.2     | Event-driven workflows |
| Vercel AI SDK | 6.0.0-beta | LLM abstraction        |

### Frontend

| Technology      | Version | Purpose           |
| --------------- | ------- | ----------------- |
| React           | 18.2.0  | UI framework      |
| Vite            | 5.0.8   | Build tool        |
| MUI             | 7.1.0   | Component library |
| Zustand         | 5.0.5   | State management  |
| Monaco Editor   | 4.6.0   | Code editor       |
| React Hook Form | 7.57.0  | Form handling     |

### Supported Databases

MongoDB, PostgreSQL, BigQuery, ClickHouse, Cloud SQL (Postgres), Cloudflare D1, Cloudflare KV, MySQL, SQLite, MSSQL

## Key Principles

1. All data operations must be scoped to the current workspace
2. Use existing patterns for connectors, drivers, components, and stores
3. Encrypt sensitive data with AES-256-CBC utilities
4. Auth middleware before workspace context, workspace context before business logic
5. Zustand stores for state management (not Context API)
6. No `any` types without justification
7. Use structured loggers (never `console.log` in API code)
8. Support query cancellation via AbortSignal in database drivers
9. Add exponential backoff retry logic for external API calls

### Legacy Systems

- **Legacy sync CLI** (`/sync/cli.ts`) — being replaced by Inngest workflows
- **config.yaml** — data sources now managed via UI, legacy support remains
- **Lucia Auth references** — now using Arctic for OAuth
