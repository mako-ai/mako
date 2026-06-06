import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Create Reverse ETL collections and indexes for runs and outbound ledger";

function hasIndexOnKeys(
  indexes: { key: Record<string, number> }[],
  keyPattern: Record<string, number>,
): boolean {
  const target = JSON.stringify(keyPattern);
  return indexes.some(idx => JSON.stringify(idx.key) === target);
}

async function ensureCollection(db: Db, name: string): Promise<void> {
  const exists = await db.listCollections({ name }).hasNext();
  if (!exists) {
    await db.createCollection(name);
    log.info("Created collection", { name });
  }
}

export async function up(db: Db): Promise<void> {
  await ensureCollection(db, "reverse_flows");
  await ensureCollection(db, "reverse_flow_runs");
  await ensureCollection(db, "reverse_flow_ledger");

  const reverseFlows = db.collection("reverse_flows");
  const reverseFlowIndexes = await reverseFlows.listIndexes().toArray();
  if (!hasIndexOnKeys(reverseFlowIndexes, { workspaceId: 1, status: 1 })) {
    await reverseFlows.createIndex(
      { workspaceId: 1, status: 1 },
      { name: "reverse_flows_workspace_status_idx" },
    );
  }
  if (!hasIndexOnKeys(reverseFlowIndexes, { "scheduledRun.nextAt": 1 })) {
    await reverseFlows.createIndex(
      { "scheduledRun.nextAt": 1 },
      { name: "reverse_flows_next_at_idx", sparse: true },
    );
  }

  const runs = db.collection("reverse_flow_runs");
  const runIndexes = await runs.listIndexes().toArray();
  if (
    !hasIndexOnKeys(runIndexes, {
      workspaceId: 1,
      reverseFlowId: 1,
      triggeredAt: -1,
    })
  ) {
    await runs.createIndex(
      { workspaceId: 1, reverseFlowId: 1, triggeredAt: -1 },
      { name: "reverse_flow_runs_workspace_flow_triggered_idx" },
    );
  }
  if (!hasIndexOnKeys(runIndexes, { completedAt: 1 })) {
    await runs.createIndex(
      { completedAt: 1 },
      {
        name: "reverse_flow_runs_completed_ttl_idx",
        sparse: true,
        expireAfterSeconds: 7776000,
      },
    );
  }

  const ledger = db.collection("reverse_flow_ledger");
  const ledgerIndexes = await ledger.listIndexes().toArray();
  if (!hasIndexOnKeys(ledgerIndexes, { reverseFlowId: 1, sourcePk: 1 })) {
    await ledger.createIndex(
      { reverseFlowId: 1, sourcePk: 1 },
      { name: "reverse_flow_ledger_flow_source_unique_idx", unique: true },
    );
  }
  if (!hasIndexOnKeys(ledgerIndexes, { workspaceId: 1, reverseFlowId: 1 })) {
    await ledger.createIndex(
      { workspaceId: 1, reverseFlowId: 1 },
      { name: "reverse_flow_ledger_workspace_flow_idx" },
    );
  }
}
