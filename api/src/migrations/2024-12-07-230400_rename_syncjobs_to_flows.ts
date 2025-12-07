import { Db } from "mongodb";

export const description =
  "Rename syncjobs to flows, job_executions to flow_executions, and jobId to flowId";

/**
 * Migration: Rename SyncJobs to Flows
 *
 * This migration renames:
 * 1. syncjobs collection → flows
 * 2. job_executions collection → flow_executions
 * 3. jobId field → flowId in flow_executions and webhookevents
 */
export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  // 1. Rename syncjobs → flows
  if (collectionNames.includes("syncjobs")) {
    if (collectionNames.includes("flows")) {
      console.log(
        "⚠️  Both 'syncjobs' and 'flows' collections exist. Skipping syncjobs rename.",
      );
    } else {
      await db.collection("syncjobs").rename("flows");
      console.log("✅ Renamed collection: syncjobs → flows");
    }
  } else if (collectionNames.includes("flows")) {
    console.log("ℹ️  Collection 'flows' already exists, skipping rename.");
  } else {
    console.log("ℹ️  Collection 'syncjobs' not found, nothing to rename.");
  }

  // 2. Rename job_executions → flow_executions
  if (collectionNames.includes("job_executions")) {
    if (collectionNames.includes("flow_executions")) {
      console.log(
        "⚠️  Both 'job_executions' and 'flow_executions' collections exist. Skipping rename.",
      );
    } else {
      await db.collection("job_executions").rename("flow_executions");
      console.log("✅ Renamed collection: job_executions → flow_executions");
    }
  } else if (collectionNames.includes("flow_executions")) {
    console.log(
      "ℹ️  Collection 'flow_executions' already exists, skipping rename.",
    );
  } else {
    console.log(
      "ℹ️  Collection 'job_executions' not found, nothing to rename.",
    );
  }

  // 3. Rename jobId → flowId in flow_executions
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
    console.log(
      `✅ Renamed field jobId → flowId in flow_executions: ${flowExecResult.modifiedCount} documents updated`,
    );
  } else {
    console.log("ℹ️  Collection 'flow_executions' not found, skipping field rename.");
  }

  // 4. Rename jobId → flowId in webhookevents
  if (updatedCollectionNames.includes("webhookevents")) {
    const webhookResult = await db
      .collection("webhookevents")
      .updateMany(
        { jobId: { $exists: true }, flowId: { $exists: false } },
        { $rename: { jobId: "flowId" } },
      );
    console.log(
      `✅ Renamed field jobId → flowId in webhookevents: ${webhookResult.modifiedCount} documents updated`,
    );
  } else {
    console.log("ℹ️  Collection 'webhookevents' not found, skipping field rename.");
  }

  console.log("Migration complete: SyncJobs → Flows");
}

