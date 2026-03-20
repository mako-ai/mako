import { DatabaseDriver, ColumnDefinition } from "../databases/driver";
import { IDatabaseConnection } from "../database/workspace-schema";
import { EntitySchema, ColumnType } from "./output-schema";
import { loggers } from "../logging";

const logger = loggers.connector("schema-reconciler");

/**
 * Schema evolution modes:
 * - additive: New columns are added automatically. Existing columns are never removed or altered.
 * - strict: Schema must match exactly. New/missing columns cause an error.
 * - permissive: New columns are added. Type changes create variant columns (colName__v_type).
 * - locked: No schema changes allowed. New columns are silently dropped.
 */
export type SchemaEvolutionMode =
  | "additive"
  | "strict"
  | "permissive"
  | "locked";

/**
 * Maps abstract connector types to PostgreSQL-compatible SQL types.
 */
export const TYPE_MAP: Record<string, Record<ColumnType, string>> = {
  postgresql: {
    string: "TEXT",
    number: "DOUBLE PRECISION",
    integer: "BIGINT",
    boolean: "BOOLEAN",
    date: "DATE",
    datetime: "TIMESTAMPTZ",
    json: "JSONB",
    array: "JSONB",
  },
  redshift: {
    string: "VARCHAR(65535)",
    number: "DOUBLE PRECISION",
    integer: "BIGINT",
    boolean: "BOOLEAN",
    date: "DATE",
    datetime: "TIMESTAMPTZ",
    json: "SUPER",
    array: "SUPER",
  },
  bigquery: {
    string: "STRING",
    number: "FLOAT64",
    integer: "INT64",
    boolean: "BOOL",
    date: "DATE",
    datetime: "TIMESTAMP",
    json: "JSON",
    array: "JSON",
  },
  mysql: {
    string: "TEXT",
    number: "DOUBLE",
    integer: "BIGINT",
    boolean: "TINYINT(1)",
    date: "DATE",
    datetime: "DATETIME",
    json: "JSON",
    array: "JSON",
  },
  default: {
    string: "TEXT",
    number: "DOUBLE PRECISION",
    integer: "BIGINT",
    boolean: "BOOLEAN",
    date: "DATE",
    datetime: "TIMESTAMP",
    json: "TEXT",
    array: "TEXT",
  },
};

/**
 * Translate an abstract connector column type to a driver-specific SQL type.
 */
export function translateType(
  abstractType: ColumnType,
  driverType: string,
): string {
  const typeMap = TYPE_MAP[driverType] || TYPE_MAP.default;
  return typeMap[abstractType] || typeMap.string;
}

/**
 * Convert an EntitySchema from connector output into ColumnDefinitions
 * suitable for the database driver.
 */
export function toColumnDefinitions(
  schema: EntitySchema,
  driverType: string,
): ColumnDefinition[] {
  return schema.columns.map(col => ({
    name: col.name,
    type: translateType(col.type, driverType),
    nullable: col.nullable !== false,
    primaryKey: col.primaryKey || false,
  }));
}

export interface ReconcileResult {
  columnsToAdd: ColumnDefinition[];
  variantColumns: ColumnDefinition[];
  droppedColumns: string[];
  errors: string[];
}

/**
 * Compare inferred schema from records against the existing table schema
 * and determine what DDL operations are needed.
 */
export function reconcileSchema(
  entitySchema: EntitySchema,
  existingColumns: Map<string, string>,
  driverType: string,
  evolutionMode: SchemaEvolutionMode,
): ReconcileResult {
  const result: ReconcileResult = {
    columnsToAdd: [],
    variantColumns: [],
    droppedColumns: [],
    errors: [],
  };

  const newColumns = toColumnDefinitions(entitySchema, driverType);

  for (const col of newColumns) {
    const existingType = existingColumns.get(col.name);

    if (!existingType) {
      // New column
      switch (evolutionMode) {
        case "additive":
        case "permissive":
          result.columnsToAdd.push(col);
          break;
        case "strict":
          result.errors.push(
            `Column "${col.name}" exists in connector output but not in table`,
          );
          break;
        case "locked":
          result.droppedColumns.push(col.name);
          break;
      }
    } else if (existingType.toLowerCase() !== col.type.toLowerCase()) {
      // Type mismatch
      switch (evolutionMode) {
        case "permissive": {
          // Create a variant column
          const variantName = `${col.name}__v_${col.type.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
          if (!existingColumns.has(variantName)) {
            result.variantColumns.push({
              ...col,
              name: variantName,
              primaryKey: false,
            });
          }
          break;
        }
        case "strict":
          result.errors.push(
            `Column "${col.name}" type mismatch: table has "${existingType}", connector sends "${col.type}"`,
          );
          break;
        case "additive":
        case "locked":
          // Additive and locked ignore type changes
          break;
      }
    }
  }

  // Check for strict mode: columns in table but not in connector output
  if (evolutionMode === "strict") {
    for (const [colName] of existingColumns) {
      const inOutput = newColumns.some(c => c.name === colName);
      if (!inOutput && !colName.startsWith("_mako_")) {
        result.errors.push(
          `Column "${colName}" exists in table but not in connector output`,
        );
      }
    }
  }

  return result;
}

/**
 * Apply schema reconciliation to the database.
 * Creates the table if it doesn't exist, or adds columns if needed.
 */
export async function applySchemaReconciliation(
  driver: DatabaseDriver,
  database: IDatabaseConnection,
  tableName: string,
  entitySchema: EntitySchema,
  driverType: string,
  evolutionMode: SchemaEvolutionMode,
  options?: { schema?: string },
): Promise<{
  success: boolean;
  error?: string;
  reconcileResult?: ReconcileResult;
}> {
  try {
    // Check if table exists
    const exists = driver.tableExists
      ? await driver.tableExists(database, tableName, options)
      : false;

    if (!exists) {
      // Create table
      if (!driver.createTable) {
        return {
          success: false,
          error: "Driver does not support table creation",
        };
      }

      const columns = toColumnDefinitions(entitySchema, driverType);
      // Add _mako metadata columns
      columns.push(
        {
          name: "_mako_synced_at",
          type: translateType("datetime", driverType),
          nullable: true,
        },
        {
          name: "_mako_source_hash",
          type: translateType("string", driverType),
          nullable: true,
        },
      );

      const createResult = await driver.createTable(
        database,
        tableName,
        columns,
        options,
      );
      if (!createResult.success) {
        return { success: false, error: createResult.error };
      }

      logger.info("Created table", { tableName, columns: columns.length });
      return { success: true };
    }

    // Table exists: get current columns
    // We query INFORMATION_SCHEMA to get existing column types
    const schemaName = options?.schema || "public";
    const infoQuery = `
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = '${schemaName.replace(/'/g, "''")}' 
      AND table_name = '${tableName.replace(/'/g, "''")}'
    `;
    const infoResult = await driver.executeQuery(database, infoQuery);

    if (!infoResult.success || !infoResult.data) {
      return {
        success: false,
        error: `Failed to read table schema: ${infoResult.error}`,
      };
    }

    const existingColumns = new Map<string, string>();
    for (const row of infoResult.data) {
      existingColumns.set((row as any).column_name, (row as any).data_type);
    }

    const reconcileResult = reconcileSchema(
      entitySchema,
      existingColumns,
      driverType,
      evolutionMode,
    );

    if (reconcileResult.errors.length > 0) {
      return {
        success: false,
        error: `Schema reconciliation failed: ${reconcileResult.errors.join("; ")}`,
        reconcileResult,
      };
    }

    // Apply column additions
    const allNewColumns = [
      ...reconcileResult.columnsToAdd,
      ...reconcileResult.variantColumns,
    ];

    if (allNewColumns.length > 0 && driver.addColumns) {
      const addResult = await driver.addColumns(
        database,
        tableName,
        allNewColumns,
        options,
      );

      if (!addResult.success) {
        return {
          success: false,
          error: `Failed to add columns: ${addResult.error}`,
          reconcileResult,
        };
      }

      logger.info("Added columns to table", {
        tableName,
        added: allNewColumns.map(c => c.name),
      });
    }

    return { success: true, reconcileResult };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Schema reconciliation error", { error: err, tableName });
    return { success: false, error: message };
  }
}
