import { createHash } from "crypto";
import {
  getSqlDialectOrNull,
  type SqlDialect,
} from "../agent-lib/tools/shared/sql-dialects";
import {
  countTopLevelSemicolons,
  findTopLevelKeyword,
} from "./sql-query-utils";

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
      /;(?:\s|\/\*[\s\S]*?\*\/|--[^\n]*\n)*(DROP|DELETE|TRUNCATE|ALTER|CREATE|INSERT|UPDATE|GRANT|REVOKE)\s+/i,
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

/**
 * Strip leading SQL comments (line `--` and block comments) so that
 * safety-check regexes can see the first real keyword.
 */
export function stripLeadingSqlComments(sql: string): string {
  let s = sql;
  for (;;) {
    s = s.replace(/^\s+/, "");
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.substring(nl + 1);
    } else if (s.startsWith("/*")) {
      if (s.length > 2 && s[2] === "!") {
        break;
      }
      const end = s.indexOf("*/", 2);
      s = end === -1 ? "" : s.substring(end + 2);
    } else {
      break;
    }
  }
  return s;
}

/**
 * Replace quoted values/identifiers and comments with spaces before scanning
 * for write keywords. This prevents harmless text such as `SELECT 'UPDATE'`
 * from tripping the guard while keeping executable SQL tokens visible.
 */
export function maskSqlNonCode(sql: string): string {
  let output = "";

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if ((char === "-" && next === "-") || char === "#") {
      const newline = sql.indexOf("\n", index + (char === "#" ? 1 : 2));
      if (newline === -1) return output.padEnd(sql.length, " ");
      output += " ".repeat(newline - index);
      index = newline - 1;
      continue;
    }

    // MySQL version comments (`/*! ... */`) are executable SQL, so leave
    // their contents visible to the forbidden-keyword scan.
    if (char === "/" && next === "*" && sql[index + 2] !== "!") {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) return output.padEnd(sql.length, " ");
      output += " ".repeat(end + 2 - index);
      index = end + 1;
      continue;
    }

    if (char === "$") {
      const tag = sql
        .slice(index)
        .match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, index + tag.length);
        if (end === -1) return output.padEnd(sql.length, " ");
        output += " ".repeat(end + tag.length - index);
        index = end + tag.length - 1;
        continue;
      }
    }

    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      output += " ";
      for (index += 1; index < sql.length; index += 1) {
        output += sql[index] === "\n" ? "\n" : " ";
        if (sql[index] !== quote) continue;
        if (sql[index + 1] === quote) {
          output += " ";
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }

    if (char === "[") {
      const end = sql.indexOf("]", index + 1);
      if (end === -1) return output.padEnd(sql.length, " ");
      output += " ".repeat(end + 1 - index);
      index = end;
      continue;
    }

    output += char;
  }

  return output;
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

/**
 * Statements that end, leave or sidestep the read-only transaction a read
 * runs in, or run code: never allowed after a statement boundary.
 */
const AFTER_BOUNDARY_FORBIDDEN =
  /;\s*(COMMIT|ROLLBACK|END|ABORT|BEGIN|START|SAVEPOINT|RELEASE|DO|CALL|EXECUTE|PREPARE|COPY|SET|RESET)\b/i;

/** One BigQuery string literal at `start`: its end and its text. */
function readBigQueryString(
  sql: string,
  start: number,
): { end: number; text: string } | null {
  const prefix = sql.slice(start).match(/^[rRbB]{0,2}/)?.[0] ?? "";
  const raw = /r/i.test(prefix);
  const open = start + prefix.length;
  const quote = sql[open];
  if (quote !== "'" && quote !== '"') return null;
  const delimiter = sql.startsWith(quote.repeat(3), open)
    ? quote.repeat(3)
    : quote;
  let text = "";
  for (let i = open + delimiter.length; i < sql.length; i += 1) {
    if (sql[i] === "\\" && i + 1 < sql.length) {
      // A raw string keeps the backslash; either way the next character
      // does not close the literal.
      text += raw
        ? sql.slice(i, i + 2)
        : sql[i + 1] === "n"
          ? "\n"
          : sql[i + 1];
      i += 1;
      continue;
    }
    if (sql.startsWith(delimiter, i)) {
      return { end: i + delimiter.length, text };
    }
    text += sql[i];
  }
  return null;
}

/**
 * The SQL each BigQuery `EXTERNAL_QUERY(connection, sql)` call sends to the
 * federated database; null for a call whose SQL is not a plain literal.
 * Matched on the raw text: a call mentioned inside a string is read too,
 * which errs on the side of refusing.
 */
export function externalQueryStatements(sql: string): Array<string | null> {
  const found: Array<string | null> = [];
  const call = /\bEXTERNAL_QUERY\s*\(\s*/gi;
  for (let match = call.exec(sql); match; match = call.exec(sql)) {
    const connection = readBigQueryString(sql, match.index + match[0].length);
    const comma = connection
      ? sql.slice(connection.end).match(/^\s*,\s*/)
      : null;
    const inner =
      connection && comma
        ? readBigQueryString(sql, connection.end + comma[0].length)
        : null;
    found.push(inner ? inner.text : null);
  }
  return found;
}

/**
 * Whether `query` is a single read-only SELECT/WITH statement. `dialect` is
 * the database type or SQL dialect it runs on: quotes and statement
 * boundaries are read by that engine's rules. Without one the query must be
 * a single statement under every engine's reading.
 */
export function checkPreviewQuerySafety(
  query: string,
  dialect?: string | null,
): PreviewQuerySafetyResult {
  const result: PreviewQuerySafetyResult = {
    safe: true,
    warnings: [],
    errors: [],
  };

  const trimmedQuery = stripLeadingSqlComments(query.trim());

  for (const { pattern, name } of PREVIEW_DANGEROUS_PATTERNS) {
    if (pattern.test(trimmedQuery)) {
      result.safe = false;
      result.errors.push(
        `Query contains dangerous ${name} statement. Preview only supports read-only queries.`,
      );
    }
  }

  const executableSql = maskSqlNonCode(trimmedQuery);
  const writePosition = findTopLevelKeyword(
    executableSql,
    /^(DELETE|INSERT|INTO|MERGE|UPDATE)\b/i,
  );
  const executableCommentWrite = trimmedQuery.match(
    /\/\*![\s\S]*?\b(DELETE|INSERT|INTO|MERGE|UPDATE)\b[\s\S]*?\*\//i,
  )?.[1];
  if (writePosition !== -1 || executableCommentWrite) {
    const writeKeyword =
      executableCommentWrite ??
      executableSql.slice(writePosition).match(/^[A-Z]+/i)?.[0] ??
      "write";
    result.safe = false;
    result.errors.push(
      `Query contains forbidden ${writeKeyword.toUpperCase()} syntax. Preview only supports read-only queries.`,
    );
  }

  if (
    !trimmedQuery.match(/^\s*SELECT\s+/i) &&
    !trimmedQuery.match(/^\s*WITH\s+/i)
  ) {
    result.safe = false;
    result.errors.push("Preview queries must start with SELECT or WITH (CTE).");
  }

  // The mask reads strings the PostgreSQL way. Engines where a backslash
  // escapes a quote are covered by the statement count below instead.
  const sqlDialect = dialect ? getSqlDialectOrNull(dialect) : null;
  const backslashDialect =
    sqlDialect === "mysql" ||
    sqlDialect === "bigquery" ||
    sqlDialect === "clickhouse";
  const boundaryKeyword = backslashDialect
    ? undefined
    : executableSql.match(AFTER_BOUNDARY_FORBIDDEN)?.[1];
  if (boundaryKeyword) {
    result.safe = false;
    result.errors.push(
      `Query contains forbidden ${boundaryKeyword.toUpperCase()} after a statement boundary. Preview only supports read-only queries.`,
    );
  }

  if (!sqlDialect || sqlDialect === "bigquery") {
    for (const inner of externalQueryStatements(trimmedQuery)) {
      if (inner !== null && checkPreviewQuerySafety(inner).safe) continue;
      result.safe = false;
      result.errors.push(
        inner === null
          ? "EXTERNAL_QUERY must be given its SQL as a string literal so it can be checked. Preview only supports read-only queries."
          : "EXTERNAL_QUERY carries a statement that is not a read-only SELECT/WITH. Preview only supports read-only queries.",
      );
      break;
    }
  }

  const { count: semicolonCount, lastIndex: lastSemicolon } =
    countTopLevelSemicolons(trimmedQuery, dialect);
  if (
    semicolonCount > 1 ||
    (semicolonCount === 1 &&
      trimmedQuery.trimEnd().length - 1 !== lastSemicolon)
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
