import {
  IDatabaseConnection,
  DatabaseAccessLevel,
} from "../database/workspace-schema";
import { Types } from "mongoose";

/**
 * Strips SQL comments (single-line and multi-line) and leading whitespace,
 * then returns the first keyword to determine if the query is read-only.
 */
function extractFirstSqlKeyword(sql: string): string {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*/g, "")
    .trim();

  const match = stripped.match(/^[\s(]*([a-zA-Z]+)/);
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
);

/**
 * Extract the MongoDB operation from a query string by finding the first
 * known CRUD method call (e.g. `.find(`, `.aggregate(`).
 */
function extractMongoOperation(query: string): string | undefined {
  const match = query.match(MONGO_OP_PATTERN);
  return match ? match[1] : undefined;
}

export interface AccessCheckResult {
  allowed: boolean;
  error?: string;
}

/**
 * Check if a SQL query is read-only (SELECT, WITH, EXPLAIN, SHOW, DESCRIBE).
 */
export function isSqlReadOnly(query: string): boolean {
  const keyword = extractFirstSqlKeyword(query);
  return SQL_READ_ONLY_KEYWORDS.has(keyword);
}

/**
 * Check if a MongoDB operation is read-only.
 */
export function isMongoReadOnly(operation: string): boolean {
  return MONGODB_READ_ONLY_OPERATIONS.has(operation);
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
    const mongoOp =
      options?.mongoOperation || extractMongoOperation(query) || "";
    const isReadOnly =
      dbType === "mongodb" ? isMongoReadOnly(mongoOp) : isSqlReadOnly(query);

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
