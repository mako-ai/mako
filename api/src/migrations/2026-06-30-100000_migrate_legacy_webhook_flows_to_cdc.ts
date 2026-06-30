import { Db, ObjectId } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Migrate legacy webhook flows to the CDC engine (decommission of the legacy real-time webhook pipeline)";

// Destination types that have a CDC destination adapter. Kept inline (instead
// of importing the adapter registry) so the migration has no runtime deps on
// adapter modules. Mirror of `hasCdcDestinationAdapter` in
// api/src/sync-cdc/adapters/registry.ts.
const CDC_CAPABLE_TYPES = new Set([
  "bigquery",
  "clickhouse",
  "postgresql",
  "mongodb",
]);

export async function up(db: Db): Promise<void> {
  const flows = db.collection("flows");
  const connections = db.collection("databaseconnections");

  // Webhook flows still on the legacy engine (or with no engine set).
  const legacyWebhookFlows = await flows
    .find({
      type: "webhook",
      $or: [{ syncEngine: { $ne: "cdc" } }, { syncEngine: { $exists: false } }],
    })
    .project({ _id: 1, tableDestination: 1, streamState: 1, backfillState: 1 })
    .toArray();

  let migrated = 0;
  const needsManualReview: string[] = [];

  for (const flow of legacyWebhookFlows) {
    const connectionId = flow.tableDestination?.connectionId as
      | ObjectId
      | undefined;

    let destinationType: string | undefined;
    if (connectionId) {
      const conn = await connections.findOne(
        { _id: new ObjectId(connectionId) },
        { projection: { type: 1 } },
      );
      destinationType =
        typeof conn?.type === "string" ? conn.type.toLowerCase() : undefined;
    }

    const cdcCapable =
      Boolean(connectionId) &&
      Boolean(destinationType) &&
      CDC_CAPABLE_TYPES.has(destinationType as string);

    if (!cdcCapable) {
      // No CDC-capable table destination (e.g. a pure Mongo-collection
      // webhook flow). These cannot be migrated automatically — the legacy
      // real-time path that handled them has been removed. Flag for manual
      // review (re-point to a CDC-capable destination, or delete the flow).
      needsManualReview.push(flow._id.toString());
      continue;
    }

    await flows.updateOne(
      { _id: flow._id },
      {
        $set: {
          syncEngine: "cdc",
          streamState: flow.streamState || "idle",
          "backfillState.status": flow.backfillState?.status || "idle",
          syncStateUpdatedAt: new Date(),
          syncStateMeta: {
            lastEvent: "ENGINE_SWITCH",
            lastReason: "Migrated from legacy webhook engine to CDC",
          },
        },
      },
    );
    migrated++;
  }

  log.info("Migrated legacy webhook flows to CDC", {
    totalLegacyWebhookFlows: legacyWebhookFlows.length,
    migrated,
    needsManualReview: needsManualReview.length,
  });

  if (needsManualReview.length > 0) {
    log.warn(
      "Some legacy webhook flows have no CDC-capable destination and were NOT migrated. " +
        "Their inbound webhooks will be dropped until they are re-pointed to a CDC-capable " +
        "destination (BigQuery/PostgreSQL/ClickHouse/MongoDB table) or deleted.",
      { flowIds: needsManualReview },
    );
  }
}
