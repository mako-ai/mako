---
name: add-database-driver
description: Scaffold a new database driver for the Mako multi-database query execution system. Use when adding support for a new database type.
---

# Add a New Database Driver

## Overview

Database drivers implement the `DatabaseDriver` interface and are registered in the driver registry. They enable query execution, schema introspection, and tree navigation for a database type.

## Steps

### 1. Create the driver directory

```bash
mkdir -p api/src/databases/drivers/<name>
```

### 2. Implement the driver

Create `api/src/databases/drivers/<name>/index.ts`:

```typescript
import {
  DatabaseDriver,
  DatabaseDriverMetadata,
  DatabaseTreeNode,
} from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";

export class MyDbDriver implements DatabaseDriver {
  getMetadata(): DatabaseDriverMetadata {
    return {
      type: "mydb",
      name: "MyDB",
      description: "MyDB database driver",
      icon: "mydb",
    };
  }

  async getTreeRoot(database: IDatabaseConnection): Promise<DatabaseTreeNode[]> {
    // Return top-level tree nodes (databases, schemas, etc.)
  }

  async getChildren(
    database: IDatabaseConnection,
    parent: { kind: string; id: string; metadata?: any },
  ): Promise<DatabaseTreeNode[]> {
    // Return child nodes for the tree explorer
  }

  async executeQuery(
    database: IDatabaseConnection,
    query: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ success: boolean; data?: any; error?: string; rowCount?: number }> {
    // Execute the query, respect options.signal for cancellation
  }

  async cancelQuery?(executionId: string): Promise<{ success: boolean; error?: string }> {
    // Cancel a running query if supported
  }

  // Optional: implement supportsWrites(), insertBatch(), etc.
}
```

### 3. Register the driver

Edit `api/src/databases/registry.ts` and add the registration:

```typescript
import { MyDbDriver } from "./drivers/mydb";

// In the initialization section:
databaseRegistry.register(new MyDbDriver());
```

### 4. Test

1. Start dev server: `pnpm dev`
2. Add a database connection of the new type in the UI
3. Verify tree navigation works
4. Execute test queries
5. Verify query cancellation works via AbortSignal

## Required Methods

| Method | Required | Purpose |
|--------|----------|---------|
| `getMetadata()` | Yes | Returns driver type, name, description |
| `getTreeRoot()` | Yes | Top-level tree nodes for database explorer |
| `getChildren()` | Yes | Child nodes for tree expansion |
| `executeQuery()` | Yes | Query execution with AbortSignal support |
| `cancelQuery()` | No | Cancel running queries |
| `getAutocompleteData()` | No | Schema info for SQL autocomplete |
| `supportsWrites()` | No | Enable write operations |
| `insertBatch()` | No | Batch insert for sync targets |

## Key Rules

- Always support query cancellation via `AbortSignal` in `executeQuery`.
- Implement connection pooling if the database client supports it.
- Add retry logic with exponential backoff for transient connection failures.
- Connection strings are encrypted at rest — use `database-connection.service.ts` to resolve connections.

## Reference Files

- Interface: `api/src/databases/driver.ts`
- Registry: `api/src/databases/registry.ts`
- Existing example: `api/src/databases/drivers/postgresql/`
- Connection service: `api/src/services/database-connection.service.ts`
