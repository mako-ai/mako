# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Canonical rules live in `.cursor/rules/`** — they cover project structure, API routing, auth, sync, MongoDB, frontend, engineering ops, build/deploy, migrations, connectors, and MUI theme. This file supplements them with commands, env config, and tech stack details for Claude Code CLI.

## Project Overview

**Mako - The AI-native SQL Client**

Mako is a production-ready, multi-tenant AI-powered SQL client built with a PNPM workspace monorepo structure. It combines multi-database query execution (MongoDB, PostgreSQL, BigQuery, ClickHouse, etc.), AI-powered query generation with multi-provider LLM support (OpenAI, Anthropic, Google), team collaboration features, and optional data source connectors (Stripe, Close CRM, GraphQL APIs, PostHog, REST APIs) with event-driven synchronization (batch and CDC/streaming) via Inngest. Mako is also an MCP server (`POST /api/mcp`, OAuth 2.1 or scoped workspace API keys) so external agents like Claude Code can explore data and build apps headlessly — see `docs/src/content/docs/mcp-server.md` and the MCP OAuth section of `AUTH_README.md`.

**Architecture:** Five main packages:

- **Root**: Data sync scripts, database migrations, and shared configuration
- **API**: Hono-based backend server (Node.js 20+, TypeScript, MongoDB with Mongoose, Arctic OAuth)
- **App**: React/Vite frontend (React 18, MUI v7, Zustand, Monaco Editor, Vercel AI SDK)
- **Website**: Next.js 14 marketing site with Tailwind CSS
- **Docs**: Astro-based documentation site

## Agent prompts & skills

Keep base agent prompts lean. Durable vendor/database/dashboard/flow guidance
belongs in git-versioned system skills under `api/src/agent-skills/**`, not in
always-on prompt literals. See `.cursor/rules/35-agent-prompts.mdc` and
`api/src/agent-skills/README.md` before changing prompt content.

## Agent tools: tier classification is mandatory

The agent sends a _budgeted working set_ of tools to the provider, not every
registered tool (`api/src/agent-lib/tool-catalog.ts`). Every built-in tool must
be classified as **core** (always active), **mode** (in a mode's `toolNames` in
`api/src/agents/modes/registry.ts`), or **deferred**
(`DEFERRED_BUILTIN_TOOL_DOMAINS`) — the tier-policy test in
`api/src/agents/modes/tool-working-set.test.ts` fails on unclassified tools.
An unclassified tool is registered but never reaches the model (silently dead).
MCP tools are always deferred; they activate via `search_tools`/`load_tools`.
`pnpm --filter api tools:measure` prints per-tool token weights.

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
pnpm openapi:sync          # Regenerate OpenAPI spec + typed client (~3s) — REQUIRED after any api route/schema change; commit the outputs

```

### Data Operations

```bash
pnpm docker:up             # Start the local notebook Python kernel sidecar (docker-compose up -d; dev DB is hosted Atlas)
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

## Driving the app in a browser

```bash
./scripts/dev-browser.sh          # isolated, visible, logged-in browser
```

Two things this exists to prevent, both of which have actually bitten:

- **Invisible runs.** `agent-browser` defaults to *headless*, and passing
  `--headed` once is not enough — a later `open` can start a fresh session that
  silently comes up headless. Verify with
  `ps aux | grep agent-browser-chrome | grep -c headless` (0 = visible), never
  by assuming the flag took.
- **Agents fighting over one browser.** The daemon is machine-wide and every
  caller defaults to the session named `default`, so two Claude sessions drive
  the same Chrome: one navigates while the other screenshots, and tabs move
  under you. The script keys a session name and a Chrome profile off the Claude
  session id — stable within a session, unique between them.

Export the three variables it prints in any shell issuing further
`agent-browser` commands. Passing `--profile` to some commands and not others
puts them in *different* sessions, which looks exactly like the browser
ignoring your navigation.

**Never run `agent-browser close --all`** — it is global and kills other
agents' browsers. `agent-browser close` closes only your own.

## Picking up from Claude Code on the Cloud

The cloud environment starts with no `.env`. Bootstrap:

1. `gcloud auth login --no-launch-browser` (paste the code back), then
   `pnpm secrets:pull` — builds `.env` from the `mako-ai-dev` Secret Manager
   project, comments preserved.
2. Machine-local variables are deliberately never synced; set them per
   environment: `APPS_SANDBOX_PROVIDER=e2b` (E2B key IS synced),
   `NODE_ENV=development`, and leave `APPS_GIT_ROOT`/`APPS_SESSIONS_ROOT`
   unset for defaults. `GITHUB_DEV_TOKEN` syncs via
   Secret Manager, but `APPS_CONNECTED_REPO_PUSH` is opt-in per machine —
   without it, mirror pushes to customer repos are refused (safe default for
   a fresh environment); set it deliberately where pushes belong.
3. Sandboxes cannot reach the environment's localhost:8080, so `pnpm dev`
   needs the cloudflared tunnel (`scripts/sandbox-tunnel.sh`); without a named
   tunnel it supervises an ephemeral trycloudflare URL. Terminals work without
   any tunnel (API→E2B is outbound).

Alternatively, configure the env vars once in the cloud environment's settings
UI — the names to carry over are exactly the assignments in `.env.example`
plus the machine-local set above.

## Secrets (Google Secret Manager)

`.env` is gitignored, so a value only exists on whichever laptop created it —
that is how an E2B API key was already lost once. Secrets now live in Secret
Manager (`mako-ai-dev` for local development, `mako-ai-prod` for production),
one secret per variable so a single value can be rotated or granted.

Onboarding a new developer is two commands:

```bash
gcloud auth login
pnpm secrets:pull            # writes .env from mako-ai-dev
```

```bash
pnpm secrets:push            # share local values (uploads as new versions)
pnpm secrets:diff            # which names differ, local vs stored
pnpm secrets:list            # what is stored (names only)
pnpm secrets:pull --env prod # production values
pnpm secrets:salvage-prod    # capture prod Cloud Run env into prod secrets
```

Any mutation takes `--dry-run`. No command ever prints a secret value — output
is names and status only — so a run is safe to paste into a ticket. `pull`
edits `.env` in place (keeping its comments) and backs up the previous file to
`.env.bak`; with no `.env` at all it builds one from `.env.example`.
Machine-specific variables (`APPS_SANDBOX_PROVIDER`, `APPS_GIT_ROOT`,
`APPS_SESSIONS_ROOT`, `NODE_ENV`) are deliberately never synced.

## Apps: the sandbox is an ordinary clone

There is one history (the bare repo per workspace) and one working copy: the
sandbox, which is a normal git clone whose `origin` is Mako's own git-over-HTTP
endpoint (`/api/apps-git/<workspaceId>.git`, served by `git http-backend`,
authorized by a workspace-scoped `mgt_` token in a credential helper). `git
push`, `git pull` and `git checkout` in the terminal are just git — commits
made anywhere in the box are pushed automatically, and the endpoint reacts to
every push (cloud mirror sync + realtime UI refresh), so all push paths
converge there.

Reads come from the sandbox's working copy while it is running (uncommitted
work included) and from the last commit when it is not (`status.offline`).
Uncommitted work lives only in the box, like a laptop: pushed commits survive
losing the machine, uncommitted edits do not.

Two dev facts that bite: (1) a microVM cannot reach `localhost:8080`, so
`pnpm dev` starts a cloudflared tunnel (`scripts/sandbox-tunnel.sh`) and writes
`.env.tunnel` (`APPS_GIT_ORIGIN_URL`) — without it sandboxes cannot clone,
push, or post box-state events (terminals are unaffected: that path is
API→E2B SDK, outbound). Run `pnpm sandbox:tunnel:setup` once per machine to
get a NAMED tunnel with a stable hostname (`APPS_TUNNEL_NAME`/`_HOSTNAME`
in `.env`, never synced); without it the fallback is a supervised ephemeral
`trycloudflare` URL that Cloudflare revokes over time. Full mechanics:
`apps.md` §13.12.
(2) `APPS_SANDBOX_PROVIDER=local` swaps the microVM for a directory on this
machine (tests, or working without E2B credentials); it executes tenant
commands in the API process, so it refuses to load when `NODE_ENV=production`,
and it needs no tunnel.

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

# AI Gateway (required for all AI features)
AI_GATEWAY_API_KEY=your_vercel_ai_gateway_key

# Optional: Embeddings only (text-embedding-3-small)
OPENAI_API_KEY=your_openai_api_key

# Email (SendGrid)
SENDGRID_API_KEY=your_sendgrid_api_key
SENDGRID_FROM_EMAIL=noreply@yourdomain.com
SENDGRID_INVITATION_TEMPLATE_ID=d-xxxxxxxxx
SENDGRID_VERIFICATION_TEMPLATE_ID=d-xxxxxxxxx

# Inngest (optional)
INNGEST_EVENT_KEY=your_inngest_event_key
INNGEST_SIGNING_KEY=your_inngest_signing_key

# Notebook Python kernel (local dev — see .env.example)
# `code` cells run on a managed kernel; locally, `pnpm docker:up` starts the
# sidecar and StaticKernelProvider drives it. Deployed envs auto-detect GKE.
KERNEL_PROVIDER=static
KERNEL_GATEWAY_URL=http://localhost:8888
NOTEBOOK_KERNEL_API_URL=http://host.docker.internal:8080

# Redis (optional — resumable chat streams + kernel session registry)
# Unset: in-process buffers (local dev / single API instance).
# Set when running multiple API instances so chat stream resume
# (GET /api/agent/chat/:chatId/stream) and the shared kernel-session
# registry (notebook kernels visible to every instance) work.
REDIS_URL=redis://localhost:6379
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
| Inngest       | 3.54.1     | Event-driven workflows |
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

MongoDB, PostgreSQL, BigQuery, ClickHouse, Cloud SQL (Postgres), Cloudflare D1, Cloudflare KV, MySQL, Redshift

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
