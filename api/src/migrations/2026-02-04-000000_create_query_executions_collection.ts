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

  // Create indexes
  // Note: createIndex is idempotent - it won't fail if index already exists

  // Usage over time per workspace
  await collection.createIndex(
    { workspaceId: 1, executedAt: -1 },
    { name: "workspace_time_idx" },
  );
  log.info("✅ Created index: workspace_time_idx");

  // Per-user analytics
  await collection.createIndex(
    { userId: 1, executedAt: -1 },
    { name: "user_time_idx" },
  );
  log.info("✅ Created index: user_time_idx");

  // API key usage (sparse - only for API key executions)
  await collection.createIndex(
    { apiKeyId: 1, executedAt: -1 },
    { name: "apikey_time_idx", sparse: true },
  );
  log.info("✅ Created index: apikey_time_idx (sparse)");

  // Error rate monitoring
  await collection.createIndex(
    { workspaceId: 1, status: 1 },
    { name: "workspace_status_idx" },
  );
  log.info("✅ Created index: workspace_status_idx");

  // TTL index for auto-cleanup (90 days = 7776000 seconds)
  await collection.createIndex(
    { executedAt: 1 },
    { name: "ttl_idx", expireAfterSeconds: 7776000 },
  );
  log.info("✅ Created TTL index: ttl_idx (90 days retention)");

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
