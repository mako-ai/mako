/**
 * Database-to-database sync: one resumable chunk at a time (offset or
 * keyset pagination), and the dry run the flow editor previews with.
 */
import {
  IDatabaseConnection,
  IIncrementalConfig,
  IPaginationConfig,
  ITypeCoercion,
} from "../../database/workspace-schema";
import { databaseRegistry } from "../../databases/registry";
import {
  buildChunkQuery,
  keysetCursorAfter,
  maxTrackingValue,
} from "../db-sync-pagination";
import { estimateQueryRowCount } from "./query-introspection";
import { checkQuerySafety, type QuerySafetyResult } from "./query-safety";
import { applyTypeCoercions } from "./type-coercion";
import type { DbSyncChunkResult, DbSyncChunkState } from "./types";
import { DestinationWriter } from "./writer";

/**
 * Helper function to infer JavaScript type from a value
 */
function inferJsType(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (value instanceof Date) return "date";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return "unknown";
}

/**
 * Execute a single chunk of database sync with pagination
 * Supports both offset-based and keyset pagination
 * Returns state for resumption in the next chunk
 */
export async function executeDbSyncChunk(options: {
  sourceConnection: IDatabaseConnection;
  sourceQuery: string;
  sourceDatabase?: string;
  destinationWriter: DestinationWriter;
  batchSize?: number;
  syncMode: "full" | "incremental";
  incrementalConfig?: IIncrementalConfig;
  paginationConfig?: IPaginationConfig;
  typeCoercions?: ITypeCoercion[];
  keyColumns?: string[];
  state?: DbSyncChunkState;
  maxRowsPerChunk?: number;
  onProgress?: (rowsProcessed: number, estimatedTotal?: number) => void;
}): Promise<DbSyncChunkResult> {
  const {
    sourceConnection,
    sourceQuery,
    sourceDatabase,
    destinationWriter,
    batchSize = 2000,
    syncMode,
    incrementalConfig,
    paginationConfig,
    typeCoercions,
    keyColumns,
    state,
    maxRowsPerChunk = 5000,
    onProgress,
  } = options;

  const driver = databaseRegistry.getDriver(sourceConnection.type);
  if (!driver) {
    return {
      state: { offset: 0, totalProcessed: 0, hasMore: false },
      rowsProcessed: 0,
      completed: true,
      error: `No driver found for source type: ${sourceConnection.type}`,
    };
  }

  // Initialize or restore state
  const currentState: DbSyncChunkState = state || {
    offset: 0,
    totalProcessed: 0,
    hasMore: true,
    stagingPrepared: false,
  };

  // Estimate total rows on first chunk (if not already done)
  if (!currentState.estimatedTotal && currentState.offset === 0) {
    const countResult = await estimateQueryRowCount(
      sourceConnection,
      sourceQuery,
      sourceDatabase,
    );
    if (countResult.success) {
      currentState.estimatedTotal = countResult.estimatedCount;
    }
  }

  // Get source schema on first chunk (more reliable than inferring from data)
  // This uses the source database's metadata rather than sampling data values
  if (!currentState.sourceSchema && currentState.offset === 0) {
    if (driver.getQuerySchema) {
      const schemaResult = await driver.getQuerySchema(
        sourceConnection,
        sourceQuery,
        { databaseName: sourceDatabase },
      );
      if (schemaResult.success && schemaResult.columns) {
        currentState.sourceSchema = schemaResult.columns;
      }
      // If getQuerySchema fails, we'll fall back to inferSchema when writing
    }
  }

  // Prepare staging on first chunk for full sync
  if (syncMode === "full" && !currentState.stagingPrepared) {
    await destinationWriter.prepareFullSync({
      sourceSchema: currentState.sourceSchema,
      typeCoercions,
    });
    currentState.stagingPrepared = true;
  } else if (syncMode === "full" && currentState.stagingPrepared) {
    // Restore staging state for subsequent chunks (new writer instances
    // default to stagingActive=false, but staging was already prepared)
    (destinationWriter as any).stagingActive = true;
  }

  // Determine pagination mode
  const paginationMode = paginationConfig?.mode || "offset";
  const keysetColumn = paginationConfig?.keysetColumn;
  const keysetDirection = paginationConfig?.keysetDirection || "asc";

  // One path for every query: template placeholders are substituted; a
  // query written without them is translated to template mode first (see
  // db-sync-pagination for the tie-safe incremental, keyset and offset
  // contract).
  const paginatedQuery = buildChunkQuery({
    sourceQuery,
    syncMode,
    incrementalConfig,
    paginationMode: paginationMode === "keyset" ? "keyset" : "offset",
    keysetColumn,
    keysetDirection: keysetDirection === "desc" ? "desc" : "asc",
    keyColumns,
    maxRowsPerChunk,
    state: currentState,
    savedKeysetValue: paginationConfig?.lastKeysetValue,
  });

  let rowsProcessedInChunk = 0;
  let lastTrackingValue: string | undefined;
  let keysetCursor: ReturnType<typeof keysetCursorAfter> = null;

  try {
    const result = await driver.executeQuery(sourceConnection, paginatedQuery, {
      databaseName: sourceDatabase,
    });

    if (!result.success) {
      return {
        state: currentState,
        rowsProcessed: 0,
        completed: false,
        error: result.error || "Query execution failed",
      };
    }

    let rows = result.data || [];

    // Apply type coercions if configured
    if (typeCoercions && typeCoercions.length > 0) {
      rows = rows.map((row: Record<string, unknown>) =>
        applyTypeCoercions(row, typeCoercions),
      );
    }

    // Process in smaller batches for writing
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);

      const writeResult = await destinationWriter.writeBatch(batch, {
        keyColumns,
        conflictStrategy: "update",
        typeCoercions, // Pass coercions for table creation schema overrides
        sourceSchema: currentState.sourceSchema, // Use source schema for reliable table creation
      });

      if (!writeResult.success) {
        return {
          state: currentState,
          rowsProcessed: rowsProcessedInChunk,
          completed: false,
          error: `Failed to write batch: ${writeResult.error}`,
        };
      }

      rowsProcessedInChunk += writeResult.rowsWritten;
      currentState.totalProcessed += writeResult.rowsWritten;

      // Track the max value of the incremental column (rows are not
      // necessarily ordered by it, e.g. in keyset mode).
      if (incrementalConfig?.trackingColumn && batch.length > 0) {
        lastTrackingValue = maxTrackingValue(
          batch,
          incrementalConfig.trackingColumn,
          lastTrackingValue,
        );
      }

      // Track the keyset cursor (value + key-column tiebreaker, typed)
      if (paginationMode === "keyset" && keysetColumn && batch.length > 0) {
        keysetCursor =
          keysetCursorAfter(
            batch[batch.length - 1],
            keysetColumn,
            keyColumns,
          ) ?? keysetCursor;
      }

      onProgress?.(currentState.totalProcessed, currentState.estimatedTotal);
    }

    // Check if there's more data
    const hasMore = rows.length === maxRowsPerChunk;

    // Update state based on pagination mode
    if (paginationMode === "keyset") {
      // For keyset pagination, don't use offset
      if (keysetCursor) {
        currentState.lastKeysetValue = keysetCursor.lastKeysetValue;
        currentState.lastKeysetValueType = keysetCursor.lastKeysetValueType;
        currentState.lastKeysetTiebreaker = keysetCursor.lastKeysetTiebreaker;
      }
    } else {
      // For offset pagination
      currentState.offset += rows.length;
    }

    currentState.hasMore = hasMore;
    if (lastTrackingValue) {
      // The run-wide max, across chunks.
      currentState.lastTrackingValue = maxTrackingValue(
        [{ value: lastTrackingValue }],
        "value",
        currentState.lastTrackingValue,
      );
    }

    return {
      state: currentState,
      rowsProcessed: rowsProcessedInChunk,
      completed: !hasMore,
    };
  } catch (error) {
    return {
      state: currentState,
      rowsProcessed: rowsProcessedInChunk,
      completed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Dry run a sync configuration: execute 3 pages and return preview data
 */
export async function dryRunDbSync(options: {
  sourceConnection: IDatabaseConnection;
  sourceQuery: string;
  sourceDatabase?: string;
  paginationConfig?: IPaginationConfig;
  typeCoercions?: ITypeCoercion[];
  pageSize?: number;
  pages?: number;
}): Promise<{
  success: boolean;
  totalRows: number;
  sampleData: Record<string, unknown>[];
  columns: Array<{ name: string; type: string }>;
  estimatedTotal?: number;
  safetyCheck: QuerySafetyResult;
  error?: string;
}> {
  const {
    sourceConnection,
    sourceQuery,
    sourceDatabase,
    paginationConfig,
    typeCoercions,
    pageSize = 100,
    pages = 3,
  } = options;

  // First, run safety checks
  const safetyCheck = checkQuerySafety(sourceQuery);
  if (!safetyCheck.safe) {
    return {
      success: false,
      totalRows: 0,
      sampleData: [],
      columns: [],
      safetyCheck,
      error: safetyCheck.errors.join("; "),
    };
  }

  const driver = databaseRegistry.getDriver(sourceConnection.type);
  if (!driver) {
    return {
      success: false,
      totalRows: 0,
      sampleData: [],
      columns: [],
      safetyCheck,
      error: `No driver found for type: ${sourceConnection.type}`,
    };
  }

  // Estimate total
  const countResult = await estimateQueryRowCount(
    sourceConnection,
    sourceQuery,
    sourceDatabase,
  );

  const allRows: Record<string, unknown>[] = [];
  let keysetCursor: ReturnType<typeof keysetCursorAfter> = null;
  const paginationMode = paginationConfig?.mode || "offset";
  const keysetColumn = paginationConfig?.keysetColumn;
  const keysetDirection = paginationConfig?.keysetDirection || "asc";

  try {
    // Execute specified number of pages
    for (let page = 0; page < pages; page++) {
      // Same paging as a real run (db-sync-pagination), page by page:
      // a template query is substituted, a plain one translated.
      const paginatedQuery = buildChunkQuery({
        sourceQuery,
        syncMode: "full",
        paginationMode: paginationMode === "keyset" ? "keyset" : "offset",
        keysetColumn,
        keysetDirection: keysetDirection === "desc" ? "desc" : "asc",
        maxRowsPerChunk: pageSize,
        state: { offset: page * pageSize, ...(keysetCursor ?? {}) },
      });

      const result = await driver.executeQuery(
        sourceConnection,
        paginatedQuery,
        {
          databaseName: sourceDatabase,
        },
      );

      if (!result.success) {
        return {
          success: false,
          totalRows: allRows.length,
          sampleData: allRows,
          columns: [],
          estimatedTotal: countResult.estimatedCount,
          safetyCheck,
          error: result.error,
        };
      }

      let rows = result.data || [];
      if (rows.length === 0) break;

      // Apply type coercions
      if (typeCoercions && typeCoercions.length > 0) {
        rows = rows.map((row: Record<string, unknown>) =>
          applyTypeCoercions(row, typeCoercions),
        );
      }

      allRows.push(...rows);

      // Update keyset value for next page
      if (paginationMode === "keyset" && keysetColumn && rows.length > 0) {
        keysetCursor =
          keysetCursorAfter(rows[rows.length - 1], keysetColumn) ??
          keysetCursor;
      }

      // Stop if we got fewer rows than requested
      if (rows.length < pageSize) break;
    }

    // Infer columns from results
    const columns: Array<{ name: string; type: string }> = [];
    if (allRows.length > 0) {
      for (const [name, value] of Object.entries(allRows[0])) {
        columns.push({ name, type: inferJsType(value) });
      }
    }

    return {
      success: true,
      totalRows: allRows.length,
      sampleData: allRows,
      columns,
      estimatedTotal: countResult.estimatedCount,
      safetyCheck,
    };
  } catch (error) {
    return {
      success: false,
      totalRows: allRows.length,
      sampleData: allRows,
      columns: [],
      estimatedTotal: countResult.estimatedCount,
      safetyCheck,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
