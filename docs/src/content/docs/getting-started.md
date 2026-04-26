---
title: Getting Started
description: Set up Mako locally in 5 minutes.
---

## Prerequisites

- **Node.js** v20+
- **pnpm** v8+
- **Docker** & Docker Compose (for MongoDB)

## Installation

```bash
# Clone the repository
git clone https://github.com/mako-ai/mako.git
cd mako

# Install dependencies
pnpm install

# Set up environment
cp .env.example .env
```

Edit `.env` with your configuration. Required:

| Variable             | Default                          | Purpose                                                    |
| -------------------- | -------------------------------- | ---------------------------------------------------------- |
| `DATABASE_URL`       | `mongodb://localhost:27017/mako` | Application database                                       |
| `ENCRYPTION_KEY`     | —                                | Encryption for stored credentials (`openssl rand -hex 32`) |
| `SESSION_SECRET`     | —                                | Session security                                           |
| `AI_GATEWAY_API_KEY` | —                                | AI features (Vercel AI Gateway — required)                 |

Optional: `OPENAI_API_KEY` (only needed for text embeddings).

For OAuth login, set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and/or `GH_CLIENT_ID`/`GH_CLIENT_SECRET`.

## Start Development

```bash
# Start MongoDB
pnpm run docker:up

# Start everything (API + App + Inngest dev server)
pnpm run dev
```

| Service           | URL                   |
| ----------------- | --------------------- |
| Web App           | http://localhost:5173 |
| API               | http://localhost:8080 |
| Inngest Dashboard | http://localhost:8288 |

## Project Structure

```
mako/
├── app/           # React frontend (Vite)
├── api/           # Hono API server
│   ├── src/
│   │   ├── agent-lib/    # AI agent tools & prompts
│   │   ├── agents/       # Agent registry (console, flow)
│   │   ├── connectors/   # ETL connectors (Stripe, Close, etc.)
│   │   ├── databases/    # Query runner drivers
│   │   ├── inngest/      # Background job functions
│   │   ├── sync/         # Sync orchestrator & CLI
│   │   └── routes/       # API route handlers
├── docs/          # Documentation (Astro Starlight)
├── website/       # Marketing site (Next.js)
└── cloudflare/    # Cloudflare Workers config
```

## Run Sync Manually

Mako includes a CLI for running data sync flows:

```bash
# Interactive mode — prompts for source, destination, entities
pnpm run sync

# Direct mode
pnpm run sync -- -s <source_id> -d <dest_id>

# Run database migrations
pnpm run migrate
```

## Next Steps

- [Connect a database](/databases/connect-databases/) to start querying
- [Set up a connector](/connectors/) to sync external data
- [Use the AI agent](/ai-agent/) to start asking questions
