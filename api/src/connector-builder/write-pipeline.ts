import { createHash } from "node:crypto";
import type {
  DatabaseDriver,
  InsertOptions,
  UpsertOptions,
} from "../databases/driver";
import type { IDatabaseConnection } from "../database/workspace-schema";
import type { EntitySchema, FlushBatch } from "./output-schema";
import {
  applySchemaReconciliation,
  type SchemaEvolutionMode,
  translateType,
} from "./schema-reconciler";
import { loggers } from "../logging";

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

export async function ensureMakoMetadataTables(
  driver: DatabaseDriver,
  database: IDatabaseConnection,
  driverType: string,
  schemaName = "public",
): Promise<void> {
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

  if (!driver.createTable) {
    return;
  }

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
}

function inferSchemaFromRecords(
  entity: string,
  rows: Record<string, unknown>[],
): EntitySchema {
  const columnTypes = new Map<string, string>();
  const allKeys = new Set<string>();

  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      allKeys.add(key);
      if (columnTypes.has(key) || value == null) {
        continue;
      }

      if (typeof value === "boolean") {
        columnTypes.set(key, "boolean");
      } else if (typeof value === "number") {
        columnTypes.set(key, Number.isInteger(value) ? "integer" : "number");
      } else if (typeof value === "string") {
        if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
          columnTypes.set(key, "datetime");
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          columnTypes.set(key, "date");
        } else {
          columnTypes.set(key, "string");
        }
      } else if (Array.isArray(value)) {
        columnTypes.set(key, "array");
      } else if (typeof value === "object") {
        columnTypes.set(key, "json");
      } else {
        columnTypes.set(key, "string");
      }
    }
  }

  return {
    entity,
    primaryKey: [],
    columns: Array.from(allKeys).map(name => ({
      name,
      type: columnTypes.get(name) || "string",
      nullable: true,
    })),
  };
}

export async function writeBatch(
  batch: FlushBatch,
  options: WritePipelineOptions,
): Promise<WriteResult> {
  const { driver, database, driverType, schema, tablePrefix, evolutionMode } =
    options;
  const tableName = tablePrefix
    ? `${tablePrefix}_${batch.entity}`
    : batch.entity;

  if (batch.rows.length === 0) {
    return { entity: batch.entity, rowsWritten: 0, success: true };
  }

  const entitySchema =
    batch.schema || inferSchemaFromRecords(batch.entity, batch.rows);
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
      entity: batch.entity,
      rowsWritten: 0,
      success: false,
      error: reconcileResult.error,
    };
  }

  const enrichedRows = batch.rows.map(row => ({
    ...row,
    _mako_synced_at: new Date().toISOString(),
    _mako_source_hash: createHash("md5")
      .update(JSON.stringify(row))
      .digest("hex")
      .slice(0, 16),
  }));

  const primaryKeys =
    options.primaryKeys?.[batch.entity] ||
    entitySchema.primaryKey ||
    entitySchema.columns
      .filter(column => entitySchema.primaryKey.includes(column.name))
      .map(column => column.name);

  let totalWritten = 0;
  const insertOptions: InsertOptions = { schema };

  for (let index = 0; index < enrichedRows.length; index += BATCH_SIZE) {
    const chunk = enrichedRows.slice(index, index + BATCH_SIZE);

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
          entity: batch.entity,
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
          entity: batch.entity,
          rowsWritten: totalWritten,
          success: false,
          error: result.error,
        };
      }
      totalWritten += result.rowsWritten;
    } else {
      return {
        entity: batch.entity,
        rowsWritten: totalWritten,
        success: false,
        error: "Driver does not support write operations",
      };
    }
  }

  logger.info("Connector batch written", {
    entity: batch.entity,
    tableName,
    rowsWritten: totalWritten,
  });

  return {
    entity: batch.entity,
    rowsWritten: totalWritten,
    success: true,
  };
}

export async function writeAllBatches(
  batches: FlushBatch[],
  options: WritePipelineOptions,
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];

  for (const batch of batches) {
    const result = await writeBatch(batch, options);
    results.push(result);
  }

  return results;
}
