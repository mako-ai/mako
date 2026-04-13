import type { ColumnDefinition, DatabaseDriver } from "../databases/driver";
import type { IDatabaseConnection } from "../database/workspace-schema";
import type { EntitySchema } from "./output-schema";

export type SchemaEvolutionMode = "append" | "strict" | "variant" | "relaxed";

const TYPE_MAP: Record<string, Record<string, string>> = {
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

export function translateType(
  abstractType: string,
  driverType: string,
): string {
  const normalized = abstractType.toLowerCase();
  const typeMap = TYPE_MAP[driverType] || TYPE_MAP.default;
  return typeMap[normalized] || typeMap.string;
}

export function toColumnDefinitions(
  schema: EntitySchema,
  driverType: string,
): ColumnDefinition[] {
  return schema.columns.map(column => ({
    name: column.name,
    type: translateType(column.type, driverType),
    nullable: column.nullable !== false,
    primaryKey: schema.primaryKey.includes(column.name),
  }));
}

export interface ReconcileResult {
  columnsToAdd: ColumnDefinition[];
  variantColumns: ColumnDefinition[];
  droppedColumns: string[];
  errors: string[];
}

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

  for (const column of newColumns) {
    const existingType = existingColumns.get(column.name);

    if (!existingType) {
      switch (evolutionMode) {
        case "append":
        case "variant":
        case "relaxed":
          result.columnsToAdd.push(column);
          break;
        case "strict":
          result.errors.push(
            `Column "${column.name}" exists in connector output but not in table`,
          );
          break;
      }
      continue;
    }

    if (existingType.toLowerCase() !== column.type.toLowerCase()) {
      if (evolutionMode === "strict") {
        result.errors.push(
          `Column "${column.name}" type mismatch: table has "${existingType}", connector sends "${column.type}"`,
        );
      } else if (evolutionMode === "variant") {
        const variantName = `${column.name}__v_${column.type.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
        if (!existingColumns.has(variantName)) {
          result.variantColumns.push({
            ...column,
            name: variantName,
            primaryKey: false,
          });
        }
      }
    }
  }

  if (evolutionMode === "strict") {
    for (const [columnName] of existingColumns) {
      const existsInOutput = newColumns.some(
        column => column.name === columnName,
      );
      if (!existsInOutput && !columnName.startsWith("_mako_")) {
        result.errors.push(
          `Column "${columnName}" exists in table but not in connector output`,
        );
      }
    }
  }

  return result;
}

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
  const exists = driver.tableExists
    ? await driver.tableExists(database, tableName, options)
    : false;

  if (!exists) {
    if (!driver.createTable) {
      return {
        success: false,
        error: "Driver does not support table creation",
      };
    }

    const columns = [
      ...toColumnDefinitions(entitySchema, driverType),
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
    ];

    const result = await driver.createTable(
      database,
      tableName,
      columns,
      options,
    );
    return {
      success: result.success,
      error: result.error,
    };
  }

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
  for (const row of infoResult.data as Array<Record<string, unknown>>) {
    existingColumns.set(String(row.column_name), String(row.data_type));
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
      error: reconcileResult.errors.join("; "),
      reconcileResult,
    };
  }

  const allNewColumns = [
    ...reconcileResult.columnsToAdd,
    ...reconcileResult.variantColumns,
  ];

  if (allNewColumns.length > 0 && driver.addColumns) {
    const result = await driver.addColumns(
      database,
      tableName,
      allNewColumns,
      options,
    );

    return {
      success: result.success,
      error: result.error,
      reconcileResult,
    };
  }

  return {
    success: true,
    reconcileResult,
  };
}
