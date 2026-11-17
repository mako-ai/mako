/**
 * Unified destination writer: one interface over MongoDB collections and
 * SQL tables (PostgreSQL, BigQuery, …), so the sync orchestrator writes the
 * same way whether rows come from an API connector or a database query.
 *
 * The MongoDB engine lives in `mongo-target.ts`; the SQL engine is the
 * driver-backed half of this class (it shares the writer's inferred schema,
 * table cache and staging state).
 */
import { inWorkspace } from "../../utils/workspace-scope";
import { Types } from "mongoose";
import {
  DatabaseConnection,
  IDatabaseConnection,
  ITableDestination,
} from "../../database/workspace-schema";
import {
  BatchWriteResult,
  ColumnDefinition,
  DatabaseDriver,
  InsertOptions,
  TableClustering,
  TablePartitioning,
} from "../../databases/driver";
import { databaseRegistry } from "../../databases/registry";
import { loggers } from "../../logging";
import {
  ConnectionConfig,
  databaseConnectionService,
} from "../database-connection.service";
import {
  cleanupMongoStaging,
  deleteFromMongoByKeys,
  finalizeMongoSync,
  prepareMongoStaging,
  writeBatchToMongo,
} from "./mongo-target";
import { applyTypeCoercionsToSchema } from "./type-coercion";
import type { DestinationConfig, WriteOptions, WriteResult } from "./types";

const log = loggers.sync("destination-writer");

/**
 * Unified destination writer that handles both MongoDB and SQL destinations
 */
export class DestinationWriter {
  private config: DestinationConfig;
  private driver?: DatabaseDriver;
  private connection?: IDatabaseConnection;
  private stagingActive = false;
  private inferredColumns?: ColumnDefinition[];
  private columnTypeMap: Map<string, string> | null = null; // Mapped types for BigQuery writes
  private existingSqlTables = new Set<string>();
  private ensuredSqlSchemas = new Set<string>();

  constructor(config: DestinationConfig) {
    this.config = config;
  }

  /**
   * Test-only seam: inject a driver + connection directly, bypassing the
   * Mongoose lookup + registry resolution that `initialize()` performs. Lets
   * unit tests exercise the engine-agnostic orchestration (column-type mapping,
   * working-schema selection) without a database. Not used in production code.
   *
   * @internal
   */
  _injectForTest(
    driver: DatabaseDriver,
    connection: IDatabaseConnection,
  ): void {
    this.driver = driver;
    this.connection = connection;
  }

  /**
   * Build InsertOptions with layout config from tableDestination
   */
  private getInsertOptionsWithLayout(): InsertOptions {
    const td = this.config.tableDestination;
    const opts: InsertOptions = { schema: td?.schema };

    if (td?.partitioning?.enabled) {
      opts.partitioning = {
        type: td.partitioning.type || "time",
        field: td.partitioning.field,
        granularity: td.partitioning.granularity,
        requirePartitionFilter: td.partitioning.requirePartitionFilter,
      } as TablePartitioning;
    }

    if (td?.clustering?.enabled && td.clustering.fields?.length) {
      opts.clustering = { fields: td.clustering.fields } as TableClustering;
    }

    if (this.config.deleteMode === "soft") {
      opts.softDeleteColumns = {
        isDeleted: "is_deleted",
        deletedAt: "deleted_at",
      };
    }

    return opts;
  }

  private getWorkingSchema(primarySchema?: string): string | undefined {
    return this.driver?.getStagingSchema?.(primarySchema) ?? primarySchema;
  }

  /**
   * Map inferred source column types to the destination's native types and,
   * when the driver requires it, build the `columnTypes` map used for typed
   * writes. No-op for destinations whose driver doesn't override these.
   */
  private applyDestinationColumnTypes(): void {
    if (!this.inferredColumns) return;
    const driver = this.driver;
    const mapColumnType = driver?.mapColumnType?.bind(driver);
    if (mapColumnType) {
      this.inferredColumns = this.inferredColumns.map(c => ({
        ...c,
        type: mapColumnType(c.type),
      }));
    }
    if (driver?.requiresTypedColumns?.()) {
      this.columnTypeMap = new Map(
        this.inferredColumns.map(c => [c.name.toLowerCase(), c.type]),
      );
    }
  }

  private getTargetSchema(
    primarySchema: string | undefined,
    useWorking: boolean,
  ): string | undefined {
    if (useWorking) {
      return this.getWorkingSchema(primarySchema);
    }
    return primarySchema;
  }

  private async ensureSchemaForWrite(schema?: string): Promise<void> {
    if (!schema || !this.driver?.ensureSchema || !this.connection) {
      return;
    }

    const createIfNotExists = this.config.tableDestination?.createIfNotExists;
    // Always ensure a dedicated staging/working schema exists, even when the
    // user didn't opt into table auto-creation (e.g. BigQuery's working dataset).
    const stagingSchema = this.driver?.getStagingSchema?.(schema);
    const shouldEnsure =
      createIfNotExists ||
      (stagingSchema !== undefined && schema === stagingSchema);
    if (!shouldEnsure || this.ensuredSqlSchemas.has(schema)) {
      return;
    }

    const result = await this.driver.ensureSchema(this.connection, schema);
    if (!result.success) {
      throw new Error(`Failed to ensure dataset: ${result.error}`);
    }
    this.ensuredSqlSchemas.add(schema);
  }

  /**
   * Initialize the writer (connect to destination if needed)
   */
  async initialize(): Promise<void> {
    if (this.config.tableDestination) {
      // Load the database connection for SQL destination
      const conn = await DatabaseConnection.findOne(
        inWorkspace(
          this.config.tableDestination.connectionId,
          this.config.workspaceId,
        ),
      );
      if (!conn) {
        throw new Error(
          `Database connection not found: ${this.config.tableDestination.connectionId}`,
        );
      }
      this.connection = conn;

      // Get the appropriate driver
      this.driver = databaseRegistry.getDriver(conn.type);
      if (!this.driver) {
        throw new Error(`No driver found for database type: ${conn.type}`);
      }

      // Check if driver supports writes
      if (!this.driver.supportsWrites?.()) {
        throw new Error(
          `Database driver ${conn.type} does not support write operations`,
        );
      }

      // Auto-create dataset/schema if needed
      const td = this.config.tableDestination;
      if (td?.schema) {
        await this.ensureSchemaForWrite(td.schema);
      }
    }
  }

  /** The MongoDB collection written when there is no table destination. */
  getCollectionName(): string | undefined {
    return this.config?.collectionName;
  }

  setCollectionName(collectionName: string): void {
    this.config.collectionName = collectionName;
  }

  /**
   * Treat a staging table/collection prepared by an earlier step as active,
   * so `finalize()` swaps it in (or `cleanup()` drops it). Chunked runs
   * prepare staging in one Inngest step and finish in another, each with a
   * fresh writer.
   */
  markStagingActive(): void {
    this.stagingActive = true;
  }

  /**
   * Determine if we're writing to a SQL table or MongoDB
   */
  isTableDestination(): boolean {
    return !!this.config.tableDestination?.tableName;
  }

  /**
   * Get the target table/collection name
   */
  getTargetName(): string {
    if (this.config.tableDestination?.tableName) {
      return this.config.tableDestination.tableName;
    }
    return this.config.collectionName || "unknown";
  }

  /**
   * Prepare for full sync (create staging table/collection if needed)
   */
  async prepareFullSync(options: WriteOptions = {}): Promise<void> {
    if (this.isTableDestination()) {
      await this.prepareSqlStaging(options);
    } else {
      await prepareMongoStaging(this.config, options);
    }
    this.stagingActive = true;
  }

  /**
   * Write a batch of rows to the destination
   */
  async writeBatch(
    rows: Record<string, unknown>[],
    options: WriteOptions = {},
  ): Promise<WriteResult> {
    if (rows.length === 0) {
      return { success: true, rowsWritten: 0 };
    }

    if (this.isTableDestination()) {
      return this.writeBatchToTable(rows, options);
    } else {
      return writeBatchToMongo(this.config, rows, options, this.stagingActive);
    }
  }

  /**
   * Finalize the sync (swap staging table/collection if full sync)
   */
  async finalize(options: WriteOptions = {}): Promise<void> {
    if (!this.stagingActive) {
      return;
    }

    if (this.isTableDestination()) {
      await this.finalizeSqlSync(options);
    } else {
      await finalizeMongoSync(this.config, options);
    }
    this.stagingActive = false;
  }

  /**
   * Clean up on failure (drop staging table/collection)
   */
  async cleanup(options: WriteOptions = {}): Promise<void> {
    if (!this.stagingActive) {
      return;
    }

    if (this.isTableDestination()) {
      await this.cleanupSqlStaging(options);
    } else {
      await cleanupMongoStaging(this.config, options);
    }
    this.stagingActive = false;
  }

  /**
   * Delete rows matching key filters from the destination
   * For SQL: delegates to driver.deleteBatch
   * For Mongo: uses collection.deleteOne
   */
  async deleteByKeys(
    keyFilters: Record<string, unknown>,
  ): Promise<WriteResult> {
    if (this.isTableDestination()) {
      if (!this.driver || !this.connection || !this.config.tableDestination) {
        return {
          success: false,
          rowsWritten: 0,
          error: "SQL destination not configured",
        };
      }
      const result = await this.driver.deleteBatch?.(
        this.connection,
        this.config.tableDestination.tableName,
        keyFilters,
        this.getInsertOptionsWithLayout(),
      );
      if (!result) {
        return {
          success: false,
          rowsWritten: 0,
          error: "Driver does not support deleteBatch",
        };
      }
      return {
        success: result.success,
        rowsWritten: result.rowsWritten,
        error: result.error,
      };
    }

    return deleteFromMongoByKeys(this.config, keyFilters);
  }

  // ============ SQL Table Implementation ============

  private async prepareSqlStaging(options: WriteOptions): Promise<void> {
    if (!this.driver || !this.connection || !this.config.tableDestination) {
      throw new Error("SQL destination not configured");
    }

    const { tableName, schema: primarySchema } = this.config.tableDestination;
    const stagingName = options.stagingTableName || `${tableName}_staging`;
    const stagingSchema = this.getTargetSchema(primarySchema, true);
    const layoutOpts: InsertOptions = {
      ...this.getInsertOptionsWithLayout(),
      schema: primarySchema,
      stagingSchema,
    };

    await this.ensureSchemaForWrite(stagingSchema);

    // Always reset staging at the start of a new full sync run so stale rows
    // from interrupted previous runs cannot leak into the next swap.
    if (this.driver.dropTable) {
      const dropResult = await this.driver.dropTable(
        this.connection,
        stagingName,
        { schema: stagingSchema },
      );
      if (!dropResult.success) {
        throw new Error(
          `Failed to reset staging table: ${dropResult.error || "Unknown error"}`,
        );
      }
    }

    // Check if original table exists
    const tableExists = await this.driver.tableExists?.(
      this.connection,
      tableName,
      { schema: primarySchema },
    );

    if (tableExists) {
      const result = await this.driver.createStagingTable?.(
        this.connection,
        tableName,
        stagingName,
        layoutOpts,
      );

      if (!result?.success) {
        throw new Error(
          `Failed to create staging table: ${result?.error || "Unknown error"}`,
        );
      }
    }
    // If original doesn't exist, we'll create it when we get the first batch
  }

  private async writeBatchToTable(
    rows: Record<string, unknown>[],
    options: WriteOptions,
  ): Promise<WriteResult> {
    if (!this.driver || !this.connection || !this.config.tableDestination) {
      return {
        success: false,
        rowsWritten: 0,
        error: "SQL destination not configured",
      };
    }

    const {
      tableName,
      schema: primarySchema,
      createIfNotExists,
    } = this.config.tableDestination;
    const targetTable = this.stagingActive
      ? options.stagingTableName || `${tableName}_staging`
      : tableName;
    const targetSchema = this.getTargetSchema(
      primarySchema,
      this.stagingActive,
    );
    const tableCacheKey = `${targetSchema || ""}.${targetTable}`;

    try {
      await this.ensureSchemaForWrite(targetSchema);

      // Check if table exists, create if needed.
      // Cache existence per writer instance to avoid expensive INFORMATION_SCHEMA
      // lookups on every small batch.
      let tableExists = this.existingSqlTables.has(tableCacheKey);
      if (!tableExists) {
        tableExists = !!(await this.driver.tableExists?.(
          this.connection,
          targetTable,
          { schema: targetSchema },
        ));
        if (tableExists) {
          this.existingSqlTables.add(tableCacheKey);
        }
      }

      if (!tableExists && createIfNotExists) {
        // Get schema for table creation
        // Priority order:
        // 1. typeCoercions (explicit user-defined schema from ETL mapping) - AUTHORITATIVE
        // 2. sourceSchema (pre-fetched from source database)
        // 3. inferred from data (fallback, less reliable for NULLs)
        if (!this.inferredColumns) {
          // Priority 1: Use typeCoercions as AUTHORITATIVE schema if available
          // This is the explicit mapping configured by the user in the schema mapping step
          if (options.typeCoercions && options.typeCoercions.length > 0) {
            // Convert typeCoercions directly to column definitions
            // The targetType from typeCoercions IS the authoritative destination type
            this.inferredColumns = options.typeCoercions.map(tc => ({
              name: tc.column,
              type: tc.targetType, // Use targetType directly (already in destination format)
              nullable: true, // Default to nullable for safety
            }));

            // typeCoercions are already in the destination's native format;
            // just record them for typed writes when the driver needs them.
            if (this.driver?.requiresTypedColumns?.()) {
              this.columnTypeMap = new Map(
                this.inferredColumns.map(c => [c.name.toLowerCase(), c.type]),
              );
            }
          }
          // Priority 2: Use pre-fetched source schema (most reliable after explicit mapping)
          else if (options.sourceSchema && options.sourceSchema.length > 0) {
            this.inferredColumns = options.sourceSchema;

            // Apply type coercions as overrides if present
            if (options.typeCoercions && options.typeCoercions.length > 0) {
              this.inferredColumns = applyTypeCoercionsToSchema(
                this.inferredColumns,
                options.typeCoercions,
              );
            }

            this.applyDestinationColumnTypes();
          } else {
            // Priority 3: Fallback to inferring from data (less reliable for NULLs)
            this.inferredColumns = this.driver.inferSchema?.(rows);
            if (!this.inferredColumns) {
              throw new Error("Failed to infer schema from data");
            }

            // Defensive default: inferred webhook/CDC schemas can miss nullability
            // when first batches don't contain null values yet.
            this.inferredColumns = this.inferredColumns.map(c => ({
              ...c,
              nullable: true,
            }));

            this.applyDestinationColumnTypes();
          }
        }

        // Create table with layout config
        const createResult = await this.driver.createTable?.(
          this.connection,
          targetTable,
          this.inferredColumns,
          {
            ...this.getInsertOptionsWithLayout(),
            schema: targetSchema,
          },
        );

        if (!createResult?.success) {
          throw new Error(
            `Failed to create table: ${createResult?.error || "Unknown error"}`,
          );
        }
        this.existingSqlTables.add(tableCacheKey);
      }

      // Ensure destination table has all columns present in this batch.
      // Connector payloads (e.g. Close leads) can introduce new fields in later
      // batches that weren't in the schema when the table was first created.
      if (this.driver.addMissingColumns) {
        const schemaForEvolution =
          targetSchema || this.getWorkingSchema(primarySchema) || "public";
        await this.driver.addMissingColumns(
          this.connection,
          targetTable,
          schemaForEvolution,
          rows,
        );
      }

      // Write data
      let result: BatchWriteResult;

      if (
        options.keyColumns &&
        options.keyColumns.length > 0 &&
        !this.stagingActive
      ) {
        // Upsert for incremental sync
        result = (await this.driver.upsertBatch?.(
          this.connection,
          targetTable,
          rows,
          options.keyColumns,
          {
            schema: targetSchema,
            conflictStrategy: options.conflictStrategy || "update",
            columnTypes: this.columnTypeMap ?? undefined,
          },
        )) || { success: false, rowsWritten: 0, error: "Upsert not supported" };
      } else {
        // Insert for full sync (staging) or when no key columns
        result = (await this.driver.insertBatch?.(
          this.connection,
          targetTable,
          rows,
          {
            schema: targetSchema,
            columnTypes: this.columnTypeMap ?? undefined,
          },
        )) || { success: false, rowsWritten: 0, error: "Insert not supported" };
      }

      return result;
    } catch (error) {
      return {
        success: false,
        rowsWritten: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async finalizeSqlSync(options: WriteOptions): Promise<void> {
    if (!this.driver || !this.connection || !this.config.tableDestination) {
      throw new Error("SQL destination not configured");
    }

    const { tableName, schema: primarySchema } = this.config.tableDestination;
    const stagingName = options.stagingTableName || `${tableName}_staging`;
    const stagingSchema = this.getTargetSchema(primarySchema, true);

    const result = await this.driver.swapStagingTable?.(
      this.connection,
      tableName,
      stagingName,
      {
        ...this.getInsertOptionsWithLayout(),
        schema: primarySchema,
        stagingSchema,
      },
    );

    if (!result?.success) {
      throw new Error(
        `Failed to swap staging table: ${result?.error || "Unknown error"}`,
      );
    }

    // Post-swap safety: ensure staging table name is cleaned up as well.
    // Some drivers already consume/drop staging during swap, so this is
    // idempotent, and best-effort: the swap above has committed the new rows.
    // Throwing here fails the step after the staging table is gone, so every
    // retry re-runs the swap against a missing staging table and fails until
    // the retries run out. BigQuery rejects this second DDL on the same table
    // within seconds ("exceeded quota for table update operations"); the next
    // full sync drops the staging name before it writes anyway.
    if (this.driver.dropTable) {
      try {
        const dropResult = await this.driver.dropTable(
          this.connection,
          stagingName,
          { schema: stagingSchema },
        );
        if (!dropResult.success) {
          log.warn("Could not drop staging table after a successful swap", {
            table: tableName,
            stagingTable: stagingName,
            stagingSchema,
            error: dropResult.error,
          });
        }
      } catch (error) {
        log.warn("Could not drop staging table after a successful swap", {
          table: tableName,
          stagingTable: stagingName,
          stagingSchema,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async cleanupSqlStaging(options: WriteOptions): Promise<void> {
    if (!this.driver || !this.connection || !this.config.tableDestination) {
      return;
    }

    const { tableName, schema: primarySchema } = this.config.tableDestination;
    const stagingName = options.stagingTableName || `${tableName}_staging`;
    const stagingSchema = this.getTargetSchema(primarySchema, true);

    try {
      await this.driver.dropTable?.(this.connection, stagingName, {
        schema: stagingSchema,
      });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Factory function to create a destination writer from flow configuration
 */
export async function createDestinationWriter(
  flow: {
    /** The flow's workspace: the destination is looked up in it only. */
    workspaceId: Types.ObjectId | string;
    destinationDatabaseId: Types.ObjectId;
    destinationDatabaseName?: string;
    tableDestination?: ITableDestination;
    dataSourceId?: Types.ObjectId;
  },
  dataSourceName?: string,
): Promise<DestinationWriter> {
  const config: DestinationConfig = {
    workspaceId: String(flow.workspaceId),
    dataSourceId: flow.dataSourceId?.toString(),
    dataSourceName,
  };

  if (flow.tableDestination?.tableName) {
    // SQL table destination
    config.tableDestination = flow.tableDestination;
  } else {
    // MongoDB destination (default)
    const connectionIdentifier = flow.destinationDatabaseName
      ? `${flow.destinationDatabaseId}:${flow.destinationDatabaseName}`
      : flow.destinationDatabaseId.toString();

    const connection = await databaseConnectionService.getConnectionById(
      "destination",
      connectionIdentifier,
      async (id: string) => {
        const realDestinationId = id.includes(":") ? id.split(":")[0] : id;
        const destConn = await DatabaseConnection.findOne(
          inWorkspace(realDestinationId, flow.workspaceId),
        );
        if (!destConn) return null;

        return {
          connectionString:
            destConn.connection.connectionString ||
            `mongodb://${destConn.connection.host}:${destConn.connection.port}`,
          database:
            flow.destinationDatabaseName || destConn.connection.database,
        } as ConnectionConfig;
      },
    );

    config.mongoDb = connection.db;
  }

  const writer = new DestinationWriter(config);
  await writer.initialize();

  return writer;
}
