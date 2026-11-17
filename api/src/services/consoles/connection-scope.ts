/**
 * A console (or notebook cell) may only point at a database connection of
 * its own workspace. Connection ids are ObjectIds, not secrets: anyone who
 * learns one must not be able to bind it from another workspace and run SQL
 * on it. Every write that sets `connectionId` checks it here, and every
 * runner loads the connection with the workspace in the filter.
 */
import { Types } from "mongoose";
import { DatabaseConnection } from "../../database/workspace-schema";

export const FOREIGN_CONNECTION_ERROR =
  "Database connection not found in this workspace";

function asObjectId(value: unknown): Types.ObjectId | null {
  if (value instanceof Types.ObjectId) return value;
  if (typeof value !== "string" || !Types.ObjectId.isValid(value)) return null;
  return new Types.ObjectId(value);
}

/** True when `connectionId` is unset (null, undefined or ""). */
export function noConnectionId(connectionId: unknown): boolean {
  return (
    connectionId === undefined || connectionId === null || connectionId === ""
  );
}

/**
 * True when `connectionId` names a database connection that belongs to
 * `workspaceId`. A malformed id, or one from another workspace, is false.
 */
export async function workspaceOwnsConnection(
  workspaceId: string | Types.ObjectId,
  connectionId: unknown,
): Promise<boolean> {
  const id = asObjectId(connectionId);
  const ws = asObjectId(workspaceId);
  if (!id || !ws) return false;
  const found = await DatabaseConnection.exists({ _id: id, workspaceId: ws });
  return found !== null;
}

/**
 * True when a write may store `connectionId` on a console of `workspaceId`:
 * unset, a connection of that workspace, or an id no connection has (one
 * since deleted: the editor still holds it, and every runner loads with the
 * workspace in the filter, so it can run nowhere). A malformed id, or a
 * connection of another workspace, is refused.
 */
export async function connectionIdAllowed(
  workspaceId: string | Types.ObjectId,
  connectionId: unknown,
): Promise<boolean> {
  if (noConnectionId(connectionId)) return true;
  if (await workspaceOwnsConnection(workspaceId, connectionId)) return true;
  const id = asObjectId(connectionId);
  if (!id) return false;
  return (await DatabaseConnection.exists({ _id: id })) === null;
}

/** The database connection of `workspaceId` with this id, or null. */
export function findWorkspaceConnection(
  workspaceId: string | Types.ObjectId,
  connectionId: unknown,
) {
  const id = asObjectId(connectionId);
  const ws = asObjectId(workspaceId);
  if (!id || !ws) return Promise.resolve(null);
  return DatabaseConnection.findOne({ _id: id, workspaceId: ws });
}
