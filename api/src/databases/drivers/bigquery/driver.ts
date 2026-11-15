import {
  ColumnDefinition,
  BatchWriteResult,
  InsertOptions,
} from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";
import { escapeIdentifier, escapeForBigQueryString } from "./sql-values";
import { BigQueryBatchWriteDriver } from "./batch-writes";

/**
 * The BigQuery driver: staging tables, atomic swaps, copies and deletes on
 * top of the batch writes and core plumbing it extends.
 */
export class BigQueryDatabaseDriver extends BigQueryBatchWriteDriver {
  /**
   * Create a staging table (copy of original table structure)
   */
  async createStagingTable(
    database: IDatabaseConnection,
    originalTableName: string,
    stagingTableName: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const projectId = this.getProjectId(database);
    const dataset = options?.schema;
    const stagingDataset = options?.stagingSchema || dataset;
    if (!dataset) {
      return {
        success: false,
        error: "Dataset (schema) is required for BigQuery",
      };
    }
    if (!stagingDataset) {
      return {
        success: false,
        error: "Staging dataset is required for BigQuery",
      };
    }

    const fullOriginal = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(originalTableName)}`;
    const fullStaging = `${escapeIdentifier(projectId)}.${escapeIdentifier(stagingDataset)}.${escapeIdentifier(stagingTableName)}`;

    // Drop staging table if exists
    const dropResult = await this.executeQuery(
      database,
      `DROP TABLE IF EXISTS ${fullStaging};`,
    );
    if (!dropResult.success) {
      return { success: false, error: dropResult.error };
    }

    // When partition/cluster options are provided, we need explicit DDL
    // because CREATE TABLE AS SELECT WHERE FALSE loses layout config.
    if (options?.partitioning || options?.clustering) {
      const colTypes = await this.getTableColumnTypes(
        database,
        originalTableName,
        dataset,
      );
      if (colTypes.size === 0) {
        return {
          success: false,
          error: "Could not read original table schema for staging",
        };
      }

      const columns: ColumnDefinition[] = Array.from(colTypes.entries()).map(
        ([name, type]) => ({ name, type, nullable: true }),
      );
      return this.createTable(database, stagingTableName, columns, {
        ...options,
        schema: stagingDataset,
      });
    }

    const query = `CREATE TABLE ${fullStaging} AS SELECT * FROM ${fullOriginal} WHERE FALSE;`;
    const result = await this.executeQuery(database, query);

    return { success: result.success, error: result.error };
  }

  /**
   * Create a table from an existing source table's schema, preserving
   * partition/cluster layout from options, then copy all data.
   * Unlike CREATE TABLE ... AS SELECT, this retains partitioning config.
   */
  protected async createTableWithLayoutFromSource(
    database: IDatabaseConnection,
    sourceTable: string,
    sourceSchema: string,
    targetTable: string,
    targetSchema: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const projectId = this.getProjectId(database);

    const colTypes = await this.getTableColumnTypes(
      database,
      sourceTable,
      sourceSchema,
    );
    if (colTypes.size === 0) {
      return {
        success: false,
        error: `Could not read schema from ${sourceSchema}.${sourceTable}`,
      };
    }

    const columns: ColumnDefinition[] = Array.from(colTypes.entries()).map(
      ([name, type]) => ({ name, type, nullable: true }),
    );

    const createResult = await this.createTable(
      database,
      targetTable,
      columns,
      { ...options, schema: targetSchema },
    );
    if (!createResult.success) {
      return createResult;
    }

    const fullSource = `${escapeIdentifier(projectId)}.${escapeIdentifier(sourceSchema)}.${escapeIdentifier(sourceTable)}`;
    const fullTarget = `${escapeIdentifier(projectId)}.${escapeIdentifier(targetSchema)}.${escapeIdentifier(targetTable)}`;
    const insertResult = await this.executeQuery(
      database,
      `INSERT INTO ${fullTarget} SELECT * FROM ${fullSource};`,
    );
    if (!insertResult.success) {
      return { success: false, error: insertResult.error };
    }

    return { success: true };
  }

  /**
   * Swap staging table with original
   * BigQuery doesn't support RENAME, so we recreate with explicit DDL
   * to preserve partition/cluster settings from options.
   */
  async swapStagingTable(
    database: IDatabaseConnection,
    originalTableName: string,
    stagingTableName: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const projectId = this.getProjectId(database);
    const dataset = options?.schema;
    const stagingDataset = options?.stagingSchema || dataset;
    if (!dataset) {
      return {
        success: false,
        error: "Dataset (schema) is required for BigQuery",
      };
    }
    if (!stagingDataset) {
      return {
        success: false,
        error: "Staging dataset is required for BigQuery",
      };
    }

    const fullOriginal = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(originalTableName)}`;
    const fullStaging = `${escapeIdentifier(projectId)}.${escapeIdentifier(stagingDataset)}.${escapeIdentifier(stagingTableName)}`;
    const backupName = `${originalTableName}_backup_${Date.now()}`;
    const fullBackup = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(backupName)}`;

    const originalExists = await this.tableExists(database, originalTableName, {
      schema: dataset,
    });
    if (!originalExists) {
      const promoteResult = await this.createTableWithLayoutFromSource(
        database,
        stagingTableName,
        stagingDataset,
        originalTableName,
        dataset,
        options,
      );
      if (!promoteResult.success) {
        return {
          success: false,
          error: `Failed to create original from staging: ${promoteResult.error}`,
        };
      }

      await this.executeQuery(database, `DROP TABLE IF EXISTS ${fullStaging};`);
      return { success: true };
    }

    // Step 1: Backup original (CTAS is fine — backup is temporary and doesn't need partitioning)
    let result = await this.executeQuery(
      database,
      `CREATE TABLE ${fullBackup} AS SELECT * FROM ${fullOriginal};`,
    );
    if (!result.success) {
      return {
        success: false,
        error: `Failed to backup original: ${result.error}`,
      };
    }

    // Step 2: Drop original
    result = await this.executeQuery(database, `DROP TABLE ${fullOriginal};`);
    if (!result.success) {
      return {
        success: false,
        error: `Failed to drop original: ${result.error}`,
      };
    }

    // Step 3: Create new original with proper partition/cluster layout
    const swapResult = await this.createTableWithLayoutFromSource(
      database,
      stagingTableName,
      stagingDataset,
      originalTableName,
      dataset,
      options,
    );
    if (!swapResult.success) {
      // Restore from backup
      await this.executeQuery(
        database,
        `CREATE TABLE ${fullOriginal} AS SELECT * FROM ${fullBackup};`,
      );
      return {
        success: false,
        error: `Failed to create new table: ${swapResult.error}`,
      };
    }

    // Step 4: Drop staging and backup
    await this.executeQuery(database, `DROP TABLE IF EXISTS ${fullStaging};`);
    await this.executeQuery(database, `DROP TABLE IF EXISTS ${fullBackup};`);

    return { success: true };
  }

  /**
   * Create a table with the same schema as a source table, with optional
   * partitioning/clustering. Does NOT copy data.
   */
  async createTableFromSource(
    database: IDatabaseConnection,
    sourceTableName: string,
    targetTableName: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const projectId = this.getProjectId(database);
    const dataset = options?.schema;
    if (!dataset) {
      return {
        success: false,
        error: "Dataset (schema) is required for BigQuery",
      };
    }

    const fullTarget = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(targetTableName)}`;
    const fullSource = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(sourceTableName)}`;

    const schemaResult = await this.executeQuery(
      database,
      `SELECT column_name, data_type FROM ${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.INFORMATION_SCHEMA.COLUMNS WHERE table_name = '${sourceTableName.replace(/'/g, "''")}' ORDER BY ordinal_position`,
    );
    if (!schemaResult.success) {
      return {
        success: false,
        error: `Schema discovery failed for ${fullSource}: ${schemaResult.error}`,
      };
    }
    if (!schemaResult.data?.length) {
      return {
        success: false,
        error: `Source table ${fullSource} not found or has no columns`,
      };
    }

    const colDefs = (schemaResult.data as any[])
      .map((r: any) => `${escapeIdentifier(r.column_name)} ${r.data_type}`)
      .join(",\n  ");

    const partitionClause = this.buildPartitionClause(options?.partitioning);
    const clusterClause = this.buildClusterClause(options?.clustering);
    const tableOptions = this.buildTableOptions(options?.partitioning);

    const query = `CREATE TABLE IF NOT EXISTS ${fullTarget} (\n  ${colDefs}\n)${partitionClause}${clusterClause}${tableOptions};`;
    const result = await this.executeQuery(database, query);
    return { success: result.success, error: result.error };
  }

  /**
   * Drop a table
   */
  async dropTable(
    database: IDatabaseConnection,
    tableName: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const projectId = this.getProjectId(database);
    const dataset = options?.schema;
    if (!dataset) {
      return {
        success: false,
        error: "Dataset (schema) is required for BigQuery",
      };
    }

    const fullTableName = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(tableName)}`;

    const query = `DROP TABLE IF EXISTS ${fullTableName};`;
    const result = await this.executeQuery(database, query);

    return { success: result.success, error: result.error };
  }

  /**
   * Delete rows matching the given key filters
   */
  async deleteBatch(
    database: IDatabaseConnection,
    tableName: string,
    keyFilters: Record<string, unknown>,
    options?: InsertOptions,
  ): Promise<BatchWriteResult> {
    const projectId = this.getProjectId(database);
    const dataset = options?.schema;
    if (!dataset) {
      return {
        success: false,
        rowsWritten: 0,
        error: "Dataset (schema) is required for BigQuery",
      };
    }

    const fullTableName = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(tableName)}`;

    const conditions = Object.entries(keyFilters).map(([col, val]) => {
      if (val === null || val === undefined) {
        return `${escapeIdentifier(col)} IS NULL`;
      }
      const escaped = escapeForBigQueryString(String(val));
      return `${escapeIdentifier(col)} = '${escaped}'`;
    });

    if (conditions.length === 0) {
      return {
        success: false,
        rowsWritten: 0,
        error: "No key filters provided for delete",
      };
    }

    const query = `DELETE FROM ${fullTableName} WHERE ${conditions.join(" AND ")};`;
    const result = await this.executeQuery(database, query);

    return {
      success: result.success,
      rowsWritten: result.success ? 1 : 0,
      error: result.error,
    };
  }
}
