import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Rename syncjobs to flows, job_executions to flow_executions, job_execution_locks to flow_execution_locks, jobId to flowId, and fix status spelling (canceled → cancelled)";

/**
 * Migration: Rename SyncJobs to Flows
 *
 * This migration renames:
 * 1. syncjobs collection → flows
 * 2. job_executions collection → flow_executions
 * 3. job_execution_locks collection → flow_execution_locks
 * 4. jobId field → flowId in flow_executions and webhookevents
 * 5. status "canceled" → "cancelled" in flow_executions (spelling normalization)
 */
export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  // 1. Rename syncjobs → flows
  if (collectionNames.includes("syncjobs")) {
    if (collectionNames.includes("flows")) {
      log.warn(
        "⚠️  Both 'syncjobs' and 'flows' collections exist. Skipping syncjobs rename.",
      );
    } else {
      await db.collection("syncjobs").rename("flows");
      log.info("✅ Renamed collection: syncjobs → flows");
    }
  } else if (collectionNames.includes("flows")) {
    log.info("ℹ️  Collection 'flows' already exists, skipping rename.");
  } else {
    log.info("ℹ️  Collection 'syncjobs' not found, nothing to rename.");
  }

  // 2. Rename job_executions → flow_executions
  if (collectionNames.includes("job_executions")) {
    if (collectionNames.includes("flow_executions")) {
      log.warn(
        "⚠️  Both 'job_executions' and 'flow_executions' collections exist. Skipping rename.",
      );
    } else {
      await db.collection("job_executions").rename("flow_executions");
      log.info("✅ Renamed collection: job_executions → flow_executions");
    }
  } else if (collectionNames.includes("flow_executions")) {
    log.info(
      "ℹ️  Collection 'flow_executions' already exists, skipping rename.",
    );
  } else {
    log.info("ℹ️  Collection 'job_executions' not found, nothing to rename.");
  }

  // 3. Rename job_execution_locks → flow_execution_locks
  if (collectionNames.includes("job_execution_locks")) {
    if (collectionNames.includes("flow_execution_locks")) {
      log.warn(
        "⚠️  Both 'job_execution_locks' and 'flow_execution_locks' collections exist. Skipping rename.",
      );
    } else {
      await db.collection("job_execution_locks").rename("flow_execution_locks");
      log.info(
        "✅ Renamed collection: job_execution_locks → flow_execution_locks",
      );
    }
  } else if (collectionNames.includes("flow_execution_locks")) {
    log.info(
      "ℹ️  Collection 'flow_execution_locks' already exists, skipping rename.",
    );
  } else {
    log.info(
      "ℹ️  Collection 'job_execution_locks' not found, nothing to rename.",
    );
  }

  // 4. Rename jobId → flowId in flow_executions
  // Re-fetch collection names after renames
  const updatedCollections = await db.listCollections().toArray();
  const updatedCollectionNames = updatedCollections.map(c => c.name);

  if (updatedCollectionNames.includes("flow_executions")) {
    const flowExecResult = await db
      .collection("flow_executions")
      .updateMany(
        { jobId: { $exists: true }, flowId: { $exists: false } },
        { $rename: { jobId: "flowId" } },
      );
    log.info(
      `✅ Renamed field jobId → flowId in flow_executions: ${flowExecResult.modifiedCount} documents updated`,
    );

    // 4b. Update status spelling: "canceled" (American) → "cancelled" (British)
    // The old schema used "canceled", new schema uses "cancelled"
    const statusResult = await db
      .collection("flow_executions")
      .updateMany({ status: "canceled" }, { $set: { status: "cancelled" } });
    if (statusResult.modifiedCount > 0) {
      log.info(
        `✅ Updated status spelling "canceled" → "cancelled" in flow_executions: ${statusResult.modifiedCount} documents updated`,
      );
    } else {
      log.info(
        'ℹ️  No documents with status "canceled" found in flow_executions, skipping status update.',
      );
    }
  } else {
    log.info(
      "ℹ️  Collection 'flow_executions' not found, skipping field rename.",
    );
  }

  // 5. Rename jobId → flowId in webhookevents
  if (updatedCollectionNames.includes("webhookevents")) {
    const webhookResult = await db
      .collection("webhookevents")
      .updateMany(
        { jobId: { $exists: true }, flowId: { $exists: false } },
        { $rename: { jobId: "flowId" } },
      );
    log.info(
      `✅ Renamed field jobId → flowId in webhookevents: ${webhookResult.modifiedCount} documents updated`,
    );
  } else {
    log.info(
      "ℹ️  Collection 'webhookevents' not found, skipping field rename.",
    );
  }

  log.info("Migration complete: SyncJobs → Flows");
}
