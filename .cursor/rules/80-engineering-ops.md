# Engineering Ops

## Logging

**NEVER use `console.log`, `console.error`, `console.warn`, or `console.debug` directly in API code.** Use the structured logging system instead.

```typescript
import { loggers } from "../logging";

// Pre-configured loggers by category
const log = loggers.sync();       // Sync operations
const log = loggers.migration();  // Database migrations
const log = loggers.db();         // Database operations
const log = loggers.auth();       // Authentication
const log = loggers.agent();      // AI agent operations
const log = loggers.http();       // HTTP request/response
const log = loggers.query();      // Query execution
const log = loggers.workspace();  // Workspace operations
const log = loggers.connector();  // Data connectors
const log = loggers.inngest();    // Inngest/flow operations
const log = loggers.app();        // Application lifecycle

// Usage examples
log.info("Operation completed", { userId, duration_ms: 150 });
log.error("Failed to process", { error, context });
log.debug("Debug info", { details });
log.warn("Warning condition", { threshold });
```

**Exceptions** (add `/* eslint-disable no-console */` at file top):
- Logging sinks in `/api/src/logging/sinks/` (they ARE the console output)
- Interactive CLI demos (`demo-interactive.ts`, `example-programmatic.ts`)

For full details: [LOGTAPE_IMPLEMENTATION.md](mdc:LOGTAPE_IMPLEMENTATION.md)

## Other Guidelines

- Testing auth: use [AUTH_TESTING_CHECKLIST.md](mdc:AUTH_TESTING_CHECKLIST.md) when adding/changing protected routes.
- Database migrations: see [DATABASE_MIGRATION.md](mdc:DATABASE_MIGRATION.md) and update schemas accordingly.
- Console API docs: [CONSOLE_API_DOCUMENTATION.md](mdc:CONSOLE_API_DOCUMENTATION.md) for integration boundaries.

## Rules

- Do not log secrets, API keys, or tokens.
- Fail fast on configuration errors; validate required env at startup.
- Prefer background processing (Inngest) for slow operations.
- Always include relevant context (workspace ID, user ID, request ID) in log messages.
