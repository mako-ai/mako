import {
  IDatabaseConnection,
  DatabaseAccessLevel,
} from "../database/workspace-schema";
import { Types } from "mongoose";

/**
 * Strip SQL comments and string literals using a character-level state machine
 * so that comment-like sequences inside string literals are not misinterpreted.
 * Preserves semicolons and SQL keywords while removing content that could
 * disguise destructive statements.
 */
function stripSqlCommentsAndStrings(sql: string): string {
  let result = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (sql[i] === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }
    if (sql[i] === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }
    result += sql[i];
    i++;
  }
  return result;
}

/**
 * Returns the first SQL keyword from a pre-stripped statement.
 */
function extractFirstSqlKeyword(sql: string): string {
  const trimmed = sql.trim();
  const match = trimmed.match(/^[\s(]*([a-zA-Z]+)/);
  return match ? match[1].toUpperCase() : "";
}

const SQL_READ_ONLY_KEYWORDS = new Set([
  "SELECT",
  "WITH",
  "EXPLAIN",
  "SHOW",
  "DESCRIBE",
  "DESC",
  "PRAGMA",
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
];

const MONGO_OP_PATTERN = new RegExp(
  `\\.(${KNOWN_MONGO_OPERATIONS.join("|")})\\s*\\(`,
  "g",
);

/**
 * Extract all MongoDB operations from a query string by finding every
 * known CRUD method call (e.g. `.find(`, `.aggregate(`, `.deleteMany(`).
 */
function extractAllMongoOperations(query: string): string[] {
  const ops: string[] = [];
  let match: RegExpExecArray | null;
  MONGO_OP_PATTERN.lastIndex = 0;
  while ((match = MONGO_OP_PATTERN.exec(query)) !== null) {
    ops.push(match[1]);
  }
  return ops;
}

export interface AccessCheckResult {
  allowed: boolean;
  error?: string;
}

/**
 * Check if a SQL query is read-only (SELECT, WITH, EXPLAIN, SHOW, DESCRIBE).
 * Handles multi-statement queries by validating every statement.
 */
export function isSqlReadOnly(query: string): boolean {
  const stripped = stripSqlCommentsAndStrings(query).trim();

  const statements = stripped
    .split(";")
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (statements.length === 0) return false;

  return statements.every(stmt => {
    const keyword = extractFirstSqlKeyword(stmt);
    return SQL_READ_ONLY_KEYWORDS.has(keyword);
  });
}

/**
 * Check if a MongoDB operation is read-only.
 */
export function isMongoReadOnly(operation: string): boolean {
  return MONGODB_READ_ONLY_OPERATIONS.has(operation);
}

/**
 * Check if all MongoDB operations in a query string are read-only.
 * Handles multi-operation queries by validating every matched operation.
 */
function isMongoQueryReadOnly(
  query: string,
  explicitOperation?: string,
): boolean {
  if (explicitOperation) {
    return isMongoReadOnly(explicitOperation);
  }
  const ops = extractAllMongoOperations(query);
  if (ops.length === 0) return false;
  return ops.every(op => MONGODB_READ_ONLY_OPERATIONS.has(op));
}

/**
 * Central access check for database query execution.
 * Returns { allowed: true } or { allowed: false, error: "..." }.
 */
export function checkQueryAccess(
  database: IDatabaseConnection,
  userId: string,
  query: string,
  options?: { mongoOperation?: string },
): AccessCheckResult {
  const access = database.access || "shared_write";
  const ownerId = database.ownerId || database.createdBy;
  const isOwner = ownerId === userId;

  if (isOwner) {
    return { allowed: true };
  }

  if (access === "private") {
    const sharedWithIds = (database.sharedWith || []).map(
      (id: Types.ObjectId) => id.toString(),
    );
    if (!sharedWithIds.includes(userId)) {
      return {
        allowed: false,
        error:
          "Access denied. This database is private and only accessible by its owner.",
      };
    }
    // sharedWith users on private databases get read-only access (fall through)
  }

  if (access === "shared_read" || access === "private") {
    const dbType = database.type;
    const isReadOnly =
      dbType === "mongodb"
        ? isMongoQueryReadOnly(query, options?.mongoOperation)
        : isSqlReadOnly(query);

    if (!isReadOnly) {
      const hint =
        dbType === "mongodb"
          ? "Only find, aggregate, count, distinct, and explain operations are allowed."
          : "Only SELECT, WITH, EXPLAIN, SHOW, and DESCRIBE queries are allowed.";
      return {
        allowed: false,
        error: `This database is shared as read-only. ${hint}`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Check if a user can see a database connection (for listing).
 */
export function canUserSeeDatabase(
  database: IDatabaseConnection,
  userId: string,
): boolean {
  const access = database.access || "shared_write";
  const ownerId = database.ownerId || database.createdBy;

  if (ownerId === userId) return true;
  if (access === "private") {
    const sharedWithIds = (database.sharedWith || []).map(
      (id: Types.ObjectId) => id.toString(),
    );
    return sharedWithIds.includes(userId);
  }
  return true;
}

/**
 * Get the effective access level for a user on a database.
 */
export function getEffectiveAccess(
  database: IDatabaseConnection,
  userId: string,
): { level: DatabaseAccessLevel; isOwner: boolean } {
  const ownerId = database.ownerId || database.createdBy;
  const isOwner = ownerId === userId;
  const access = database.access || "shared_write";
  return { level: access, isOwner };
}

export const databaseAccessService = {
  checkQueryAccess,
  canUserSeeDatabase,
  getEffectiveAccess,
  isSqlReadOnly,
  isMongoReadOnly,
};
