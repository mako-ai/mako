import type {
  IDatabaseConnection,
  DatabaseVisibility,
} from "../database/workspace-schema";

export interface AccessCheckResult {
  allowed: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SQL_READ_ONLY_KEYWORDS = new Set([
  "SELECT",
  "SHOW",
  "DESCRIBE",
  "DESC",
  "PRAGMA",
]);

const SQL_WRITE_KEYWORDS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "CREATE",
  "REPLACE",
  "MERGE",
  "GRANT",
  "REVOKE",
  "RENAME",
]);

const MONGODB_READ_ONLY_OPERATIONS = new Set([
  "find",
  "findOne",
  "aggregate",
  "count",
  "countDocuments",
  "estimatedDocumentCount",
  "distinct",
  "explain",
]);

const KNOWN_MONGO_OPERATIONS = [
  "find",
  "findOne",
  "aggregate",
  "count",
  "countDocuments",
  "estimatedDocumentCount",
  "distinct",
  "explain",
  "insertOne",
  "insertMany",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
  "replaceOne",
  "bulkWrite",
  "findOneAndUpdate",
  "findOneAndDelete",
  "findOneAndReplace",
  "drop",
  "createIndex",
  "dropIndex",
  "dropIndexes",
  "renameCollection",
];

const MONGO_OP_PATTERN = new RegExp(
  `\\.(${KNOWN_MONGO_OPERATIONS.join("|")})\\s*\\(`,
  "g",
);

const VALID_ACCESS_LEVELS: DatabaseVisibility[] = ["private", "shared"];

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/**
 * State-machine parser that strips SQL comments and string literals so that
 * keyword detection isn't fooled by content inside them.
 *
 * Handles:
 * - Single-line comments: -- ...
 * - Block comments: slash-star ... star-slash
 * - Single-quoted strings: '...' (with '' escape)
 * - Double-quoted identifiers: "..." (with "" escape)
 */
export function stripSqlCommentsAndStrings(sql: string): string {
  const out: string[] = [];
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];
    const next = i + 1 < len ? sql[i + 1] : "";

    if (ch === "-" && next === "-") {
      // single-line comment: skip to end of line
      i += 2;
      while (i < len && sql[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      // block comment: skip to */
      i += 2;
      while (
        i < len &&
        !(sql[i] === "*" && i + 1 < len && sql[i + 1] === "/")
      ) {
        i++;
      }
      i += 2; // skip */
    } else if (ch === "'") {
      // single-quoted string: skip contents, handle '' escape
      i++;
      while (i < len) {
        if (sql[i] === "'" && i + 1 < len && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      out.push("''"); // placeholder so positions don't shift weirdly
    } else if (ch === '"') {
      // double-quoted identifier: skip contents
      i++;
      while (i < len) {
        if (sql[i] === '"' && i + 1 < len && sql[i + 1] === '"') {
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      out.push('""');
    } else {
      out.push(ch);
      i++;
    }
  }

  return out.join("");
}

function extractFirstSqlKeyword(stripped: string): string | null {
  const trimmed = stripped.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^[\s(]*([A-Za-z_]+)/);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Checks whether a stripped SQL fragment contains write keywords using
 * word-boundary matching. Uses a negative lookahead to skip function calls
 * like REPLACE(col, 'a', 'b').
 */
export function containsSqlWriteKeyword(stripped: string): boolean {
  const upper = stripped.toUpperCase();
  for (const kw of SQL_WRITE_KEYWORDS) {
    const pattern = new RegExp(`\\b${kw}\\b(?!\\s*\\()`, "i");
    if (pattern.test(upper)) return true;
  }
  return false;
}

/**
 * Determines whether a SQL query string is read-only.
 *
 * - Splits on ';' (after stripping comments/strings)
 * - Each statement must start with a read-only keyword
 * - WITH (CTE) statements are scanned for embedded write keywords
 * - EXPLAIN ANALYZE is treated as a write (PostgreSQL executes the statement)
 */
export function isSqlReadOnly(query: string): boolean {
  const stripped = stripSqlCommentsAndStrings(query);
  const statements = stripped
    .split(";")
    .map(s => s.trim())
    .filter(Boolean);

  if (statements.length === 0) return false;

  return statements.every(stmt => {
    const keyword = extractFirstSqlKeyword(stmt);
    if (!keyword) return true;

    // EXPLAIN ANALYZE actually executes the statement in PostgreSQL
    if (keyword === "EXPLAIN") {
      const rest = stmt.replace(/^\s*EXPLAIN\s+/i, "");
      if (/^ANALYZE\b/i.test(rest.trim())) return false;
      return true;
    }

    // WITH (CTE) can contain writable CTEs in PostgreSQL
    if (keyword === "WITH") {
      if (containsSqlWriteKeyword(stmt)) return false;
      return true;
    }

    if (SQL_READ_ONLY_KEYWORDS.has(keyword)) return true;

    return false;
  });
}

// ---------------------------------------------------------------------------
// MongoDB helpers
// ---------------------------------------------------------------------------

export function isMongoReadOnly(operation: string): boolean {
  return MONGODB_READ_ONLY_OPERATIONS.has(operation);
}

export function extractAllMongoOperations(query: string): string[] {
  const ops: string[] = [];
  let match;
  MONGO_OP_PATTERN.lastIndex = 0;
  while ((match = MONGO_OP_PATTERN.exec(query)) !== null) {
    ops.push(match[1]);
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Access check functions
// ---------------------------------------------------------------------------

export function isValidAccessLevel(value: string): value is DatabaseVisibility {
  return VALID_ACCESS_LEVELS.includes(value as DatabaseVisibility);
}

/**
 * Checks whether a user can execute a given query against a database.
 *
 * Fail-closed: when userId is undefined, only shared databases allow
 * queries. private databases deny everything.
 */
export function checkQueryAccess(
  database: Pick<
    IDatabaseConnection,
    "access" | "permissions" | "ownerId" | "sharedWith" | "type" | "createdBy"
  >,
  userId: string | undefined,
  query: string,
  options?: { mongoOperation?: string },
): AccessCheckResult {
  const access = database.access || "shared";
  const permissions = database.permissions || "read_write";
  const ownerId = database.ownerId || database.createdBy;
  const isOwner = !!userId && ownerId === userId;

  // Owner always has full access
  if (isOwner) return { allowed: true };

  // private: only owner
  if (access === "private") {
    return { allowed: false, error: "This database is private." };
  }

  // shared + read_write: everyone can read and write
  if (permissions === "read_write") return { allowed: true };

  // shared + read_only: enforce read-only for non-owners
  const isMongoType = database.type === "mongodb";
  let isReadOnly: boolean;

  if (isMongoType) {
    if (options?.mongoOperation) {
      isReadOnly = isMongoReadOnly(options.mongoOperation);
    } else {
      const ops = extractAllMongoOperations(query);
      isReadOnly = ops.length === 0 || ops.every(op => isMongoReadOnly(op));
    }
  } else {
    isReadOnly = isSqlReadOnly(query);
  }

  if (!isReadOnly) {
    const hint = isMongoType
      ? "Only find, aggregate, count, distinct, and explain are allowed."
      : "Only SELECT, WITH, SHOW, DESCRIBE, and EXPLAIN (without ANALYZE) are allowed.";
    return {
      allowed: false,
      error: `This database is read-only. ${hint}`,
    };
  }

  return { allowed: true };
}

/**
 * Checks whether a user can write to a database (used for flow destination validation).
 */
export function canUserWriteDatabase(
  database: Pick<
    IDatabaseConnection,
    "access" | "permissions" | "ownerId" | "createdBy"
  >,
  userId: string | undefined,
): boolean {
  const access = database.access || "shared";
  const permissions = database.permissions || "read_write";
  const ownerId = database.ownerId || database.createdBy;
  const isOwner = !!userId && ownerId === userId;
  if (isOwner) return true;
  if (access === "private") return false;
  return permissions === "read_write";
}

/**
 * Determines whether a database should appear in a user's list.
 */
export function canUserSeeDatabase(
  database: Pick<
    IDatabaseConnection,
    "access" | "ownerId" | "sharedWith" | "createdBy"
  >,
  userId: string | undefined,
): boolean {
  const access = database.access || "shared";

  // shared databases are visible to everyone in the workspace
  if (access === "shared") return true;

  // private: only owner + sharedWith
  if (!userId) return false;
  const ownerId = database.ownerId || database.createdBy;
  if (ownerId === userId) return true;
  const sharedWithIds = (database.sharedWith || []).map(id => id.toString());
  return sharedWithIds.includes(userId);
}

/**
 * Returns the effective access metadata for API responses.
 * `canManage` is true when the user is the owner or a workspace admin/owner.
 */
export function getEffectiveAccess(
  database: Pick<IDatabaseConnection, "access" | "ownerId" | "createdBy">,
  userId: string | undefined,
  memberRole?: string,
): { level: DatabaseVisibility; isOwner: boolean; canManage: boolean } {
  const level = database.access || "shared";
  const ownerId = database.ownerId || database.createdBy;
  const isOwner = !!userId && ownerId === userId;
  const isWorkspaceAdmin = memberRole === "owner" || memberRole === "admin";
  const canManage = isOwner || isWorkspaceAdmin;
  return { level, isOwner, canManage };
}

export const databaseAccessService = {
  checkQueryAccess,
  canUserWriteDatabase,
  canUserSeeDatabase,
  getEffectiveAccess,
  isSqlReadOnly,
  isMongoReadOnly,
  extractAllMongoOperations,
  isValidAccessLevel,
  stripSqlCommentsAndStrings,
  containsSqlWriteKeyword,
};
