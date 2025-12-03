# MongoDB Migrations

A simple, robust migration system for managing MongoDB schema changes.

## Quick Start

```bash
# Create a new migration
pnpm run migrate create "add user indexes"

# Check migration status
pnpm run migrate status

# Run all pending migrations
pnpm run migrate
```

## Migration File Format

Each migration is a TypeScript file in `api/src/migrations/` with the naming pattern:

```
yyyy-mm-dd-hhmmss_descriptive_name.ts
```

Example: `2024-12-03-143022_add_workspace_indexes.ts`

### Structure

```typescript
import { Db } from "mongodb";

export const description = "Short description of what this migration does";

export async function up(db: Db): Promise<void> {
  // Your migration logic here
}
```

The `description` export is optional but recommended for documentation.

## Common Migration Patterns

### Create an Index

```typescript
export async function up(db: Db): Promise<void> {
  await db.collection("users").createIndex({ email: 1 }, { unique: true });
}
```

### Create Multiple Indexes

```typescript
export async function up(db: Db): Promise<void> {
  const users = db.collection("users");
  
  await Promise.all([
    users.createIndex({ email: 1 }, { unique: true }),
    users.createIndex({ createdAt: -1 }),
    users.createIndex({ workspaceId: 1, role: 1 }),
  ]);
}
```

### Add a Field with Default Value

```typescript
export async function up(db: Db): Promise<void> {
  await db.collection("workspaces").updateMany(
    { settings: { $exists: false } },
    { $set: { settings: { theme: "light", notifications: true } } }
  );
}
```

### Rename a Field

```typescript
export async function up(db: Db): Promise<void> {
  await db.collection("users").updateMany(
    {},
    { $rename: { "oldFieldName": "newFieldName" } }
  );
}
```

### Create a New Collection with Validation

```typescript
export async function up(db: Db): Promise<void> {
  await db.createCollection("audit_logs", {
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["action", "userId", "timestamp"],
        properties: {
          action: { bsonType: "string" },
          userId: { bsonType: "string" },
          timestamp: { bsonType: "date" },
        },
      },
    },
  });
  
  await db.collection("audit_logs").createIndex({ timestamp: -1 });
}
```

### Data Migration

```typescript
export async function up(db: Db): Promise<void> {
  const cursor = db.collection("old_collection").find({});
  
  const batch: any[] = [];
  const BATCH_SIZE = 1000;
  
  for await (const doc of cursor) {
    batch.push({
      insertOne: {
        document: {
          _id: doc._id,
          // Transform data as needed
          newField: doc.oldField?.toUpperCase(),
        },
      },
    });
    
    if (batch.length >= BATCH_SIZE) {
      await db.collection("new_collection").bulkWrite(batch);
      batch.length = 0;
    }
  }
  
  if (batch.length > 0) {
    await db.collection("new_collection").bulkWrite(batch);
  }
}
```

## How It Works

1. **Migration Discovery**: The runner scans `api/src/migrations/` for `.ts` files matching the naming pattern
2. **Status Tracking**: Migration status is stored in the `migrations` collection in your app database
3. **Execution**: Migrations run sequentially in lexicographic order (oldest first)
4. **Idempotency**: Each migration runs exactly once; re-running `migrate` skips completed migrations

## Database Schema

The `migrations` collection stores:

```typescript
{
  _id: string;           // Migration ID (filename without .ts)
  ran_at: Date | null;   // Timestamp when completed (null = pending)
  duration_ms?: number;  // Execution time in milliseconds
  error?: string;        // Error message if failed
}
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `pnpm run migrate` | Run all pending migrations |
| `pnpm run migrate status` | Show status of all migrations |
| `pnpm run migrate create "name"` | Create a new migration file |

## Deployment

Migrations run automatically as part of the deploy process (`./deploy.sh`). After the Cloud Run service is updated, the script runs `pnpm run migrate` against the production database.

If you need to run migrations manually in production:

```bash
# Ensure your .env has the production DATABASE_URL
pnpm run migrate
```

## Best Practices

1. **Keep migrations small**: One logical change per migration
2. **Make migrations idempotent**: Use `$exists` checks, `{ upsert: true }`, etc.
3. **Test locally first**: Run against a development database before production
4. **Don't modify old migrations**: Create a new migration to fix issues
5. **Use descriptive names**: `add_user_email_index` > `update_users`
6. **Add descriptions**: Future you will thank present you
7. **Commit migrations before deploying**: Migrations must be in the codebase to run

## No Down Migrations

This system intentionally does not support down/rollback migrations. Rationale:

- Down migrations are rarely tested and often broken when needed
- MongoDB schema changes are usually additive (new fields, indexes)
- For data issues, create a new "fix" migration instead
- For emergencies, restore from backup

## Troubleshooting

### Migration Failed

If a migration fails, it will be marked with an error in the `migrations` collection. Fix the issue in your migration file and run `pnpm run migrate` again—it will retry failed migrations.

### Stuck Migration

If you need to manually mark a migration as complete:

```javascript
db.migrations.updateOne(
  { _id: "2024-12-03-143022_problematic_migration" },
  { $set: { ran_at: new Date() }, $unset: { error: "" } }
)
```

### Skip a Migration

To permanently skip a migration, mark it as complete without running it:

```javascript
db.migrations.insertOne({
  _id: "2024-12-03-143022_skip_this",
  ran_at: new Date(),
  duration_ms: 0
})
```

