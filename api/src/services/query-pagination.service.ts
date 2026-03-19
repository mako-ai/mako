import { createHash } from "crypto";
import {
  getSqlDialectOrNull,
  type SqlDialect,
} from "../agent-lib/tools/shared/sql-dialects";
import { findTopLevelKeyword } from "./sql-query-utils";

export const MAX_PREVIEW_PAGE_SIZE = 500;
export const DEFAULT_PREVIEW_PAGE_SIZE = 500;

const PREVIEW_DANGEROUS_PATTERNS = [
  { pattern: /^\s*DROP\s+/i, name: "DROP" },
  { pattern: /^\s*DELETE\s+/i, name: "DELETE" },
  { pattern: /^\s*TRUNCATE\s+/i, name: "TRUNCATE" },
  { pattern: /^\s*ALTER\s+/i, name: "ALTER" },
  { pattern: /^\s*CREATE\s+/i, name: "CREATE" },
  { pattern: /^\s*INSERT\s+/i, name: "INSERT" },
  { pattern: /^\s*UPDATE\s+/i, name: "UPDATE" },
  { pattern: /^\s*GRANT\s+/i, name: "GRANT" },
  { pattern: /^\s*REVOKE\s+/i, name: "REVOKE" },
  {
    pattern:
      /;\s*(DROP|DELETE|TRUNCATE|ALTER|CREATE|INSERT|UPDATE|GRANT|REVOKE)\s+/i,
    name: "multi-statement",
  },
  {
    pattern:
      /\bWITH\b[^;]*\bAS\s*\(\s*(DELETE|INSERT|UPDATE|DROP|TRUNCATE|ALTER)\b/i,
    name: "data-modifying CTE",
  },
] as const;

export interface PreviewQuerySafetyResult {
  safe: boolean;
  warnings: string[];
  errors: string[];
}

export interface PreviewPageInfo {
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
  returnedRows: number;
  capApplied: boolean;
}

export interface PreviewPageResult<Row = Record<string, unknown>> {
  rows: Row[];
  pageInfo: PreviewPageInfo;
  warnings: string[];
}

export interface OffsetCursorPayload {
  kind: "offset";
  offset: number;
  queryHash: string;
}

export interface BigQueryCursorPayload {
  kind: "bigquery";
  jobId: string;
  pageToken: string;
  queryHash: string;
  location?: string;
}

export type PreviewCursorPayload = OffsetCursorPayload | BigQueryCursorPayload;

export interface PreparedSqlPreviewQuery {
  paginatedQuery: string;
  pageSize: number;
  fetchSize: number;
  offset: number;
  capApplied: boolean;
  warnings: string[];
  queryHash: string;
}

export interface PreparedSqlBatchQuery {
  query: string;
  offset: number;
}

function stripTrailingSemicolon(query: string): string {
  return query.replace(/;\s*$/, "").trim();
}

export function resolvePreviewPageSize(requested?: number): {
  pageSize: number;
  capApplied: boolean;
} {
  if (!requested || !Number.isFinite(requested) || requested <= 0) {
    return {
      pageSize: DEFAULT_PREVIEW_PAGE_SIZE,
      capApplied: false,
    };
  }

  if (requested > MAX_PREVIEW_PAGE_SIZE) {
    return {
      pageSize: MAX_PREVIEW_PAGE_SIZE,
      capApplied: true,
    };
  }

  return {
    pageSize: Math.floor(requested),
    capApplied: false,
  };
}

function toCursorString(payload: PreviewCursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function fromCursorString(cursor?: string | null): PreviewCursorPayload | null {
  if (!cursor) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as PreviewCursorPayload;

    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.kind !== "string"
    ) {
      return null;
    }

    if (
      parsed.kind === "offset" &&
      typeof parsed.offset === "number" &&
      typeof parsed.queryHash === "string"
    ) {
      return parsed;
    }

    if (
      parsed.kind === "bigquery" &&
      typeof parsed.jobId === "string" &&
      typeof parsed.pageToken === "string" &&
      typeof parsed.queryHash === "string"
    ) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

export function hashPreviewQuery(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

export function checkPreviewQuerySafety(
  query: string,
): PreviewQuerySafetyResult {
  const result: PreviewQuerySafetyResult = {
    safe: true,
    warnings: [],
    errors: [],
  };

  const trimmedQuery = query.trim();

  for (const { pattern, name } of PREVIEW_DANGEROUS_PATTERNS) {
    if (pattern.test(trimmedQuery)) {
      result.safe = false;
      result.errors.push(
        `Query contains dangerous ${name} statement. Preview only supports read-only queries.`,
      );
    }
  }

  if (
    !trimmedQuery.match(/^\s*SELECT\s+/i) &&
    !trimmedQuery.match(/^\s*WITH\s+/i)
  ) {
    result.safe = false;
    result.errors.push("Preview queries must start with SELECT or WITH (CTE).");
  }

  const semicolonCount = (trimmedQuery.match(/;/g) || []).length;
  if (
    semicolonCount > 1 ||
    (semicolonCount === 1 && !trimmedQuery.endsWith(";"))
  ) {
    result.safe = false;
    result.errors.push("Preview queries must contain a single SQL statement.");
  }

  if (findTopLevelKeyword(trimmedQuery, /^ORDER\s+BY\b/i) === -1) {
    result.warnings.push(
      "Query does not contain a top-level ORDER BY. Paginated results may not be deterministic across pages.",
    );
  }

  return result;
}

function assertCursorMatchesQuery(
  cursor: PreviewCursorPayload | null,
  queryHash: string,
): void {
  if (cursor && cursor.queryHash !== queryHash) {
    throw new Error(
      "The provided preview cursor does not match the current query",
    );
  }
}

function buildWrappedSqlQuery(
  baseQuery: string,
  dialect: SqlDialect,
  limit: number,
  offset: number,
): string {
  if (dialect === "postgresql" || dialect === "mysql" || dialect === "sqlite") {
    return `SELECT * FROM (${baseQuery}) AS _mako_preview LIMIT ${limit} OFFSET ${offset}`;
  }

  if (dialect === "clickhouse") {
    return `SELECT * FROM (${baseQuery}) AS _mako_preview LIMIT ${limit} OFFSET ${offset}`;
  }

  if (dialect === "bigquery") {
    return baseQuery;
  }

  return `SELECT * FROM (${baseQuery}) AS _mako_preview ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
}

export function prepareSqlPreviewQuery(options: {
  query: string;
  databaseType: string;
  pageSize?: number;
  cursor?: string | null;
}): PreparedSqlPreviewQuery {
  const dialect = getSqlDialectOrNull(options.databaseType);
  if (!dialect) {
    throw new Error(`Preview pagination is only supported for SQL connections`);
  }

  if (dialect === "bigquery") {
    throw new Error("BigQuery preview pagination must use native page tokens");
  }

  const baseQuery = stripTrailingSemicolon(options.query);
  const safety = checkPreviewQuerySafety(baseQuery);
  if (!safety.safe) {
    throw new Error(safety.errors.join(" "));
  }

  const { pageSize, capApplied } = resolvePreviewPageSize(options.pageSize);
  const decodedCursor = fromCursorString(options.cursor);
  const queryHash = hashPreviewQuery(baseQuery);
  assertCursorMatchesQuery(decodedCursor, queryHash);

  if (decodedCursor && decodedCursor.kind !== "offset") {
    throw new Error(
      "The provided preview cursor is invalid for this SQL query",
    );
  }

  const offset = decodedCursor?.kind === "offset" ? decodedCursor.offset : 0;
  const fetchSize = pageSize + 1;

  return {
    paginatedQuery: buildWrappedSqlQuery(baseQuery, dialect, fetchSize, offset),
    pageSize,
    fetchSize,
    offset,
    capApplied,
    warnings: safety.warnings,
    queryHash,
  };
}

export function prepareSqlBatchQuery(options: {
  query: string;
  databaseType: string;
  batchSize: number;
  offset: number;
}): PreparedSqlBatchQuery {
  const dialect = getSqlDialectOrNull(options.databaseType);
  if (!dialect) {
    throw new Error(
      "Streaming batch queries are only supported for SQL connections",
    );
  }

  if (dialect === "bigquery") {
    throw new Error("BigQuery batch queries must use native page tokens");
  }

  const baseQuery = stripTrailingSemicolon(options.query);
  return {
    query: buildWrappedSqlQuery(
      baseQuery,
      dialect,
      Math.max(1, Math.floor(options.batchSize)),
      Math.max(0, Math.floor(options.offset)),
    ),
    offset: Math.max(0, Math.floor(options.offset)),
  };
}

export function applySqlRowLimit(options: {
  query: string;
  databaseType: string;
  limit: number;
}): string {
  const dialect = getSqlDialectOrNull(options.databaseType);
  if (!dialect) {
    throw new Error(
      "Row-limited exports are only supported for SQL connections",
    );
  }

  const baseQuery = stripTrailingSemicolon(options.query);
  const safeLimit = Math.max(1, Math.floor(options.limit));

  if (
    dialect === "postgresql" ||
    dialect === "mysql" ||
    dialect === "sqlite" ||
    dialect === "clickhouse" ||
    dialect === "bigquery"
  ) {
    return `SELECT * FROM (${baseQuery}) AS _mako_export LIMIT ${safeLimit}`;
  }

  return `SELECT * FROM (${baseQuery}) AS _mako_export ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT ${safeLimit} ROWS ONLY`;
}

export function decodePreviewCursor(
  cursor?: string | null,
): PreviewCursorPayload | null {
  return fromCursorString(cursor);
}

export function buildOffsetCursor(offset: number, query: string): string {
  return toCursorString({
    kind: "offset",
    offset,
    queryHash: hashPreviewQuery(stripTrailingSemicolon(query)),
  });
}

export function buildBigQueryCursor(payload: {
  jobId: string;
  pageToken: string;
  query: string;
  location?: string;
}): string {
  return toCursorString({
    kind: "bigquery",
    jobId: payload.jobId,
    pageToken: payload.pageToken,
    queryHash: hashPreviewQuery(stripTrailingSemicolon(payload.query)),
    location: payload.location,
  });
}

export function buildPreviewPage<Row = Record<string, unknown>>(options: {
  rows: Row[];
  pageSize: number;
  capApplied: boolean;
  query: string;
  offset?: number;
  warnings?: string[];
}): PreviewPageResult<Row> {
  const hasMore = options.rows.length > options.pageSize;
  const trimmedRows = hasMore
    ? options.rows.slice(0, options.pageSize)
    : options.rows;
  const offset = options.offset ?? 0;

  return {
    rows: trimmedRows,
    warnings: options.warnings || [],
    pageInfo: {
      pageSize: options.pageSize,
      hasMore,
      nextCursor: hasMore
        ? buildOffsetCursor(offset + options.pageSize, options.query)
        : null,
      returnedRows: trimmedRows.length,
      capApplied: options.capApplied,
    },
  };
}

export function inferFieldsFromRows(
  rows: Array<Record<string, unknown>>,
): Array<{ name: string; type?: string }> {
  if (rows.length === 0) return [];
  return Object.keys(rows[0] || {}).map(name => ({ name }));
}
