import { Db, ObjectId } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

const CHECKPOINT_COLLECTION = "cdc_backfill_checkpoints";
const LOCK_COLLECTION = "cdc_entity_locks";
const CDC_STATE_COLLECTION = "bigquery_cdc_state";
const CHANGE_EVENTS_COLLECTION = "bigquery_change_events";
const APPLIED_TTL_INDEX = "cdc_applied_events_ttl_7d";
const APPLIED_TTL_SECONDS = 7 * 24 * 60 * 60;

export const description =
  "Migrate CDC backfill checkpoints into cdc state, drop lock/checkpoint collections, and enforce 7-day applied event TTL";

type CheckpointDoc = {
  workspaceId: ObjectId;
  flowId: ObjectId;
  entity: string;
  fetchState?: Record<string, unknown>;
  updatedAt?: Date;
};

export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const names = new Set(collections.map(c => c.name));

  if (names.has(CHECKPOINT_COLLECTION)) {
    const checkpointCol = db.collection<CheckpointDoc>(CHECKPOINT_COLLECTION);
    const stateCol = db.collection(CDC_STATE_COLLECTION);

    const checkpoints = await checkpointCol
      .find({})
      .sort({ updatedAt: -1, _id: -1 })
      .toArray();

    const seen = new Set<string>();
    let migrated = 0;
    for (const checkpoint of checkpoints) {
      const key = `${checkpoint.workspaceId.toString()}:${checkpoint.flowId.toString()}:${checkpoint.entity}`;
      if (seen.has(key)) continue;
      seen.add(key);

      await stateCol.updateOne(
        {
          workspaceId: checkpoint.workspaceId,
          flowId: checkpoint.flowId,
          entity: checkpoint.entity,
        },
        {
          $set: {
            workspaceId: checkpoint.workspaceId,
            flowId: checkpoint.flowId,
            entity: checkpoint.entity,
            backfillCursor: checkpoint.fetchState || {},
          },
        },
        { upsert: true },
      );
      migrated += 1;
    }

    await checkpointCol.drop();
    log.info("Migrated and dropped CDC checkpoint collection", {
      sourceCollection: CHECKPOINT_COLLECTION,
      migratedRows: migrated,
    });
  } else {
    log.info("CDC checkpoint collection not found, skipping", {
      collection: CHECKPOINT_COLLECTION,
    });
  }

  if (names.has(LOCK_COLLECTION)) {
    await db.collection(LOCK_COLLECTION).drop();
    log.info("Dropped CDC lock collection", { collection: LOCK_COLLECTION });
  } else {
    log.info("CDC lock collection not found, skipping", {
      collection: LOCK_COLLECTION,
    });
  }

  if (!names.has(CHANGE_EVENTS_COLLECTION)) {
    log.info("CDC change event collection not found, skipping TTL index", {
      collection: CHANGE_EVENTS_COLLECTION,
    });
    return;
  }

  const changeEventCol = db.collection(CHANGE_EVENTS_COLLECTION);
  const existingIndexes = await changeEventCol.indexes();
  const hasDesiredIndex = existingIndexes.some(
    index =>
      index.name === APPLIED_TTL_INDEX &&
      (index.expireAfterSeconds || 0) === APPLIED_TTL_SECONDS,
  );

  if (!hasDesiredIndex) {
    try {
      await changeEventCol.dropIndex(APPLIED_TTL_INDEX);
    } catch {
      // Ignore if missing.
    }

    await changeEventCol.createIndex(
      { appliedAt: 1 },
      {
        name: APPLIED_TTL_INDEX,
        expireAfterSeconds: APPLIED_TTL_SECONDS,
        partialFilterExpression: { appliedAt: { $exists: true } },
      },
    );
    log.info("Created CDC applied event TTL index", {
      collection: CHANGE_EVENTS_COLLECTION,
      index: APPLIED_TTL_INDEX,
      expireAfterSeconds: APPLIED_TTL_SECONDS,
    });
  } else {
    log.info("CDC applied event TTL index already present", {
      collection: CHANGE_EVENTS_COLLECTION,
      index: APPLIED_TTL_INDEX,
    });
  }
}
