import { BatchWriteResult, InsertOptions, UpsertOptions } from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";
import { escapeIdentifier, formatBigQueryValue } from "./sql-values";
import { BigQueryDriverCore } from "./driver-core";

/** Batch INSERT and MERGE (upsert) of rows, chunked under BigQuery's query size limit. */
export class BigQueryBatchWriteDriver extends BigQueryDriverCore {
  /**
   * Insert a batch of rows into a table using INSERT statement
   * BigQuery has a 1MB query size limit, so we chunk adaptively based on query size
   */
  async insertBatch(
    database: IDatabaseConnection,
    tableName: string,
    rows: Record<string, unknown>[],
    options?: InsertOptions,
  ): Promise<BatchWriteResult> {
    if (rows.length === 0) {
      return { success: true, rowsWritten: 0 };
    }

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

    // Add any missing columns before writing
    await this.addMissingColumns(database, tableName, dataset, rows);

    // Get column types from INFORMATION_SCHEMA (after adding missing columns)
    let columnTypes = await this.getCachedTableColumnTypes(
      database,
      tableName,
      dataset,
    );

    if (columnTypes.size === 0) {
      this.logger.warn(
        "INFORMATION_SCHEMA returned no column types, forcing refresh",
        {
          table: tableName,
          dataset,
        },
      );
      columnTypes = await this.getCachedTableColumnTypes(
        database,
        tableName,
        dataset,
        true,
      );
    }

    const allColumns = new Set<string>();
    for (const row of rows) {
      Object.keys(row).forEach(k => allColumns.add(k));
    }
    const columns = Array.from(allColumns);
    const columnList = columns.map(escapeIdentifier).join(", ");

    const MAX_QUERY_SIZE = 900_000;
    let chunkSize = 1000; // Start smaller to be safe
    let totalWritten = 0;

    for (let i = 0; i < rows.length;) {
      // Build query for current chunk using VALUES syntax (more compact than SELECT...UNION ALL)
      let chunk = rows.slice(i, i + chunkSize);
      let query = this.buildInsertQuery(
        fullTableName,
        columnList,
        columns,
        chunk,
        columnTypes,
      );

      // If query is too large, reduce chunk size and retry
      while (query.length > MAX_QUERY_SIZE && chunkSize > 1) {
        chunkSize = Math.max(1, Math.floor(chunkSize / 2));
        chunk = rows.slice(i, i + chunkSize);
        query = this.buildInsertQuery(
          fullTableName,
          columnList,
          columns,
          chunk,
          columnTypes,
        );
      }

      // If still too large with minimum chunk size, fail with helpful error
      if (query.length > MAX_QUERY_SIZE) {
        return {
          success: false,
          rowsWritten: totalWritten,
          error: `Query size (${Math.round(query.length / 1024)}KB) exceeds BigQuery limit even with minimum batch size. Consider reducing data size per row or using BigQuery load jobs for very large data.`,
        };
      }

      let result = await this.executeQuery(database, query);
      let retryCount = 0;
      while (
        !result.success &&
        retryCount < 3 &&
        typeof result.error === "string"
      ) {
        const missingColumnError =
          result.error.includes("is not present in table") ||
          result.error.includes("Unrecognized name:");
        const requiredNullColumn = this.extractRequiredNullField(result.error);
        if (!missingColumnError && !requiredNullColumn) {
          break;
        }

        if (missingColumnError) {
          await this.addMissingColumns(database, tableName, dataset, chunk);
          columnTypes = await this.getCachedTableColumnTypes(
            database,
            tableName,
            dataset,
            true,
          );
          const retryColumns = Array.from(allColumns);
          const retryColumnList = retryColumns.map(escapeIdentifier).join(", ");
          query = this.buildInsertQuery(
            fullTableName,
            retryColumnList,
            retryColumns,
            chunk,
            columnTypes,
          );
        }

        if (requiredNullColumn) {
          const relax = await this.relaxRequiredColumn(
            database,
            tableName,
            dataset,
            requiredNullColumn,
          );
          if (!relax.success) {
            this.logger.warn("Failed to relax required column", {
              table: tableName,
              dataset,
              column: requiredNullColumn,
              error: relax.error,
            });
            break;
          }
        }

        await new Promise(resolve =>
          setTimeout(resolve, 500 * (retryCount + 1)),
        );
        result = await this.executeQuery(database, query);
        retryCount += 1;
      }

      if (!result.success) {
        const preview =
          rows.length > 0 ? JSON.stringify(rows[0]).slice(0, 1000) : "{}";
        this.logger.error("BigQuery insert failed", {
          table: tableName,
          dataset,
          error: result.error,
          retryCount,
          queryPreview: query.slice(0, 2000),
          firstRowPreview: preview,
          columnTypes: Object.fromEntries(columnTypes.entries()),
        });
        return {
          success: false,
          rowsWritten: totalWritten,
          error: result.error,
        };
      }

      totalWritten += chunk.length;
      i += chunk.length;

      // If query was well under the limit, try increasing chunk size for efficiency
      if (query.length < MAX_QUERY_SIZE * 0.5 && chunkSize < 2000) {
        chunkSize = Math.min(chunkSize * 2, 2000);
      }
    }

    return { success: true, rowsWritten: totalWritten };
  }

  /**
   * Build an INSERT query using VALUES syntax (more compact than SELECT...UNION ALL)
   * @param columnTypes - Optional map of column name -> BigQuery type for type coercion
   */
  protected buildInsertQuery(
    fullTableName: string,
    columnList: string,
    columns: string[],
    rows: Record<string, unknown>[],
    columnTypes?: Map<string, string>,
  ): string {
    // Use VALUES syntax: INSERT INTO table (cols) VALUES (v1, v2), (v1, v2), ...
    const valueRows = rows.map(row => {
      const values = columns.map(col => {
        // Use lowercase for case-insensitive lookup
        const targetType = columnTypes?.get(col.toLowerCase());
        return formatBigQueryValue(row[col], targetType, true);
      });
      return `(${values.join(", ")})`;
    });

    return `INSERT INTO ${fullTableName} (${columnList}) VALUES\n${valueRows.join(",\n")};`;
  }

  /**
   * Upsert a batch of rows using MERGE statement
   * Chunks data adaptively to stay under BigQuery's 1MB query limit
   */
  async upsertBatch(
    database: IDatabaseConnection,
    tableName: string,
    rows: Record<string, unknown>[],
    keyColumns: string[],
    options?: UpsertOptions,
  ): Promise<BatchWriteResult> {
    if (rows.length === 0) {
      return { success: true, rowsWritten: 0 };
    }

    if (keyColumns.length === 0) {
      return {
        success: false,
        rowsWritten: 0,
        error: "Key columns required for upsert",
      };
    }

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
    const strategy = options?.conflictStrategy || "update";

    // Add any missing columns before writing
    await this.addMissingColumns(database, tableName, dataset, rows);

    // Get column types from INFORMATION_SCHEMA (after adding missing columns)
    let columnTypes = await this.getCachedTableColumnTypes(
      database,
      tableName,
      dataset,
    );

    if (columnTypes.size === 0) {
      this.logger.warn(
        "INFORMATION_SCHEMA returned no column types, forcing refresh",
        {
          table: tableName,
          dataset,
        },
      );
      columnTypes = await this.getCachedTableColumnTypes(
        database,
        tableName,
        dataset,
        true,
      );
    }

    // Get all unique column names from all rows
    const allColumns = new Set<string>();
    for (const row of rows) {
      Object.keys(row).forEach(k => allColumns.add(k));
    }
    let columns = Array.from(allColumns);

    // BigQuery has a 1MB (1,024,000 chars) query limit
    const MAX_QUERY_SIZE = 900_000; // Leave some buffer below 1MB
    let chunkSize = 500; // MERGE is more verbose, start smaller
    let totalWritten = 0;

    for (let i = 0; i < rows.length;) {
      // Build MERGE query for current chunk
      let chunk = rows.slice(i, i + chunkSize);
      let query = this.buildMergeQuery(
        fullTableName,
        columns,
        chunk,
        keyColumns,
        strategy,
        columnTypes,
      );

      // If query is too large, reduce chunk size and retry
      while (query.length > MAX_QUERY_SIZE && chunkSize > 1) {
        chunkSize = Math.max(1, Math.floor(chunkSize / 2));
        chunk = rows.slice(i, i + chunkSize);
        query = this.buildMergeQuery(
          fullTableName,
          columns,
          chunk,
          keyColumns,
          strategy,
          columnTypes,
        );
      }

      // If still too large with minimum chunk size, fail with helpful error
      if (query.length > MAX_QUERY_SIZE) {
        return {
          success: false,
          rowsWritten: totalWritten,
          error: `MERGE query size (${Math.round(query.length / 1024)}KB) exceeds BigQuery limit even with minimum batch size. Consider reducing data size per row.`,
        };
      }

      let result = await this.executeQuery(database, query);
      let retryCount = 0;
      while (
        !result.success &&
        retryCount < 3 &&
        typeof result.error === "string"
      ) {
        const missingColumnError =
          result.error.includes("is not present in table") ||
          result.error.includes("Unrecognized name:");
        const requiredNullColumn = this.extractRequiredNullField(result.error);
        if (!missingColumnError && !requiredNullColumn) {
          break;
        }

        if (missingColumnError) {
          await this.addMissingColumns(database, tableName, dataset, chunk);
          columnTypes = await this.getCachedTableColumnTypes(
            database,
            tableName,
            dataset,
            true,
          );
          columns = Array.from(allColumns);
          query = this.buildMergeQuery(
            fullTableName,
            columns,
            chunk,
            keyColumns,
            strategy,
            columnTypes,
          );
        }

        if (requiredNullColumn) {
          const relax = await this.relaxRequiredColumn(
            database,
            tableName,
            dataset,
            requiredNullColumn,
          );
          if (!relax.success) {
            this.logger.warn("Failed to relax required column for merge", {
              table: tableName,
              dataset,
              column: requiredNullColumn,
              error: relax.error,
            });
            break;
          }
        }

        await new Promise(resolve =>
          setTimeout(resolve, 500 * (retryCount + 1)),
        );
        result = await this.executeQuery(database, query);
        retryCount += 1;
      }

      if (!result.success) {
        const preview =
          rows.length > 0 ? JSON.stringify(rows[0]).slice(0, 1000) : "{}";
        this.logger.error("BigQuery merge failed", {
          table: tableName,
          dataset,
          error: result.error,
          queryPreview: query.slice(0, 2000),
          firstRowPreview: preview,
          columnTypes: Object.fromEntries(columnTypes.entries()),
        });
        return {
          success: false,
          rowsWritten: totalWritten,
          error: result.error,
        };
      }

      totalWritten += chunk.length;
      i += chunk.length;

      // If query was well under the limit, try increasing chunk size for efficiency
      if (query.length < MAX_QUERY_SIZE * 0.5 && chunkSize < 1000) {
        chunkSize = Math.min(chunkSize * 2, 1000);
      }
    }

    return { success: true, rowsWritten: totalWritten };
  }

  /**
   * Build a MERGE query using a more compact source format
   * Uses UNNEST with STRUCT array for better efficiency than SELECT...UNION ALL
   * @param columnTypes - Optional map of column name -> BigQuery type for type coercion
   *
   * IMPORTANT: We use SAFE_CAST for all values in STRUCTs to ensure consistent types.
   * Without this, if source data has mixed types (e.g., template_id is INT64 in one row
   * and STRING in another), BigQuery throws "Array elements of types do not have a
   * common supertype" because each STRUCT would have a different schema.
   */
  protected buildMergeQuery(
    fullTableName: string,
    columns: string[],
    rows: Record<string, unknown>[],
    keyColumns: string[],
    strategy: string,
    columnTypes?: Map<string, string>,
  ): string {
    // Build source data using UNNEST with STRUCT - more compact than SELECT...UNION ALL
    // Format: UNNEST([STRUCT(v1 AS c1, v2 AS c2), STRUCT(v1 AS c1, v2 AS c2), ...])
    // We use useCast=true to ensure all STRUCTs have consistent column types via SAFE_CAST
    const structRows = rows.map(row => {
      const values = columns.map(col => {
        // Use lowercase for case-insensitive lookup
        const targetType = columnTypes?.get(col.toLowerCase());
        // useCast=true ensures consistent types across all STRUCTs in the array
        return `${formatBigQueryValue(row[col], targetType, true)} AS ${escapeIdentifier(col)}`;
      });
      return `STRUCT(${values.join(", ")})`;
    });

    const sourceQuery = `UNNEST([${structRows.join(", ")}])`;

    // Build MERGE conditions
    const joinConditions = keyColumns
      .map(k => `T.${escapeIdentifier(k)} = S.${escapeIdentifier(k)}`)
      .join(" AND ");

    // Build update and insert columns
    const nonKeyColumns = columns.filter(c => !keyColumns.includes(c));
    const updateClause =
      nonKeyColumns.length > 0
        ? `UPDATE SET ${nonKeyColumns.map(c => `${escapeIdentifier(c)} = S.${escapeIdentifier(c)}`).join(", ")}`
        : "";
    const hasSourceOrdering =
      columns.includes("_mako_source_ts") &&
      !keyColumns.includes("_mako_source_ts");
    const hasIngestOrdering =
      columns.includes("_mako_ingest_seq") &&
      !keyColumns.includes("_mako_ingest_seq");
    const matchedGuard = hasSourceOrdering
      ? ` AND COALESCE(S.${escapeIdentifier("_mako_source_ts")}, TIMESTAMP('1970-01-01 00:00:00 UTC')) >= COALESCE(T.${escapeIdentifier("_mako_source_ts")}, TIMESTAMP('1970-01-01 00:00:00 UTC'))`
      : hasIngestOrdering
        ? ` AND COALESCE(S.${escapeIdentifier("_mako_ingest_seq")}, -1) >= COALESCE(T.${escapeIdentifier("_mako_ingest_seq")}, -1)`
        : "";
    const insertColumns = columns.map(escapeIdentifier).join(", ");
    const insertValues = columns
      .map(c => `S.${escapeIdentifier(c)}`)
      .join(", ");

    if (strategy === "ignore") {
      // Only insert if not matched
      return `
        MERGE INTO ${fullTableName} T
        USING ${sourceQuery} AS S
        ON ${joinConditions}
        WHEN NOT MATCHED THEN
          INSERT (${insertColumns}) VALUES (${insertValues});
      `;
    } else {
      // Update when matched, insert when not matched
      return `
        MERGE INTO ${fullTableName} T
        USING ${sourceQuery} AS S
        ON ${joinConditions}
        ${updateClause ? `WHEN MATCHED${matchedGuard} THEN ${updateClause}` : ""}
        WHEN NOT MATCHED THEN
          INSERT (${insertColumns}) VALUES (${insertValues});
      `;
    }
  }
}
