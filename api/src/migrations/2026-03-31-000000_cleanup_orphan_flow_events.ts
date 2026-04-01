import { Db, ObjectId } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Delete orphan documents from child collections whose flowId references a deleted flow";

const CHILD_COLLECTIONS = [
  "webhookevents",
  "flow_executions",
  "cdc_change_events",
  "cdc_entity_state",
  "cdc_state_transitions",
] as const;

export async function up(db: Db): Promise<void> {
  const validFlowIds: ObjectId[] = await db.collection("flows").distinct("_id");

  if (validFlowIds.length === 0) {
    log.info("No flows found — skipping orphan cleanup (nothing to compare)");
    return;
  }

  for (const col of CHILD_COLLECTIONS) {
    const exists = await db.listCollections({ name: col }).hasNext();
    if (!exists) {
      log.info(`Collection '${col}' does not exist — skipping`);
      continue;
    }

    const result = await db
      .collection(col)
      .deleteMany({ flowId: { $nin: validFlowIds } });

    log.info(
      `Cleaned orphans from '${col}': ${result.deletedCount} documents deleted`,
    );
  }
}
