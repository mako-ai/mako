---
name: create-migration
description: Create a new MongoDB migration for schema or data changes in Mako. Use when adding fields, indexes, or modifying data in the database.
---

# Create a Database Migration

## Overview

Mako uses a custom MongoDB migration system. Migrations are TypeScript files in `api/src/migrations/` that run sequentially and are tracked in a `migrations` collection.

## Steps

### 1. Generate the migration file

```bash
pnpm migrate create "description_of_change"
```

This creates a file matching `yyyy-mm-dd-hhmmss_description_of_change.ts`.

### 2. Implement the `up` function

Edit the generated file:

```typescript
import { Db } from "mongodb";

export const description = "Add email index to users collection";

export async function up(db: Db): Promise<void> {
  // MUST be idempotent — safe to re-run
  const indexes = await db.collection("users").indexes();
  const hasIndex = indexes.some(
    idx => JSON.stringify(idx.key) === JSON.stringify({ email: 1 }),
  );
  if (!hasIndex) {
    await db.collection("users").createIndex({ email: 1 });
  }
}
```

### 3. Run the migration locally

```bash
pnpm migrate        # Run pending migrations
pnpm migrate status # Verify it was applied
```

## Idempotency Patterns

### Adding an index (check by key pattern, NOT name)

```typescript
const indexes = await db.collection("items").indexes();
const hasIndex = indexes.some(
  idx =>
    JSON.stringify(idx.key) ===
    JSON.stringify({ workspaceId: 1, createdAt: -1 }),
);
if (!hasIndex) {
  await db
    .collection("items")
    .createIndex(
      { workspaceId: 1, createdAt: -1 },
      { name: "items_workspace_created" },
    );
}
```

An index may already exist with an auto-generated name (from Mongoose or a partial run). Checking by name will miss it and `createIndex` will throw `IndexOptionsConflict`.

### Adding a field with default value

```typescript
await db
  .collection("users")
  .updateMany(
    { newField: { $exists: false } },
    { $set: { newField: "default_value" } },
  );
```

### Renaming a field

```typescript
await db
  .collection("items")
  .updateMany(
    { oldField: { $exists: true } },
    { $rename: { oldField: "newField" } },
  );
```

## Key Rules

- **Naming**: `yyyy-mm-dd-hhmmss_snake_case_name.ts`
- **One change per migration**: Keep migrations focused and small
- **Always idempotent**: Use `$exists` checks, upserts, and key-pattern index checks
- **Never edit old migrations**: Create a new migration to fix issues
- **No down migrations**: This system is up-only by design
- **Test locally first**: Run against dev database before deploying

## Deployment

Migrations run automatically after deploy via GitHub Actions. If a migration fails, the deploy exits with error but the service is already deployed.

## Reference Files

- Migration runner: `api/src/migrations/runner.ts`
- Migration CLI: `api/src/migrations/cli.ts`
- Full docs: `api/src/migrations/README.md`
- Migration rules: `.cursor/rules/90-migrations.mdc`
