import {
  DatabaseDriver,
  InsertOptions,
  UpsertOptions,
} from "../databases/driver";
import { IDatabaseConnection } from "../database/workspace-schema";
import { FlushBatch, EntitySchema } from "./output-schema";
import {
  applySchemaReconciliation,
  SchemaEvolutionMode,
  translateType,
} from "./schema-reconciler";
import { loggers } from "../logging";
import * as crypto from "crypto";

const logger = loggers.connector("write-pipeline");

const BATCH_SIZE = 500;

export interface WritePipelineOptions {
  driver: DatabaseDriver;
  database: IDatabaseConnection;
  driverType: string;
  schema?: string;
  tablePrefix?: string;
  evolutionMode: SchemaEvolutionMode;
  primaryKeys?: Record<string, string[]>;
}

export interface WriteResult {
  entity: string;
  rowsWritten: number;
  success: boolean;
  error?: string;
}

/**
 * Ensure _mako metadata schema and tables exist.
 * Creates:
 * - _mako.sync_state: Tracks sync state per instance/entity
 * - _mako.sync_log: Execution log entries
 * - _mako.table_schemas: Stored schema snapshots for reconciliation
 */
export async function ensureMakoMetadataTables(
  driver: DatabaseDriver,
  database: IDatabaseConnection,
  driverType: string,
  schemaName: string = "public",
): Promise<void> {
  // Create _mako schema if using PostgreSQL-like databases
  if (
    driverType === "postgresql" ||
    driverType === "redshift" ||
    driverType === "cloudsql-postgres"
  ) {
    await driver.executeQuery(database, `CREATE SCHEMA IF NOT EXISTS _mako;`);
  }

  const makoSchema =
    driverType === "postgresql" ||
    driverType === "redshift" ||
    driverType === "cloudsql-postgres"
      ? "_mako"
      : schemaName;

  const textType = translateType("string", driverType);
  const datetimeType = translateType("datetime", driverType);
  const jsonType = translateType("json", driverType);

  // sync_state table
  if (driver.createTable) {
    const syncStateExists = driver.tableExists
      ? await driver.tableExists(database, "sync_state", { schema: makoSchema })
      : false;

    if (!syncStateExists) {
      await driver.createTable(
        database,
        "sync_state",
        [
          { name: "instance_id", type: textType, primaryKey: true },
          { name: "entity", type: textType, primaryKey: true },
          { name: "state", type: jsonType, nullable: true },
          { name: "last_synced_at", type: datetimeType, nullable: true },
          {
            name: "row_count",
            type: translateType("integer", driverType),
            nullable: true,
          },
        ],
        { schema: makoSchema },
      );
    }

    // sync_log table
    const syncLogExists = driver.tableExists
      ? await driver.tableExists(database, "sync_log", { schema: makoSchema })
      : false;

    if (!syncLogExists) {
      await driver.createTable(
        database,
        "sync_log",
        [
          { name: "id", type: textType, primaryKey: true },
          { name: "instance_id", type: textType },
          { name: "started_at", type: datetimeType },
          { name: "completed_at", type: datetimeType, nullable: true },
          { name: "status", type: textType },
          {
            name: "rows_written",
            type: translateType("integer", driverType),
            nullable: true,
          },
          { name: "error", type: textType, nullable: true },
          { name: "metadata", type: jsonType, nullable: true },
        ],
        { schema: makoSchema },
      );
    }

    // table_schemas table
    const tableSchemasExists = driver.tableExists
      ? await driver.tableExists(database, "table_schemas", {
          schema: makoSchema,
        })
      : false;

    if (!tableSchemasExists) {
      await driver.createTable(
        database,
        "table_schemas",
        [
          { name: "table_name", type: textType, primaryKey: true },
          { name: "schema_json", type: jsonType },
          { name: "updated_at", type: datetimeType },
        ],
        { schema: makoSchema },
      );
    }
  }
}

/**
 * Infer an EntitySchema from a batch of records when none is provided.
 */
function inferSchemaFromRecords(
  entity: string,
  records: Record<string, unknown>[],
): EntitySchema {
  const columnTypes = new Map<string, string>();

  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (columnTypes.has(key)) continue;

      if (value === null || value === undefined) continue;
      if (typeof value === "boolean") columnTypes.set(key, "boolean");
      else if (typeof value === "number") {
        columnTypes.set(key, Number.isInteger(value) ? "integer" : "number");
      } else if (typeof value === "string") {
        // Try to detect dates
        if (/^\d{4}-\d{2}-\d{2}T/.test(value)) columnTypes.set(key, "datetime");
        else if (/^\d{4}-\d{2}-\d{2}$/.test(value))
          columnTypes.set(key, "date");
        else columnTypes.set(key, "string");
      } else if (Array.isArray(value)) columnTypes.set(key, "array");
      else if (typeof value === "object") columnTypes.set(key, "json");
      else columnTypes.set(key, "string");
    }
  }

  // Ensure all keys from all records are captured
  const allKeys = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      allKeys.add(key);
    }
  }

  return {
    name: entity,
    columns: Array.from(allKeys).map(name => ({
      name,
      type: (columnTypes.get(name) || "string") as any,
      nullable: true,
      primaryKey: false,
    })),
  };
}

/**
 * Write a single FlushBatch to the destination database.
 * Handles schema reconciliation, batch upserts, and metadata.
 */
export async function writeBatch(
  batch: FlushBatch,
  options: WritePipelineOptions,
): Promise<WriteResult> {
  const { driver, database, driverType, schema, tablePrefix, evolutionMode } =
    options;
  const entity = batch.entity;
  const tableName = tablePrefix ? `${tablePrefix}_${entity}` : entity;

  try {
    if (batch.records.length === 0) {
      return { entity, rowsWritten: 0, success: true };
    }

    // Get or infer schema
    const entitySchema =
      batch.schema || inferSchemaFromRecords(entity, batch.records);

    // Schema reconciliation
    const reconcileResult = await applySchemaReconciliation(
      driver,
      database,
      tableName,
      entitySchema,
      driverType,
      evolutionMode,
      { schema },
    );

    if (!reconcileResult.success) {
      return {
        entity,
        rowsWritten: 0,
        success: false,
        error: reconcileResult.error,
      };
    }

    // Add _mako metadata columns to each record
    const now = new Date().toISOString();
    const enrichedRecords = batch.records.map(record => ({
      ...record,
      _mako_synced_at: now,
      _mako_source_hash: crypto
        .createHash("md5")
        .update(JSON.stringify(record))
        .digest("hex")
        .slice(0, 16),
    }));

    // Determine primary keys for upsert
    const primaryKeys =
      options.primaryKeys?.[entity] ||
      entitySchema.primaryKey ||
      entitySchema.columns.filter(c => c.primaryKey).map(c => c.name);

    // Write in batches
    let totalWritten = 0;
    const insertOptions: InsertOptions = { schema };

    for (let i = 0; i < enrichedRecords.length; i += BATCH_SIZE) {
      const chunk = enrichedRecords.slice(i, i + BATCH_SIZE);

      if (primaryKeys.length > 0 && driver.upsertBatch) {
        const upsertOptions: UpsertOptions = {
          ...insertOptions,
          conflictStrategy: "update",
        };
        const result = await driver.upsertBatch(
          database,
          tableName,
          chunk,
          primaryKeys,
          upsertOptions,
        );
        if (!result.success) {
          return {
            entity,
            rowsWritten: totalWritten,
            success: false,
            error: result.error,
          };
        }
        totalWritten += result.rowsWritten;
      } else if (driver.insertBatch) {
        const result = await driver.insertBatch(
          database,
          tableName,
          chunk,
          insertOptions,
        );
        if (!result.success) {
          return {
            entity,
            rowsWritten: totalWritten,
            success: false,
            error: result.error,
          };
        }
        totalWritten += result.rowsWritten;
      } else {
        return {
          entity,
          rowsWritten: 0,
          success: false,
          error: "Driver does not support write operations",
        };
      }
    }

    logger.info("Batch written", {
      entity,
      tableName,
      rowsWritten: totalWritten,
    });

    return { entity, rowsWritten: totalWritten, success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Write pipeline error", { error: err, entity, tableName });
    return { entity, rowsWritten: 0, success: false, error: message };
  }
}

/**
 * Write all batches from a connector output to the destination.
 */
export async function writeAllBatches(
  batches: FlushBatch[],
  options: WritePipelineOptions,
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];

  for (const batch of batches) {
    const result = await writeBatch(batch, options);
    results.push(result);

    if (!result.success) {
      logger.warn("Batch write failed, continuing with remaining batches", {
        entity: batch.entity,
        error: result.error,
      });
    }
  }

  return results;
}
