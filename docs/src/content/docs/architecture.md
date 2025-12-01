---
title: Architecture
description: High-level architecture of Mako.
---

Mako is built as a modern TypeScript monorepo using a specialized stack for performance and developer experience.

## System Components

### 1. Web Application (`app/`)

- **Framework**: Vite + React
- **Styling**: Tailwind CSS
- **State**: React Context + Hooks
- **Routing**: React Router

### 2. API Service (`api/`)

- **Runtime**: Node.js
- **Framework**: Hono (running on Node.js adapter)
- **Database**: MongoDB (Mongoose ODM)
- **Auth**: Lucia Auth + Arctic (OAuth)
- **Job Queue**: Inngest

### 3. Sync Engine

The Sync Engine is the heart of Mako. It is responsible for moving data from Sources (Stripe, CRM, etc.) to Destinations (Data Warehouse).

#### Chunked Sync Architecture

Mako uses a **Chunked Sync** pattern to handle large datasets reliably.

1.  **Connectors**: Each data source has a `Connector` implementation (extending `BaseConnector`).
2.  **Resumable Fetching**: Connectors implement `fetchEntityChunk` which returns a state cursor.
3.  **State Management**: The sync orchestrator saves the cursor after each chunk. If a job fails, it resumes from the last successful chunk.
4.  **Idempotency**: All sync operations are designed to be idempotent (upsert-based).

#### Connector Interface

Connectors are standardized via the `BaseConnector` abstract class.

```typescript
abstract class BaseConnector {
  // Fetch a single chunk of data, returning state to resume
  abstract fetchEntityChunk(
    options: ResumableFetchOptions,
  ): Promise<FetchState>;

  // Validate configuration
  abstract testConnection(): Promise<ConnectionTestResult>;
}
```

### 4. Query Runner

The Query Runner allows Mako to execute SQL (and other query languages) against connected data sources.

- It supports multiple drivers (BigQuery, Postgres, MongoDB).
- It uses a uniform interface to execute queries and return results to the AI Assistant or the UI.

### 5. AI Agent

Mako includes an AI Agent capable of:

1.  **Schema Inspection**: Understanding the structure of connected databases.
2.  **Query Generation**: Writing SQL/Mongo queries based on natural language.
3.  **Data Analysis**: interpreting query results for the user.
