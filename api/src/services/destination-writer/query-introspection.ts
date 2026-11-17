/**
 * Read-only probes against a source or destination: estimate a query's row
 * count, read a tracking column's max value, validate a query with LIMIT 1.
 */
import { IDatabaseConnection } from "../../database/workspace-schema";
import { databaseRegistry } from "../../databases/registry";
import { prepareQueryForValidation } from "../../utils/template-substitution";

/**
 * Estimate the total row count for a query (for progress tracking)
 */
export async function estimateQueryRowCount(
  connection: IDatabaseConnection,
  query: string,
  database?: string,
  options?: { executionId?: string; signal?: AbortSignal },
): Promise<{ success: boolean; estimatedCount?: number; error?: string }> {
  const driver = databaseRegistry.getDriver(connection.type);
  if (!driver) {
    return {
      success: false,
      error: `No driver found for type: ${connection.type}`,
    };
  }

  try {
    // Wrap query in COUNT(*) - works for most SQL databases
    // Remove any ORDER BY clause as it's not needed for count
    const cleanQuery = query.replace(/\s+ORDER\s+BY\s+[^)]+$/i, "");
    const countQuery = `SELECT COUNT(*) as total FROM (${cleanQuery}) AS count_subquery`;

    const result = await driver.executeQuery(connection, countQuery, {
      databaseName: database,
      executionId: options?.executionId,
      signal: options?.signal,
    });

    if (result.success && result.data && result.data.length > 0) {
      const count =
        result.data[0].total || result.data[0].count || result.data[0].COUNT;
      return { success: true, estimatedCount: Number(count) };
    }

    return { success: false, error: "Could not determine row count" };
  } catch (error) {
    // Count estimation is optional, don't fail the sync
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get the maximum value of a tracking column from the destination
 * Used for updating incremental sync state after completion
 */
export async function getMaxTrackingValue(
  connection: IDatabaseConnection,
  tableName: string,
  trackingColumn: string,
  schema?: string,
  database?: string,
  options?: { executionId?: string; signal?: AbortSignal },
): Promise<{ success: boolean; maxValue?: string; error?: string }> {
  const driver = databaseRegistry.getDriver(connection.type);
  if (!driver) {
    return {
      success: false,
      error: `No driver found for type: ${connection.type}`,
    };
  }

  try {
    // Case-folding engines (Postgres family) need quoted identifiers or
    // camelCase columns like _syncedAt silently break; engines without
    // quoteIdentifier match bare identifiers case-insensitively.
    const quote = (name: string) =>
      driver.quoteIdentifier ? driver.quoteIdentifier(name) : name;
    const qualifiedTable = driver.formatTableRef
      ? driver.formatTableRef(schema, tableName)
      : schema
        ? `${quote(schema)}.${quote(tableName)}`
        : quote(tableName);
    const query = `SELECT MAX(${quote(trackingColumn)}) as max_value FROM ${qualifiedTable}`;

    const result = await driver.executeQuery(connection, query, {
      databaseName: database,
      executionId: options?.executionId,
      signal: options?.signal,
    });

    // Drivers report a failed query as `{ success: false }` rather than
    // throwing. It must not read as "no data": a poll would then treat a
    // warehouse hiccup as an empty table and re-read the whole entity.
    if (!result.success) {
      // MongoDB has no SQL: this probe always fails there. Keep the old
      // reading (no value, so a poll fetches everything) until a native
      // probe exists, or a dropped collection would never refill.
      if (connection.type === "mongodb") {
        return { success: true, maxValue: undefined };
      }
      return { success: false, error: result.error || "Query failed" };
    }

    if (result.success && result.data && result.data.length > 0) {
      const maxValue = result.data[0].max_value;
      if (maxValue !== null && maxValue !== undefined) {
        // Convert to string for storage
        if (maxValue instanceof Date) {
          return { success: true, maxValue: maxValue.toISOString() };
        }
        return { success: true, maxValue: String(maxValue) };
      }
    }

    return { success: true, maxValue: undefined }; // No data in table
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Validate a query by executing with LIMIT 1 and return column info
 */
export async function validateQuery(
  connection: IDatabaseConnection,
  query: string,
  database?: string,
  options?: { executionId?: string; signal?: AbortSignal },
): Promise<{
  success: boolean;
  columns?: Array<{ name: string; type: string }>;
  sampleRow?: Record<string, unknown>;
  error?: string;
}> {
  const driver = databaseRegistry.getDriver(connection.type);
  if (!driver) {
    return {
      success: false,
      error: `No driver found for type: ${connection.type}`,
    };
  }

  try {
    // Substitute template placeholders with safe defaults for validation
    // This handles {{limit}}, {{offset}}, {{last_sync_value}}, {{keyset_value}}
    const preparedQuery = prepareQueryForValidation(query);

    // Execute with LIMIT 1 to validate and get schema
    const testQuery = `SELECT * FROM (${preparedQuery}) AS validation_subquery LIMIT 1`;

    const result = await driver.executeQuery(connection, testQuery, {
      databaseName: database,
      executionId: options?.executionId,
      signal: options?.signal,
    });

    if (!result.success) {
      return {
        success: false,
        error: result.error || "Query validation failed",
      };
    }

    // Extract column names from result (no type inference - let AI/user set types)
    let columns: Array<{ name: string; type: string }> = [];
    let sampleRow: Record<string, unknown> | undefined;

    if (result.data && result.data.length > 0) {
      sampleRow = result.data[0] as Record<string, unknown>;
      columns = Object.keys(sampleRow).map(name => ({
        name,
        type: "", // Empty - types should be set by AI agent or user
      }));
    }

    return { success: true, columns, sampleRow };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
