import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Create query_executions collection with indexes for usage analytics";

/**
 * Migration: Create query_executions collection
 *
 * This collection tracks all query executions for:
 * - Usage analytics and billing
 * - Per-user and per-workspace usage monitoring
 * - API key usage tracking
 * - Error rate monitoring
 *
 * Indexes:
 * - workspaceId + executedAt: Usage over time per workspace
 * - userId + executedAt: Per-user analytics
 * - apiKeyId + executedAt (sparse): API key usage
 * - workspaceId + status: Error rate monitoring
 * - executedAt (TTL): Auto-cleanup after 90 days
 */
export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  // Create collection if it doesn't exist
  if (!collectionNames.includes("query_executions")) {
    await db.createCollection("query_executions");
    log.info("✅ Created 'query_executions' collection");
  } else {
    log.info("ℹ️  Collection 'query_executions' already exists");
  }

  const collection = db.collection("query_executions");

  // Helper function to check if an index with specific key exists
  const indexExists = async (keyPattern: any): Promise<boolean> => {
    const indexes = await collection.listIndexes().toArray();
    return indexes.some(idx => {
      const keys = Object.keys(idx.key);
      const patternKeys = Object.keys(keyPattern);
      if (keys.length !== patternKeys.length) return false;
      return keys.every(key => idx.key[key] === keyPattern[key]);
    });
  };

  // Create indexes
  // Note: We check for existing indexes to avoid conflicts with different names

  // Usage over time per workspace
  if (!(await indexExists({ workspaceId: 1, executedAt: -1 }))) {
    await collection.createIndex(
      { workspaceId: 1, executedAt: -1 },
      { name: "workspace_time_idx" },
    );
    log.info("✅ Created index: workspace_time_idx");
  } else {
    log.info("ℹ️  Index workspace_time_idx already exists (or equivalent)");
  }

  // Per-user analytics
  if (!(await indexExists({ userId: 1, executedAt: -1 }))) {
    await collection.createIndex(
      { userId: 1, executedAt: -1 },
      { name: "user_time_idx" },
    );
    log.info("✅ Created index: user_time_idx");
  } else {
    log.info("ℹ️  Index user_time_idx already exists (or equivalent)");
  }

  // API key usage (sparse - only for API key executions)
  if (!(await indexExists({ apiKeyId: 1, executedAt: -1 }))) {
    await collection.createIndex(
      { apiKeyId: 1, executedAt: -1 },
      { name: "apikey_time_idx", sparse: true },
    );
    log.info("✅ Created index: apikey_time_idx (sparse)");
  } else {
    log.info("ℹ️  Index apikey_time_idx already exists (or equivalent)");
  }

  // Error rate monitoring
  if (!(await indexExists({ workspaceId: 1, status: 1 }))) {
    await collection.createIndex(
      { workspaceId: 1, status: 1 },
      { name: "workspace_status_idx" },
    );
    log.info("✅ Created index: workspace_status_idx");
  } else {
    log.info("ℹ️  Index workspace_status_idx already exists (or equivalent)");
  }

  // TTL index for auto-cleanup (90 days = 7776000 seconds)
  if (!(await indexExists({ executedAt: 1 }))) {
    await collection.createIndex(
      { executedAt: 1 },
      { name: "ttl_idx", expireAfterSeconds: 7776000 },
    );
    log.info("✅ Created TTL index: ttl_idx (90 days retention)");
  } else {
    log.info("ℹ️  Index ttl_idx already exists (or equivalent)");
  }

  log.info("✅ Migration complete: query_executions collection ready");
}

/**
 * Rollback: Drop query_executions collection
 *
 * Warning: This will delete all query execution history.
 * Only run this if you're sure you want to remove usage tracking.
 */
export async function down(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  if (collectionNames.includes("query_executions")) {
    await db.dropCollection("query_executions");
    log.info("✅ Dropped 'query_executions' collection");
  } else {
    log.info("ℹ️  Collection 'query_executions' not found, nothing to drop");
  }
}
