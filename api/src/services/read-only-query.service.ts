import { isWrite } from "../access/connection-writes";
import { checkPreviewQuerySafety } from "./query-pagination.service";

export const QUERY_WRITE_SCOPE_REQUIRED =
  "Mako MCP access is read-only: the query was rejected because it is not a " +
  "single read-only SELECT/WITH statement. Database writes are not supported " +
  "over MCP — run them with your own database tooling.";

/** Why a MongoDB query that writes was refused on a read-only run. */
export const MONGO_READ_ONLY_REFUSAL =
  "Mako MCP access is read-only: the MongoDB query was rejected because it " +
  "writes or runs a command (insert/update/delete/drop, runCommand, $out, " +
  "$merge, ...). Reads run: find, findOne, aggregate, countDocuments, " +
  "distinct, e.g. db.collection('users').find({}).limit(10).toArray().";

/** Why a console that holds no SQL and no MongoDB query cannot run read-only. */
export const NON_SQL_CONSOLE_READ_ONLY_REFUSAL =
  "This console's language cannot run read-only over MCP. SQL and MongoDB " +
  "consoles can.";

/**
 * Database commands, read ones included: usersInfo, getLog or serverStatus
 * read credentials, logs and server state, not data. A read-only run takes
 * none of them, whatever the spelling (`db["command"]`, a string, a comment).
 */
const MONGO_COMMAND = /\b(command|runCommand|adminCommand)\b/;

/** Whether a MongoDB query may not run read-only: it writes or runs a command. */
export function isMongoReadOnlyRefused(query: unknown): boolean {
  if (isWrite("mongodb", query)) return true;
  return typeof query === "string" && MONGO_COMMAND.test(query);
}

/** The read-only refusal for a MongoDB shell query, or null when it reads. */
export function mongoReadOnlyAccessError(query: string): string | null {
  return isMongoReadOnlyRefused(query) ? MONGO_READ_ONLY_REFUSAL : null;
}

export function sqlReadOnlyAccessError(
  query: string,
  dialect?: string | null,
): string | null {
  const safety = checkPreviewQuerySafety(query, dialect);
  if (safety.safe) return null;
  // Several overlapping checks usually fire on the same query; one concrete
  // reason is enough for the calling agent (the rest is repetitive noise).
  return `${QUERY_WRITE_SCOPE_REQUIRED} ${safety.errors[0] ?? ""}`.trim();
}
