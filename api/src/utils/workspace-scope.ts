/**
 * The filter for a connection a flow names, in the flow's own workspace.
 *
 * A flow row holds raw connection ids. The push reactor refuses a file that
 * names another workspace's connection (services/flow-connection-scope.ts),
 * but a row written before that check could still hold one. Every runtime
 * lookup from a flow goes through this filter, so such an id reads as
 * missing instead of reaching another workspace's credential or warehouse.
 */
import { Types } from "mongoose";

export function inWorkspace(
  id: unknown,
  workspaceId: unknown,
): { _id: Types.ObjectId; workspaceId: Types.ObjectId } {
  return { _id: objectIdOrNone(id), workspaceId: objectIdOrNone(workspaceId) };
}

/**
 * The id as an ObjectId. A missing or malformed one becomes a fresh id that
 * names no document, so the lookup finds nothing, as `findById(undefined)`
 * did, instead of throwing.
 */
function objectIdOrNone(value: unknown): Types.ObjectId {
  if (value instanceof Types.ObjectId) return value;
  const text = value == null ? "" : String(value);
  return Types.ObjectId.isValid(text) && /^[0-9a-f]{24}$/i.test(text)
    ? new Types.ObjectId(text)
    : new Types.ObjectId();
}
