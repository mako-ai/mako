# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Mako - The AI-native SQL Client**

Mako is a production-ready, multi-tenant AI-powered SQL client built with a PNPM workspace monorepo structure. It combines multi-database query execution (MongoDB, PostgreSQL, BigQuery, ClickHouse, etc.), AI-powered query generation with multi-provider LLM support (OpenAI, Anthropic, Google), team collaboration features, and optional data source connectors (Stripe, Close CRM, GraphQL APIs, PostHog, REST APIs) with event-driven synchronization via Inngest.

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

Migrations are TypeScript files in `/api/src/migrations/` that run against MongoDB. They use a custom migration runner with up/down methods. See `/api/src/migrations/README.md` for patterns and examples.

### Infrastructure & Deployment

```bash
pnpm cf:login              # Login to Cloudflare
pnpm cf:deploy             # Deploy to Cloudflare Workers
pnpm preview-db:*          # Manage preview databases (create, destroy, list, seed)
```

## Core Architecture Patterns

### Multi-Tenant Workspace System

- Each user belongs to one or more workspaces with roles (owner, admin, member, viewer)
- All data (databases, queries, data sources, flows) is scoped to workspaces
- Authentication via **Arctic** (OAuth 2.0) with providers: Google, GitHub
- Email/password authentication with bcrypt hashing
- Session-based auth with HTTP-only cookies (24-hour duration, 12-hour refresh threshold)
- API key authentication for programmatic access
- Invitation system with email-based workflow using SendGrid templates
- Rate limiting on auth endpoints (configurable via env vars)

### Event-Driven Data Sync with Inngest

- **Inngest** v3.39.2 for serverless workflow orchestration
- Event-driven architecture for data synchronization flows
- Support for scheduled (cron) and webhook-triggered flows
- Built-in retry logic with exponential backoff
- Functions located in `/api/src/inngest/functions/`
- Local development server integrated with `pnpm dev`
- Replaces legacy sync CLI for production workloads

### Data Connector Architecture

- Pluggable connector system in `/api/src/connectors/`
- Base connector class (`BaseConnector.ts`) with registry pattern for dynamic loading
- **Supported sources**:
  - **Stripe**: Payment data and subscriptions
  - **Close CRM**: Sales pipeline and contacts
  - **GraphQL APIs**: Custom GraphQL endpoints
  - **PostHog**: Analytics events and user behavior
  - **REST APIs**: Generic REST API integration
  - **BigQuery**: Google BigQuery data warehouse
- Encrypted credential storage in MongoDB (AES-256-CBC)
- Full and incremental sync modes
- Webhook support for real-time updates

### AI Agent System (agent-v2)

- Multi-provider LLM support: **OpenAI** (GPT-5.2), **Anthropic** (Claude Opus 4.5), **Google** (Gemini 3)
- Dynamic model selection based on configured API keys
- **Vercel AI SDK** v6 for unified interface across providers
- Tool-calling capabilities:
  - SQL code generation (`sql-tools.ts`)
  - MongoDB query generation (`mongodb-tools.ts`)
  - Universal utilities for data analysis (`universal-tools.ts`)
- Conversation thread management with memory (`agent-thread.service.ts`)
- Streaming responses for real-time chat experience
- AI-generated query titles and workspace names

### State Management (Frontend)

- **Zustand** v5 for feature-based state separation (`/app/src/store/`)
- **No single global store** - each feature has its own store
- Key stores: `appStore`, `chatStore`, `consoleStore`, `flowStore`, `schemaStore`, `databaseCatalogStore`, `connectorCatalogStore`, `databaseExplorerStore`
- **Immer integration** for immutable state updates
- TypeScript with full type safety
- Minimal boilerplate, flexible subscriptions

### Database Integration

- **Multi-database support**: MongoDB, PostgreSQL, BigQuery, ClickHouse, Cloud SQL (Postgres), Cloudflare D1, Cloudflare KV, MySQL, SQLite, MSSQL
- **Driver registry pattern** for extensibility (`/api/src/databases/registry.ts`)
- **Connection management**: Encrypted connection strings, connection pooling with configurable limits
- **Query execution**: SQL, MongoDB queries, and JavaScript with Monaco Editor
- **Query cancellation**: Abort signal support across all drivers
- **Retry logic**: Exponential backoff for failed connections
- **Schema introspection**: Automatic discovery of tables, columns, and relationships
- **Result handling**: MUI X Data Grid Premium for visualization

### API Architecture (Backend)

- **Hono framework** v4.7.11 (lightweight, TypeScript-first)
- **Route-based organization** by feature (`/api/src/routes/`)
- **Middleware pattern**:
  - Authentication (`auth.middleware.ts`, `unified-auth.middleware.ts`)
  - Workspace context injection (`workspace.middleware.ts`)
  - API key validation (`api-key.middleware.ts`)
- **Service layer** separation in `/api/src/services/` for business logic
- **Repository pattern** for database abstraction (MongoDB models in `/api/src/database/`)
- **Security**:
  - Session-based auth with HTTP-only cookies
  - AES-256-CBC encryption at rest for sensitive data
  - CORS enabled with configurable origins
  - Rate limiting on sensitive endpoints
- **Error handling**: Global error handlers with structured responses

## Key Directories

### API Package (`/api/src/`)

- **`/routes/`** - API endpoint definitions by feature
  - `agent.routes.ts` - AI agent endpoints
  - `chats.ts` - Chat history management
  - `connectors.ts` - Data source CRUD operations
  - `consoles.ts` - Query console management
  - `database.ts` - Database connection endpoints
  - `database-schemas.ts` - Schema introspection
  - `database-tree.ts` - Database hierarchy navigation
  - `execute.ts` - Query execution endpoints
  - `flows.ts` - Data sync flow management
  - `sources.ts` - Data connector management
  - `workspaces.ts` - Multi-tenant workspace operations
  - `workspace-databases.ts` - Workspace-scoped database access
- **`/auth/`** - Authentication system
  - `auth.controller.ts` - OAuth + email auth endpoints
  - `auth.service.ts` - Business logic for auth operations
  - `session.ts` - Session management utilities
  - `arctic.ts` - OAuth provider configuration (Arctic)
  - `auth.middleware.ts` - Auth validation middleware
- **`/services/`** - Business logic layer
  - `database-connection.service.ts` - Connection pooling and management
  - `agent-thread.service.ts` - AI conversation threads
  - `workspace.service.ts` - Workspace operations
  - `sync-executor.service.ts` - Data sync execution (legacy)
  - `email.service.ts` - SendGrid email notifications
  - `title-generator.ts` - AI-generated titles
- **`/connectors/`** - Pluggable data source connectors
  - `base/BaseConnector.ts` - Abstract base class for all connectors
  - `stripe/` - Stripe payment integration
  - `close/` - Close CRM integration
  - `graphql/` - GraphQL API connector
  - `posthog/` - PostHog analytics
  - `rest/` - Generic REST API connector
  - `bigquery/` - Google BigQuery connector
  - `registry.ts` - Dynamic connector discovery
- **`/databases/`** - Multi-database driver system
  - `driver.ts` - Driver interface definition
  - `drivers/` - Database-specific implementations
    - `mongodb/`, `postgresql/`, `bigquery/`, `clickhouse/`, `cloudsql-postgres/`, `cloudflare-d1/`, `cloudflare-kv/`, etc.
  - `registry.ts` - Database driver registry
- **`/database/`** - MongoDB schemas and models
  - `schema.ts` - Legacy MongoDB schema
  - `workspace-schema.ts` - Workspace-scoped schemas
- **`/migrations/`** - Database migration files
  - `cli.ts` - Migration CLI runner
  - `runner.ts` - Migration execution engine
  - Individual migration files (`*.ts`)
  - See `README.md` for migration patterns
- **`/middleware/`** - Hono middleware
  - `workspace.middleware.ts` - Workspace context injection
  - `api-key.middleware.ts` - API key validation
- **`/agent-v2/`** - AI Agent system (v2)
  - `ai-models.ts` - Model configuration (GPT-5.2, Claude 4.5, Gemini 3)
  - `tools/` - Agent capabilities
    - `sql-tools.ts` - SQL query generation
    - `mongodb-tools.ts` - MongoDB operations
    - `universal-tools.ts` - Universal utilities
  - `prompts/` - System prompts for agents
- **`/inngest/`** - Event-driven workflow system
  - `client.ts` - Inngest client setup
  - `functions/` - Workflow function definitions
    - `flow.ts` - Data sync flow execution
    - `webhook-flow.ts` - Webhook-triggered flows
  - `logging.ts` - Event logging
- **`/sync/`** - Legacy sync system (being replaced by Inngest)
  - `cli.ts` - Interactive CLI tool for data sync
- **`/utils/`** - Helper utilities
  - `console-manager.ts` - Console CRUD operations
  - `database-manager.ts` - Database management utilities
  - `query-executor.ts` - Query execution engine
  - `webhook.utils.ts` - Webhook utilities
  - `email.utils.ts` - Email utilities

### App Package (`/app/src/`)

- **`/components/`** - React components (50+ files)
  - `Chat.tsx` - AI chat interface with Vercel AI SDK
  - `Console.tsx` - Query console with Monaco Editor
  - `DatabaseExplorer.tsx` - Database schema browser
  - `ConnectorForm.tsx` - Data source configuration
  - `ConnectorExplorer.tsx` - Data source manager
  - `ConsoleExplorer.tsx` - Query library browser
  - `CreateDatabaseDialog.tsx` - Database connection setup
  - `FlowsExplorer.tsx` - Sync flows UI
  - `Editor.tsx` - Code editor wrapper
  - `ApiKeyManager.tsx` - API key management
  - `LoginPage.tsx` - Authentication page
  - `RegisterPage.tsx` - User registration
  - And many more...
- **`/pages/`** - Page-level components
  - `Settings.tsx` - User settings page
- **`/store/`** - Zustand state management (11+ stores)
  - `appStore.ts` - Global app state
  - `chatStore.ts` - Chat conversation state
  - `consoleStore.ts` - Query console state
  - `consoleTreeStore.ts` - Console library tree
  - `flowStore.ts` - Data sync flow state
  - `schemaStore.ts` - Database schema cache
  - `databaseCatalogStore.ts` - Database listings
  - `connectorCatalogStore.ts` - Available connectors
  - `databaseExplorerStore.ts` - Database browser state
- **`/hooks/`** - Custom React hooks
- **`/contexts/`** - React context providers
  - `auth-context.ts` - Authentication context
  - `workspace-context.ts` - Workspace selection
- **`/lib/`** - Shared utilities
- **`/types/`** - TypeScript type definitions
  - `chat.ts` - Chat types
- **`/utils/`** - Helper functions

### Root Package

- **`/scripts/`** - Utility scripts for data operations
- **`/consoles/`** - Pre-built analytics queries and scripts
- **`/config/`** - Legacy configuration files (config.yaml)

## Configuration

### Environment Variables (.env)

Create a `.env` file in the root directory. See `.env.example` for reference.

```env
# Database Configuration
DATABASE_URL=mongodb://localhost:27017/myapp              # Primary MongoDB connection
MONGODB_CONNECTION_STRING=mongodb://localhost:27018       # Alternative MongoDB connection
MONGODB_MAX_POOL_SIZE=10                                  # Connection pool max size
MONGODB_MIN_POOL_SIZE=2                                   # Connection pool min size

# Authentication (OAuth)
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GH_CLIENT_ID=your_github_client_id
GH_CLIENT_SECRET=your_github_client_secret

# Session & Security
SESSION_SECRET=generate_32_char_random_string             # 32+ character random string
ENCRYPTION_KEY=32_byte_hex_key                           # AES-256-CBC encryption key (64 hex chars)

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000                              # Rate limit window (default: 15 min)
RATE_LIMIT_MAX_REQUESTS=5                                # Max requests per window

# Server Configuration
WEB_API_PORT=8080                                        # Backend API port
BASE_URL=http://localhost:8080                           # Backend base URL
CLIENT_URL=http://localhost:5173                         # Frontend URL
PUBLIC_URL=http://localhost:5173                         # Public-facing URL

# Data Sources (Legacy - now managed via UI)
CLOSE_API_KEY_SPAIN=your_close_api_key
STRIPE_API_KEY_SPAIN=your_stripe_api_key
REALADVISOR_HASURA_SECRET=your_hasura_secret

# AI/LLM Providers (at least one required for AI features)
OPENAI_API_KEY=your_openai_api_key                       # GPT-5.2
ANTHROPIC_API_KEY=your_anthropic_api_key                 # Claude Opus 4.5
GOOGLE_GENERATIVE_AI_API_KEY=your_google_api_key         # Gemini 3

# Email Service (SendGrid)
SENDGRID_API_KEY=your_sendgrid_api_key
SENDGRID_FROM_EMAIL=noreply@yourdomain.com
SENDGRID_INVITATION_TEMPLATE_ID=d-xxxxxxxxx             # Invitation email template
SENDGRID_VERIFICATION_TEMPLATE_ID=d-xxxxxxxxx           # Verification email template

# Inngest (optional - uses default settings if not specified)
INNGEST_EVENT_KEY=your_inngest_event_key
INNGEST_SIGNING_KEY=your_inngest_signing_key

# Cloud Infrastructure (if deploying to GCP)
GCP_PROJECT_ID=your_project_id
GCP_SERVICE_ACCOUNT_KEY=base64_encoded_key

# Cloudflare (if using Cloudflare Workers/D1/KV)
CLOUDFLARE_API_TOKEN=your_cloudflare_token
CLOUDFLARE_ACCOUNT_ID=your_account_id
```

### Data Sources

Data sources are now managed through the web interface (stored in MongoDB with encrypted credentials). The legacy `config/config.yaml` system is deprecated but still supported for backward compatibility during migration.

## Development Patterns

### Component Structure (Frontend)

- Follow existing MUI v7 patterns in `/app/src/components/`
- Use TypeScript interfaces defined in `/app/src/types/`
- Implement responsive design with MUI Grid2 system
- Component naming: PascalCase for component files (e.g., `DatabaseExplorer.tsx`)
- Prefer functional components with hooks over class components
- Use React Hook Form for complex forms
- Leverage Monaco Editor for code editing interfaces

### State Management

- **Use Zustand stores** for cross-component state (no Redux)
- Create feature-specific stores (avoid one giant store)
- Use Immer for immutable updates within stores
- Example pattern:
  ```typescript
  import { create } from 'zustand';
  import { immer } from 'zustand/middleware/immer';

  export const useMyStore = create(immer((set) => ({
    data: [],
    setData: (newData) => set((state) => { state.data = newData; }),
  })));
  ```

### API Development (Backend)

- **Route organization**: Group related endpoints in `/api/src/routes/`
- **Middleware usage**: Always apply auth middleware before workspace middleware
- **Service pattern**: Extract business logic into `/api/src/services/`
- **Error handling**: Use structured error responses with appropriate HTTP status codes
- **Workspace scoping**: All data operations must be scoped to the current workspace
- **Validation**: Use Zod or manual validation at API boundaries

### Adding New Database Drivers

1. Create driver implementation in `/api/src/databases/drivers/<name>/`
2. Implement the `DatabaseDriver` interface from `driver.ts`
3. Register in `/api/src/databases/registry.ts`
4. Support query cancellation via AbortSignal
5. Implement connection pooling if applicable
6. Add retry logic with exponential backoff

### Adding New Data Connectors

1. Create connector in `/api/src/connectors/<name>/`
2. Extend `BaseConnector` class from `/api/src/connectors/base/`
3. Implement required methods: `sync()`, `validate()`, etc.
4. Register in `/api/src/connectors/registry.ts`
5. Add connector configuration UI in frontend
6. Support both full and incremental sync modes
7. Implement webhook handlers if applicable

### Logging (API Package)

**IMPORTANT**: Do not use `console.log`, `console.error`, etc. directly. Use the structured logging system in `/api/src/logging/`.

```typescript
import { loggers } from "../logging";

// Use pre-configured loggers for common categories
const log = loggers.sync();      // For sync operations
const log = loggers.migration(); // For migrations
const log = loggers.db();        // For database operations
const log = loggers.auth();      // For authentication
const log = loggers.agent();     // For AI agent operations
const log = loggers.http();      // For HTTP request/response
const log = loggers.query();     // For query execution
const log = loggers.workspace(); // For workspace operations
const log = loggers.connector(); // For data connectors
const log = loggers.inngest();   // For Inngest/flow operations
const log = loggers.app();       // For application lifecycle

// Logging with structured data
log.info("User logged in", { userId: user.id, provider: "google" });
log.error("Failed to connect", { error, connectionId });
log.debug("Processing request", { requestId, params });
log.warn("Rate limit approaching", { remaining: 10 });
```

**When `console` is acceptable:**
- Logging sinks (`/api/src/logging/sinks/`) - they ARE the output mechanism
- Interactive CLI demo scripts (`demo-interactive.ts`, `example-programmatic.ts`)
- Add `/* eslint-disable no-console */` at the top of these files

**Context Enrichment:**
```typescript
import { enrichContextWithUser, enrichContextWithWorkspace } from "../logging";

// In auth middleware - enriches all logs with userId
enrichContextWithUser(user.id);

// In workspace middleware - enriches all logs with workspaceId  
enrichContextWithWorkspace(workspaceId);
```

**Important**: Only call enrichment functions AFTER authorization succeeds, never before.

### Error Handling

- **Backend**: Structured error responses with proper HTTP codes (400, 401, 403, 404, 500)
- **Frontend**: User-friendly error boundaries and toast notifications (MUI Snackbar)
- **Validation**: Validate input at API boundaries
- **Logging**: Use the structured logger (see above), never raw `console.log`

### Security Considerations

- **Never expose API keys or connection strings in client code**
- Use AES-256-CBC encryption for sensitive data at rest
- Implement proper workspace-based authorization checks in all endpoints
- Session management through HTTP-only cookies (prevents XSS)
- Rate limiting on auth endpoints to prevent brute force
- Validate user permissions before allowing operations
- Encrypt database connection strings in MongoDB
- Use environment variables for all secrets (never hardcode)

### Workspace Verification Middleware (Defense in Depth)

When creating workspace-scoped routes, **always include an `else` clause** to reject unauthenticated requests:

```typescript
// In workspace verification middleware
if (workspace) {
  // API key auth - verify workspace matches URL
  if (workspace._id.toString() !== workspaceId) {
    return c.json({ error: "API key not authorized" }, 403);
  }
} else if (user) {
  // Session auth - verify user has access
  const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
  if (!hasAccess) {
    return c.json({ error: "Access denied" }, 403);
  }
} else {
  // CRITICAL: Defense in depth - reject if neither auth type succeeded
  return c.json({ error: "Unauthorized" }, 401);
}

// Only enrich logging context AFTER authorization succeeds
enrichContextWithWorkspace(workspaceId);
```

**Why this matters**: Without the `else` clause, if `unifiedAuthMiddleware` has a bug or is bypassed, requests could proceed with an unverified `workspaceId` and reach route handlers unauthenticated.

### Code Quality

- **TypeScript**: Strict mode enabled, no `any` types without justification
- **Linting**: ESLint with TypeScript rules, fix issues before committing
- **Formatting**: Prettier for consistent code style
- **Pre-commit hooks**: Husky + lint-staged runs linting on changed files
- **Comments**: Only add comments where logic is non-obvious
- **Type safety**: Prefer interfaces over types for object shapes

## Testing Strategy

Currently uses manual testing with comprehensive checklists. Jest is configured but automated tests are not yet comprehensive.

**Manual testing checklist:**

- Authentication flow testing across OAuth providers (Google, GitHub)
- Email/password authentication
- Multi-tenant isolation verification (workspace data scoping)
- Data source connection testing (all supported connectors)
- Query execution and result handling across database types
- AI agent functionality with different LLM providers
- Data sync flow execution (Inngest workflows)
- Permission checks (owner, admin, member, viewer roles)
- API key authentication
- Rate limiting functionality

**Automated testing:**

- Jest 29.7.0 with ts-jest configured
- Pre-commit hooks enforce linting (ESLint + Prettier)
- TypeScript strict mode catches type errors at compile time

## Deployment

### Docker

- **Multi-stage Dockerfile** for optimized builds
- **Base image**: Node.js 20 (slim variant for production)
- **Build process**:
  1. Builder stage compiles TypeScript and builds Vite app
  2. Production stage copies only necessary files
  3. Native modules compiled during build
- **Port**: 8080 (unified server for API + static frontend)
- **Static files**: Frontend bundled and served by API server in production

### Google Cloud Run

- Production deployment via `deploy.sh` script or GitHub Actions
- Configuration in `cloud-run-env.yaml`
- **Migrations**: Automatically run after deployment
- Environment variables injected from Secret Manager or cloud-run-env.yaml
- Auto-scaling based on traffic

### GitHub Actions CI/CD

- Automated deployment on push to main branch
- Runs linting before deployment
- Executes database migrations post-deployment
- Supports preview environments

### Cloudflare Workers (Optional)

- Deploy with `pnpm cf:deploy`
- Supports Cloudflare D1 (SQLite) and KV (key-value) storage
- Edge computing for low-latency responses

## Common Workflows

### 1. Adding a New Data Source Connector

```bash
# Create connector directory
mkdir -p api/src/connectors/my-source

# Create connector class extending BaseConnector
# Implement: sync(), validate(), getSchema()
# Register in api/src/connectors/registry.ts

# Add configuration UI in app/src/components/ConnectorForm.tsx
# Test with sample data
```

**Key files to modify:**
- `/api/src/connectors/my-source/index.ts` - Connector implementation
- `/api/src/connectors/registry.ts` - Register connector
- `/app/src/components/ConnectorForm.tsx` - Add UI for configuration

### 2. Adding a New Database Driver

```bash
# Create driver directory
mkdir -p api/src/databases/drivers/my-db

# Implement DatabaseDriver interface
# Add connection pooling, query execution, schema introspection
# Support query cancellation via AbortSignal
# Register in api/src/databases/registry.ts
```

**Key files to modify:**
- `/api/src/databases/drivers/my-db/index.ts` - Driver implementation
- `/api/src/databases/registry.ts` - Register driver
- `/api/src/databases/driver.ts` - Reference for interface

### 3. Creating a New Frontend Component

```bash
# Create component file
touch app/src/components/MyComponent.tsx

# Follow MUI v7 patterns
# Use Zustand for state management
# Add TypeScript types in app/src/types/ if needed
```

**Pattern:**
```typescript
import { Box, Typography } from '@mui/material';
import { useMyStore } from '../store/myStore';

export default function MyComponent() {
  const data = useMyStore((state) => state.data);

  return (
    <Box>
      <Typography variant="h5">My Component</Typography>
      {/* Component content */}
    </Box>
  );
}
```

### 4. Adding a New API Endpoint

```bash
# Add route handler
# Location: api/src/routes/my-feature.ts

# Apply middleware: auth → workspace context → your logic
# Return structured responses with proper HTTP codes
```

**Pattern:**
```typescript
import { Hono } from 'hono';
import { authMiddleware } from '../auth/auth.middleware';
import { workspaceMiddleware } from '../middleware/workspace.middleware';

const app = new Hono();

app.get('/api/my-endpoint',
  authMiddleware,
  workspaceMiddleware,
  async (c) => {
    const { workspace } = c.get('workspace');
    // Your logic here
    return c.json({ data: result });
  }
);
```

### 5. Creating a Database Migration

```bash
# Create migration file
pnpm migrate create "add_new_field_to_users"

# Edit the generated file in api/src/migrations/
# Implement up() and down() methods
# Run migration: pnpm migrate
```

**Pattern:**
```typescript
export const up = async () => {
  // Apply changes
  await User.updateMany({}, { $set: { newField: 'default' } });
};

export const down = async () => {
  // Revert changes
  await User.updateMany({}, { $unset: { newField: '' } });
};
```

### 6. Adding a New Inngest Workflow

```bash
# Create workflow function
# Location: api/src/inngest/functions/my-workflow.ts

# Define trigger (event, cron, or webhook)
# Implement workflow logic with retries
# Register in api/src/inngest/index.ts
```

### 7. Local Development Setup

```bash
# Clone repository
git clone <repo-url>
cd mono

# Install dependencies
pnpm install

# Copy environment variables
cp .env.example .env
# Edit .env with your configuration

# Start MongoDB
pnpm docker:up

# Run migrations
pnpm migrate

# Start development servers
pnpm dev
# Frontend: http://localhost:5173
# Backend: http://localhost:8080
# Inngest: http://localhost:8288
```

## Technology Stack Details

### Backend Technologies

| Technology | Version | Purpose |
|------------|---------|---------|
| Node.js | 20+ | Runtime environment |
| TypeScript | 5.8.3 | Type-safe JavaScript |
| Hono | 4.7.11 | Lightweight web framework |
| Mongoose | 8.15.1 | MongoDB ODM |
| Arctic | 3.7.0 | OAuth authentication |
| Inngest | 3.39.2 | Event-driven workflows |
| Vercel AI SDK | 6.0.0-beta | LLM abstraction layer |
| OpenAI SDK | 5.2 | GPT integration |
| Anthropic SDK | 3.0.0-beta | Claude integration |
| Google AI SDK | 3.0.0-beta | Gemini integration |

### Frontend Technologies

| Technology | Version | Purpose |
|------------|---------|---------|
| React | 18.2.0 | UI framework |
| Vite | 5.0.8 | Build tool and dev server |
| TypeScript | 5.2.2 | Type-safe JavaScript |
| MUI | 7.1.0 | Component library |
| Zustand | 5.0.5 | State management |
| React Router | 6.29.2 | Client-side routing |
| Monaco Editor | 4.6.0 | Code editor (VS Code) |
| Axios | 1.6.2 | HTTP client |
| React Hook Form | 7.57.0 | Form handling |

### Database & Storage

| Technology | Purpose |
|------------|---------|
| MongoDB | Primary metadata store |
| PostgreSQL | Supported query target |
| BigQuery | Google Cloud data warehouse |
| ClickHouse | OLAP database |
| MySQL | Supported query target |
| SQLite | Lightweight SQL database |
| MSSQL | Microsoft SQL Server |
| Cloudflare D1 | Edge SQLite database |
| Cloudflare KV | Edge key-value store |

### Development Tools

| Tool | Purpose |
|------|---------|
| ESLint | Code linting |
| Prettier | Code formatting |
| Husky | Git hooks |
| lint-staged | Pre-commit validation |
| Docker | Containerization |
| PNPM | Package manager |

## Important Notes for AI Assistants

### When Working with This Codebase:

1. **Always check workspace scoping** - All data operations must be scoped to the current workspace
2. **Use existing patterns** - Follow established patterns for connectors, drivers, components, and stores
3. **Encrypt sensitive data** - Use the encryption utilities for API keys, connection strings, and credentials
4. **Apply proper middleware** - Auth before workspace context, workspace context before business logic
5. **Prefer Zustand over Context API** - For state management, use Zustand stores
6. **Use TypeScript strictly** - Avoid `any` types, leverage interfaces and type inference
7. **Follow MUI v7 patterns** - Use MUI components consistently across the frontend
8. **Implement retry logic** - Add exponential backoff for external API calls and database connections
9. **Support query cancellation** - Use AbortSignal in database drivers and API calls
10. **Test multi-tenant isolation** - Ensure workspace boundaries are respected in all operations

### Recent Improvements:

- SQL autocomplete enhanced with fresh state management
- ClickHouse database driver added
- Query cancellation support across all drivers
- Connection resilience with retry logic
- Workspace selector UI improvements
- Default model updated to GPT-5.2

### Legacy Systems to Be Aware Of:

- **Legacy sync CLI** (`/sync/cli.ts`) - Being replaced by Inngest workflows
- **config.yaml** - Data sources now managed via UI, but legacy support remains
- **Lucia Auth references** - Now using Arctic for OAuth (docs may still reference Lucia)
