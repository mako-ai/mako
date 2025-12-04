# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RevOps is a multi-tenant data analytics platform built with a PNPM workspace monorepo structure. It combines external data source integration (Stripe, Close CRM, GraphQL APIs), database query execution, AI-powered chat assistance, and real-time data synchronization.

**Architecture:** Three main packages:

- **Root**: Data sync scripts and configuration
- **API**: Hono-based backend server (Node.js 20+, TypeScript, MongoDB, Lucia Auth)
- **App**: React/Vite frontend (React 18, MUI v7, Zustand, Monaco Editor)

## Essential Commands

### Development

```bash
pnpm dev                    # Start both frontend (5173) and backend (8080)
pnpm app:dev               # Frontend only
pnpm api:dev               # Backend only
```

### Building & Production

```bash
pnpm build                 # Lint + build entire project
pnpm start                 # Production server
pnpm lint:all              # Lint all packages
pnpm lint:fix:all          # Fix linting issues
```

### Data Operations

```bash
pnpm docker:up             # Start MongoDB and services
pnpm docker:down           # Stop all services
pnpm sync <source>         # Sync data from external sources
pnpm query <query_file>    # Run MongoDB queries
```

### Database Migrations

```bash
pnpm migrate               # Run all pending migrations
pnpm migrate status        # Show migration status
pnpm migrate create "name" # Create a new migration file
```

Migrations are TypeScript files in `/api/src/migrations/` that run against MongoDB.
See `/api/src/migrations/README.md` for patterns and examples.

## Core Architecture Patterns

### Multi-Tenant Workspace System

- Each user belongs to one or more workspaces with roles (owner, admin, member, viewer)
- All data (databases, queries, data sources) is scoped to workspaces
- Authentication via Lucia Auth with OAuth providers (Google, GitHub)
- Invitation system with email-based workflow

### Data Connector Architecture

- Pluggable connector system in `/api/src/connectors/`
- Base connector class with registry pattern for dynamic loading
- Supported sources: Stripe, Close CRM, GraphQL APIs
- Encrypted credential storage in MongoDB

### State Management (Frontend)

- **Zustand stores** for feature-based state separation (`/app/src/store/`)
- Key stores: workspace, user, database, console, dataSource
- TypeScript with full type safety

### Database Integration

- **Multi-database support**: MongoDB, PostgreSQL, MySQL, SQLite, MSSQL
- **Connection management**: Encrypted connection strings, pooling
- **Query execution**: SQL, MongoDB queries, and JavaScript with Monaco Editor
- **Result handling**: MUI X Data Grid Premium for visualization

### API Architecture (Backend)

- **Hono framework** with middleware pattern
- **Service layer** separation in `/api/src/services/`
- **Repository pattern** for database abstraction
- **Security**: Session-based auth with HTTP-only cookies, encryption at rest

## Key Directories

- `/api/src/database/` - MongoDB schemas and models
- `/api/src/connectors/` - External API connector implementations
- `/api/src/migrations/` - Database migration files (see README.md inside)
- `/app/src/components/` - React components organized by feature
- `/app/src/store/` - Zustand state management stores
- `/consoles/` - Pre-built analytics queries and scripts
- `/scripts/` - Utility scripts

## Configuration

### Environment Variables (.env)

```env
DATABASE_URL=mongodb://localhost:27017/myapp
MONGODB_CONNECTION_STRING=mongodb://localhost:27018
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
CLOSE_API_KEY_SPAIN=your_api_key
STRIPE_API_KEY_SPAIN=your_api_key
OPENAI_API_KEY=your_openai_key
BASE_URL=http://localhost:8080
CLIENT_URL=http://localhost:5173
SESSION_SECRET=generate_32_char_random_string
ENCRYPTION_KEY=32_byte_hex_key
```

### Data Sources

Data sources are managed through the web interface (stored in MongoDB). Legacy `config/config.yaml` support exists for migration purposes.

## Development Patterns

### Component Structure

- Follow existing MUI v7 patterns in `/app/src/components/`
- Use TypeScript interfaces defined in `/app/src/types/`
- Implement responsive design with MUI Grid2 system

### Error Handling

- Backend: Structured error responses with proper HTTP codes
- Frontend: User-friendly error boundaries and toast notifications
- Validation: Zod schemas for API request/response validation

### Security Considerations

- Never expose API keys or connection strings in client code
- Use encrypted storage for sensitive data source credentials
- Implement proper workspace-based authorization checks
- Session management through HTTP-only cookies

## Testing Strategy

Currently manual testing with comprehensive checklists:

- Authentication flow testing across OAuth providers
- Multi-tenant isolation verification
- Data source connection testing
- Query execution and result handling

## Deployment

- **Docker**: Multi-stage build, Node.js 20 base image, port 8080
- **Google Cloud Run**: Production deployment via `deploy.sh` or GitHub Actions
- **Static files**: Frontend served by API server in production
- **Migrations**: Run automatically after deploy (both `deploy.sh` and GitHub Actions)

## Common Workflows

1. **Adding new data sources**: Implement in `/api/src/connectors/`, register in connector registry
2. **New database connections**: Use encrypted connection storage, test with existing patterns
3. **Frontend components**: Follow MUI patterns, use Zustand for state, implement responsive design
4. **API endpoints**: Use Hono middleware, implement workspace context, add proper error handling
5. **Migrations**: Create with `pnpm migrate create "name"`, implement in `/api/src/migrations/`
