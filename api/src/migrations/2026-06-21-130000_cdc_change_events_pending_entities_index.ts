import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

const COLLECTION = "cdc_change_events";
const INDEX_NAME = "cdc_pending_entities";

type IndexInfo = {
  name: string;
  key?: Record<string, unknown>;
};

/**
 * The CDC scheduler self-heal step (findEntitiesWithPendingEvents) enumerates
 * DISTINCT flow+entity pairs that still have `materializationStatus: "pending"`
 * rows, independent of the consumer cursor — this is what rescues entities
 * whose cursor drifted past their pending events (so findStaleEntities, which
 * keys on lastIngestSeq > lastMaterializedSeq, never flags them).
 *
 * Without an index, that `$match { materializationStatus: "pending" } $group`
 * is a COLLSCAN over the whole cdc_change_events collection every cron tick.
 * This partial index covers only pending rows (so it stays tiny and is not
 * bloated by the millions of applied/dropped rows) and lets the grouping run
 * as a bounded index scan ordered by flowId+entity.
 */
export const description =
  "Add partial { flowId, entity } index on cdc_change_events for pending rows (CDC self-heal discovery)";

function hasIndexNamed(indexes: IndexInfo[], name: string): boolean {
  return indexes.some(idx => idx.name === name);
}

export async function up(db: Db): Promise<void> {
  const names = new Set(
    (await db.listCollections().toArray()).map(c => c.name),
  );
  if (!names.has(COLLECTION)) {
    log.info("cdc_change_events collection not found, skipping", {
      collection: COLLECTION,
    });
    return;
  }

  const col = db.collection(COLLECTION);
  const indexes = (await col.indexes()) as IndexInfo[];

  if (hasIndexNamed(indexes, INDEX_NAME)) {
    log.info("cdc_pending_entities index already present, skipping", {
      collection: COLLECTION,
    });
    return;
  }

  await col.createIndex(
    { flowId: 1, entity: 1 },
    {
      name: INDEX_NAME,
      partialFilterExpression: { materializationStatus: "pending" },
    },
  );
  log.info("Created cdc_change_events pending-entities partial index", {
    collection: COLLECTION,
    name: INDEX_NAME,
  });
}
