import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Move queries from GraphQL/PostHog connectors to their first matching SyncJob transfer";

/**
 * Migration: Move queries from connector.config.queries to syncjob.queries
 *
 * For GraphQL and PostHog connectors, the queries define what data to sync.
 * This migration moves those queries from the connector level (which should
 * only contain credentials) to the transfer/SyncJob level (which defines
 * what data to sync and where).
 *
 * Logic:
 * 1. Find all GraphQL and PostHog connectors that have queries in config
 * 2. For each connector, find all SyncJobs referencing it
 * 3. Move queries to the first SyncJob (if any)
 * 4. Remove queries from connector config
 */
export async function up(db: Db): Promise<void> {
  const connectorsCollection = db.collection("connectors");
  const syncJobsCollection = db.collection("syncjobs");

  // Find connectors with queries that need to be migrated
  const connectorsWithQueries = await connectorsCollection
    .find({
      type: { $in: ["graphql", "posthog"] },
      "config.queries": { $exists: true, $ne: [] },
    })
    .toArray();

  log.info(
    `Found ${connectorsWithQueries.length} connectors with queries to migrate`,
  );

  let migratedCount = 0;
  let noTransferCount = 0;

  for (const connector of connectorsWithQueries) {
    const queries = connector.config?.queries;
    if (!queries || !Array.isArray(queries) || queries.length === 0) {
      continue;
    }

    // Find the first SyncJob that references this connector
    const syncJob = await syncJobsCollection.findOne({
      dataSourceId: connector._id,
    });

    if (syncJob) {
      // Move queries to the SyncJob
      await syncJobsCollection.updateOne(
        { _id: syncJob._id },
        {
          $set: {
            queries: queries,
          },
        },
      );

      // Remove queries from connector config
      await connectorsCollection.updateOne(
        { _id: connector._id },
        {
          $unset: {
            "config.queries": "",
          },
        },
      );

      log.info(
        `Migrated ${queries.length} queries from connector "${connector.name}" (${connector._id}) to SyncJob ${syncJob._id}`,
      );
      migratedCount++;
    } else {
      // No SyncJob found - keep queries in connector for now
      // They'll be moved when a transfer is created
      log.info(
        `No SyncJob found for connector "${connector.name}" (${connector._id}) - keeping queries in connector`,
      );
      noTransferCount++;
    }
  }

  log.info("Migration complete:", {
    migrated: migratedCount,
    skipped: noTransferCount,
  });
}
