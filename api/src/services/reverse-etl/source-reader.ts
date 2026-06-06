import type { IDatabaseConnection } from "../../database/workspace-schema";
import { databaseConnectionService } from "../database-connection.service";
import {
  appendSqlClause,
  appendWhereCondition,
  findTopLevelKeyword,
} from "../sql-query-utils";
import {
  detectTemplates,
  substituteTemplates,
} from "../../utils/template-substitution";
import type { ReverseFlowSpec } from "../../schemas/reverse-flow.schema";

export interface ReverseEtlSourceState {
  offset: number;
  totalProcessed: number;
  hasMore: boolean;
  lastTrackingValue?: string;
  lastKeysetValue?: string;
}

export interface ReverseEtlSourcePage {
  rows: Record<string, unknown>[];
  columns: string[];
  state: ReverseEtlSourceState;
  maxTrackingValue?: string;
}

function escapeSqlValue(value: string | number): string | number {
  return typeof value === "number" || !Number.isNaN(Number(value))
    ? Number(value)
    : `'${String(value).replace(/'/g, "''")}'`;
}

export function buildPaginatedSourceQuery(params: {
  query: string;
  paginationConfig?: ReverseFlowSpec["pagination"];
  incrementalConfig?: ReverseFlowSpec["incremental"];
  state: ReverseEtlSourceState;
  limit: number;
}): string {
  const baseQuery = params.query.replace(/;\s*$/, "");
  const paginationMode = params.paginationConfig?.mode || "offset";
  const keysetColumn = params.paginationConfig?.keysetColumn;
  const keysetDirection = params.paginationConfig?.keysetDirection || "asc";
  const templates = detectTemplates(baseQuery);

  if (
    templates.hasLimit ||
    templates.hasOffset ||
    templates.hasLastSyncValue ||
    templates.hasKeysetValue
  ) {
    return substituteTemplates(baseQuery, {
      limit: params.limit,
      offset: params.state.offset,
      last_sync_value: params.incrementalConfig?.lastValue
        ? escapeSqlValue(params.incrementalConfig.lastValue)
        : params.state.lastTrackingValue
          ? escapeSqlValue(params.state.lastTrackingValue)
          : null,
      keyset_value: params.state.lastKeysetValue
        ? escapeSqlValue(params.state.lastKeysetValue)
        : null,
    });
  }

  let effectiveQuery = baseQuery;
  const lastTrackingValue =
    params.state.lastTrackingValue || params.incrementalConfig?.lastValue;
  if (params.incrementalConfig?.trackingColumn && lastTrackingValue) {
    effectiveQuery = appendWhereCondition(
      effectiveQuery,
      `${params.incrementalConfig.trackingColumn} > ${escapeSqlValue(
        lastTrackingValue,
      )}`,
    );
  }

  if (paginationMode === "keyset" && keysetColumn) {
    if (params.state.lastKeysetValue) {
      const operator = keysetDirection === "asc" ? ">" : "<";
      effectiveQuery = appendWhereCondition(
        effectiveQuery,
        `${keysetColumn} ${operator} ${escapeSqlValue(
          params.state.lastKeysetValue,
        )}`,
      );
    }

    if (findTopLevelKeyword(effectiveQuery, /^ORDER\s+BY\b/i) === -1) {
      effectiveQuery = appendSqlClause(
        effectiveQuery,
        `ORDER BY ${keysetColumn} ${keysetDirection.toUpperCase()}`,
      );
    }
    return appendSqlClause(effectiveQuery, `LIMIT ${params.limit}`);
  }

  return appendSqlClause(
    effectiveQuery,
    `LIMIT ${params.limit} OFFSET ${params.state.offset}`,
  );
}

export async function readReverseEtlSourcePage(params: {
  connection: IDatabaseConnection;
  spec: ReverseFlowSpec;
  state?: Partial<ReverseEtlSourceState>;
}): Promise<ReverseEtlSourcePage> {
  const batchSize = Math.min(
    params.spec.safety.batchSize,
    params.spec.safety.maxRowsPerRun,
  );
  const state: ReverseEtlSourceState = {
    offset: params.state?.offset ?? 0,
    totalProcessed: params.state?.totalProcessed ?? 0,
    hasMore: true,
    lastTrackingValue: params.state?.lastTrackingValue,
    lastKeysetValue: params.state?.lastKeysetValue,
  };
  const paginatedQuery = buildPaginatedSourceQuery({
    query: params.spec.source.query,
    paginationConfig: params.spec.pagination,
    incrementalConfig: params.spec.incremental,
    state,
    limit: batchSize,
  });
  const result = await databaseConnectionService.executeQuery(
    params.connection,
    paginatedQuery,
    {
      databaseName: params.spec.source.database,
      databaseId: params.spec.source.database,
    },
  );

  if (!result.success) {
    throw new Error(result.error || "Reverse ETL source query failed");
  }

  const rows = Array.isArray(result.data)
    ? (result.data as Record<string, unknown>[])
    : [];
  const columns =
    result.fields?.map((column: string | { name?: string }) =>
      typeof column === "string" ? column : column.name || "",
    ) || Object.keys(rows[0] || {});

  const nextState: ReverseEtlSourceState = {
    ...state,
    totalProcessed: state.totalProcessed + rows.length,
    hasMore:
      rows.length === batchSize &&
      state.totalProcessed + rows.length < params.spec.safety.maxRowsPerRun,
  };

  let maxTrackingValue: string | undefined;
  if (params.spec.incremental?.trackingColumn) {
    for (const row of rows) {
      const value = row[params.spec.incremental.trackingColumn];
      if (value === undefined || value === null) continue;
      const serialized =
        value instanceof Date ? value.toISOString() : String(value);
      if (!maxTrackingValue || serialized > maxTrackingValue) {
        maxTrackingValue = serialized;
      }
    }
    if (maxTrackingValue) {
      nextState.lastTrackingValue = maxTrackingValue;
    }
  }

  if (
    params.spec.pagination?.mode === "keyset" &&
    params.spec.pagination.keysetColumn
  ) {
    const last = rows[rows.length - 1];
    const value = last?.[params.spec.pagination.keysetColumn];
    if (value !== undefined && value !== null) {
      nextState.lastKeysetValue =
        value instanceof Date ? value.toISOString() : String(value);
    }
  } else {
    nextState.offset += rows.length;
  }

  return {
    rows,
    columns,
    state: nextState,
    maxTrackingValue,
  };
}
