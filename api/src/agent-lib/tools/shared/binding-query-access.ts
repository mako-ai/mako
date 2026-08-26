import { Types } from "mongoose";
import { DatabaseConnection } from "../../../database/workspace-schema";
import {
  MONGO_QUERY_WRITE_SCOPE_REQUIRED,
  sqlReadOnlyAccessError,
} from "../../../services/read-only-query.service";
import type { QueryAccess } from "../../../auth/api-key-scopes";

/**
 * Access error for persisting a data-source query definition (app data
 * bindings and dashboard data sources), or null when allowed.
 *
 * In-product agents keep their existing behavior (queryAccess undefined).
 * MCP-scoped keys treat bindings/data sources as read-only data sources, not
 * an arbitrary command channel: mongo requires the write scope outright and
 * SQL must be a read-only statement.
 */
export async function bindingQueryAccessError(input: {
  workspaceId: string;
  queryAccess: QueryAccess | undefined;
  language: unknown;
  code: unknown;
  connectionId: unknown;
}): Promise<string | null> {
  const { workspaceId, queryAccess, language, code, connectionId } = input;
  if (queryAccess === undefined) return null;
  if (queryAccess === "none") {
    return "This API key does not have query access.";
  }
  if (
    typeof connectionId !== "string" ||
    !Types.ObjectId.isValid(connectionId)
  ) {
    return "Data binding connection is invalid.";
  }
  const connection = await DatabaseConnection.findOne({
    _id: new Types.ObjectId(connectionId),
    workspaceId: new Types.ObjectId(workspaceId),
  }).select("type");
  if (!connection) return "Data binding connection is invalid.";
  if (
    connection.type === "mongodb" ||
    language === "javascript" ||
    language === "mongodb"
  ) {
    return MONGO_QUERY_WRITE_SCOPE_REQUIRED;
  }
  return sqlReadOnlyAccessError(typeof code === "string" ? code : "");
}
