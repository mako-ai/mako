/**
 * The MongoDB engine of the destination writer: a collection per target,
 * full syncs through a `<collection>_staging` collection swapped in by
 * rename, upserts keyed on the record's `id` plus its data source.
 */
import type { Collection } from "mongodb";
import type { DestinationConfig, WriteOptions, WriteResult } from "./types";

const NOT_CONFIGURED = "MongoDB destination not configured";

function stagingNameFor(config: DestinationConfig, options: WriteOptions) {
  return options.stagingTableName || `${config.collectionName}_staging`;
}

export async function prepareMongoStaging(
  config: DestinationConfig,
  options: WriteOptions,
): Promise<void> {
  if (!config.mongoDb || !config.collectionName) {
    throw new Error(NOT_CONFIGURED);
  }

  const stagingName = stagingNameFor(config, options);

  // Drop staging collection if exists
  try {
    await config.mongoDb.collection(stagingName).drop();
  } catch {
    // Ignore if doesn't exist
  }

  // Create staging collection
  await config.mongoDb.createCollection(stagingName);

  // Create indexes on staging collection
  await ensureMongoIndexes(config.mongoDb.collection(stagingName));
}

export async function writeBatchToMongo(
  config: DestinationConfig,
  rows: Record<string, unknown>[],
  options: WriteOptions,
  stagingActive: boolean,
): Promise<WriteResult> {
  if (!config.mongoDb || !config.collectionName) {
    return {
      success: false,
      rowsWritten: 0,
      error: "MongoDB not configured",
    };
  }

  try {
    const collectionName = stagingActive
      ? stagingNameFor(config, options)
      : config.collectionName;

    const collection = config.mongoDb.collection(collectionName);

    // Add metadata to records
    const processedRecords = rows.map(record => ({
      ...record,
      _dataSourceId: config.dataSourceId,
      _dataSourceName: config.dataSourceName,
      _syncedAt: new Date(),
    }));

    // Use bulkWrite with upserts
    // When a record has a non-null 'id' field, use it for deduplication
    // via replaceOne. When a record lacks an 'id' field (or it is null),
    // fall back to a plain insert to avoid matching documents with
    // { id: null/undefined } which would cause data loss by overwriting
    // unrelated documents.
    // NOTE: The check is per-record, not batch-level, because a batch can
    // contain a mix of records with and without valid id values.
    const bulkOps = processedRecords.map(record => {
      const id = (record as Record<string, unknown>).id;
      if (id != null) {
        return {
          replaceOne: {
            filter: {
              id,
              _dataSourceId: config.dataSourceId,
            },
            replacement: record,
            upsert: true,
          },
        };
      }
      return {
        insertOne: {
          document: record,
        },
      };
    });

    const result = await collection.bulkWrite(bulkOps, { ordered: false });

    return {
      success: true,
      rowsWritten:
        result.insertedCount + result.upsertedCount + result.modifiedCount,
    };
  } catch (error) {
    return {
      success: false,
      rowsWritten: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function finalizeMongoSync(
  config: DestinationConfig,
  options: WriteOptions,
): Promise<void> {
  if (!config.mongoDb || !config.collectionName) {
    throw new Error(NOT_CONFIGURED);
  }

  const stagingName = stagingNameFor(config, options);
  const backupName = `${config.collectionName}_backup_${Date.now()}`;

  // Step 1: Rename original to backup (if it exists)
  try {
    await config.mongoDb.collection(config.collectionName).rename(backupName);
  } catch {
    // Ignore if original doesn't exist (first sync)
  }

  // Step 2: Rename staging to original
  try {
    await config.mongoDb.collection(stagingName).rename(config.collectionName);
  } catch (error) {
    // If rename fails, try to restore from backup
    try {
      await config.mongoDb.collection(backupName).rename(config.collectionName);
    } catch {
      // Backup restore failed too - log but don't mask original error
    }
    throw error;
  }

  // Step 3: Drop backup collection (non-critical)
  try {
    await config.mongoDb.collection(backupName).drop();
  } catch {
    // Ignore cleanup errors - backup will be cleaned up eventually
  }
}

export async function cleanupMongoStaging(
  config: DestinationConfig,
  options: WriteOptions,
): Promise<void> {
  if (!config.mongoDb || !config.collectionName) {
    return;
  }

  try {
    await config.mongoDb.collection(stagingNameFor(config, options)).drop();
  } catch {
    // Ignore if doesn't exist
  }
}

export async function deleteFromMongoByKeys(
  config: DestinationConfig,
  keyFilters: Record<string, unknown>,
): Promise<WriteResult> {
  if (!config.mongoDb || !config.collectionName) {
    return {
      success: false,
      rowsWritten: 0,
      error: "MongoDB not configured",
    };
  }
  try {
    const collection = config.mongoDb.collection(config.collectionName);
    const result = await collection.deleteOne(keyFilters);
    return { success: true, rowsWritten: result.deletedCount };
  } catch (error) {
    return {
      success: false,
      rowsWritten: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function ensureMongoIndexes(collection: Collection): Promise<void> {
  try {
    const existingIndexes = await collection.indexes();
    const existingIndexNames = existingIndexes.map(idx => idx.name);

    // Unique index on 'id' field
    if (
      !existingIndexNames.includes("id_unique_idx") &&
      !existingIndexNames.includes("id_1")
    ) {
      await collection.createIndex(
        { id: 1 },
        {
          unique: true,
          background: true,
          name: "id_unique_idx",
          partialFilterExpression: { id: { $exists: true } },
        },
      );
    }

    // Compound index for bulk sync upserts
    if (!existingIndexNames.includes("sync_upsert_idx")) {
      await collection.createIndex(
        { id: 1, _dataSourceId: 1 },
        { background: true, name: "sync_upsert_idx" },
      );
    }

    // Index for incremental sync date queries
    if (!existingIndexNames.includes("incremental_sync_idx")) {
      await collection.createIndex(
        { _dataSourceId: 1, _syncedAt: -1 },
        { background: true, name: "incremental_sync_idx" },
      );
    }
  } catch {
    // Indexes are for performance, not correctness
  }
}
