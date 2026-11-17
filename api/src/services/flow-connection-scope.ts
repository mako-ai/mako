/**
 * A flow may only name connections of its own workspace.
 *
 * `flows/<slug>.yml` carries raw connection ids. Without this check a file
 * could point a flow at another workspace's source (its credential would be
 * read, its webhook provisioned) or destination (rows written into another
 * workspace's warehouse). The push reactor and the API refuse such a file;
 * every flow → connection lookup is also scoped to the flow's workspace
 * (`getSourceConnection(id, workspaceId)`), so a row written before this
 * check cannot be used either.
 */
import { Types } from "mongoose";
import {
  DatabaseConnection,
  SourceConnection,
} from "../database/workspace-schema";
import type { FlowFile } from "./flow-config-files";

export interface FlowConnectionRef {
  /** The key as the file spells it, for the error. */
  field: string;
  id: string;
  /** `source`: a source connection; `database`: a database connection. */
  kind: "source" | "database";
}

/** Every connection id a flow file names. */
export function flowFileConnectionRefs(file: FlowFile): FlowConnectionRef[] {
  const refs: FlowConnectionRef[] = [];
  if (file.source.connectionId) {
    refs.push({
      field: "source.connection_id",
      id: file.source.connectionId,
      kind: file.source.type === "database" ? "database" : "source",
    });
  }
  if (file.destination.connectionId) {
    refs.push({
      field: "destination.connection_id",
      id: file.destination.connectionId,
      kind: "database",
    });
  }
  if (file.destination.table?.connectionId) {
    refs.push({
      field: "destination.table.connection_id",
      id: file.destination.table.connectionId,
      kind: "database",
    });
  }
  return refs;
}

/**
 * The reason the first ref outside `workspaceId` is refused, or null when
 * every ref is in it. A missing connection reads the same as a foreign one,
 * so the answer never says whether an id exists elsewhere. Ids that are not
 * ObjectIds are left to the caller's own parsing.
 */
export async function foreignConnectionRefusal(
  workspaceId: string,
  refs: FlowConnectionRef[],
): Promise<string | null> {
  const ws = new Types.ObjectId(workspaceId);
  for (const ref of refs) {
    if (!Types.ObjectId.isValid(ref.id)) continue;
    const filter = { _id: new Types.ObjectId(ref.id), workspaceId: ws };
    const exists =
      ref.kind === "source"
        ? await SourceConnection.exists(filter)
        : await DatabaseConnection.exists(filter);
    if (!exists) {
      const what =
        ref.kind === "source" ? "source connection" : "database connection";
      return `\`${ref.field}: ${ref.id}\` does not name a ${what} in this workspace`;
    }
  }
  return null;
}

/** `foreignConnectionRefusal` for a whole flow file. */
export function flowFileConnectionRefusal(
  workspaceId: string,
  file: FlowFile,
): Promise<string | null> {
  return foreignConnectionRefusal(workspaceId, flowFileConnectionRefs(file));
}
