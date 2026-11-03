import { Db } from "mongodb";
import { loggers } from "../logging";

export const description =
  "Delete the connector flows still on the removed legacy sync engine (CDC is the only engine; database-source flows untouched)";

const log = loggers.migration();

export async function up(db: Db): Promise<void> {
  const flows = db.collection("flows");

  // Idempotent: once deleted, nothing matches. Database-source flows keep
  // their own write path and are not engine flows.
  const legacy = await flows
    .find(
      { sourceType: { $ne: "database" }, syncEngine: { $ne: "cdc" } },
      { projection: { _id: 1, workspaceId: 1, name: 1 } },
    )
    .toArray();

  for (const flow of legacy) {
    log.warn("Deleting legacy-engine flow (legacy engine removed)", {
      flowId: String(flow._id),
      workspaceId: String(flow.workspaceId),
      name: flow.name,
    });
  }

  if (legacy.length > 0) {
    await flows.deleteMany({ _id: { $in: legacy.map(f => f._id) } });
  }

  log.info("Legacy-engine flows deleted", { deleted: legacy.length });
}
