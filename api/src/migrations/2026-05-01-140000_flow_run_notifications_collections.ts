import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Create notification_rules and notification_deliveries collections with indexes";

function hasIndexOnKeys(
  indexes: { key: Record<string, number> }[],
  keyPattern: Record<string, number>,
): boolean {
  const target = JSON.stringify(keyPattern);
  return indexes.some(idx => JSON.stringify(idx.key) === target);
}

export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  if (!collectionNames.includes("notification_rules")) {
    await db.createCollection("notification_rules");
    log.info("Created notification_rules collection");
  }

  if (!collectionNames.includes("notification_deliveries")) {
    await db.createCollection("notification_deliveries");
    log.info("Created notification_deliveries collection");
  }

  const rules = db.collection("notification_rules");
  const ruleIndexes = await rules.listIndexes().toArray();

  if (
    !hasIndexOnKeys(ruleIndexes, {
      workspaceId: 1,
      resourceType: 1,
      resourceId: 1,
      enabled: 1,
    })
  ) {
    await rules.createIndex(
      { workspaceId: 1, resourceType: 1, resourceId: 1, enabled: 1 },
      { name: "workspace_resource_enabled_idx" },
    );
  }

  const deliveries = db.collection("notification_deliveries");
  const deliveryIndexes = await deliveries.listIndexes().toArray();

  if (
    !hasIndexOnKeys(deliveryIndexes, {
      workspaceId: 1,
      resourceType: 1,
      resourceId: 1,
      completedAt: -1,
    })
  ) {
    await deliveries.createIndex(
      { workspaceId: 1, resourceType: 1, resourceId: 1, completedAt: -1 },
      { name: "workspace_resource_completed_idx" },
    );
  }

  if (
    !hasIndexOnKeys(deliveryIndexes, {
      idempotencyKey: 1,
    })
  ) {
    await deliveries.createIndex(
      { idempotencyKey: 1 },
      { name: "idempotency_key_unique_idx", unique: true },
    );
  }

  if (!hasIndexOnKeys(deliveryIndexes, { createdAt: 1 })) {
    await deliveries.createIndex(
      { createdAt: 1 },
      {
        name: "notification_deliveries_ttl_idx",
        expireAfterSeconds: 7776000,
      },
    );
  }
}
