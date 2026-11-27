/**
 * A flow may only name connections of its own workspace.
 *
 * `flows/<slug>.yml` carries raw connection ids. Without this check a file
 * could point a flow at another workspace's source (its credential would be
 * read, its webhook provisioned) or destination (rows written into another
 * workspace's warehouse). The push reactor, the cache resync and the API
 * refuse such a file.
 *
 * Defence in depth: the runtime lookups a flow run makes (source reads, CDC
 * adapters, the destination writer, database sources, backfill, both
 * webhook lanes) also filter on the flow's workspace (`inWorkspace`,
 * `getSourceConnection(id, workspaceId)`). A row written before this check
 * then reads its connection as missing. A prod scan on 2026-11-17 found 0
 * such rows in 46 flows.
 */
import { Types } from "mongoose";
import { connectionsRepo } from "../repositories/connections";
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
  for (const ref of refs) {
    if (!Types.ObjectId.isValid(ref.id)) continue;
    const exists =
      ref.kind === "source"
        ? Boolean(
            await connectionsRepo.findSourceConnectionById(ref.id, workspaceId),
          )
        : Boolean(
            await connectionsRepo.findDatabaseConnectionSummary(
              ref.id,
              workspaceId,
            ),
          );
    if (!exists) {
      const what =
        ref.kind === "source" ? "source connection" : "database connection";
      return `\`${ref.field}: ${ref.id}\` does not name a ${what} in this workspace`;
    }
  }
  return null;
}

/**
 * `foreignConnectionRefusal` for many files at once, in 2 queries: what
 * GET/list shows, so a file the reactor refuses never looks valid there.
 * Null entries (unparsed files) answer null.
 */
export async function flowFilesConnectionRefusals(
  workspaceId: string,
  files: Array<FlowFile | null>,
): Promise<Array<string | null>> {
  const refsPerFile = files.map(f => (f ? flowFileConnectionRefs(f) : []));
  const ids = (kind: FlowConnectionRef["kind"]) => [
    ...new Set(
      refsPerFile
        .flat()
        .filter(r => r.kind === kind && Types.ObjectId.isValid(r.id))
        .map(r => r.id),
    ),
  ];
  const sourceIds = ids("source");
  const databaseIds = ids("database");
  const [sources, databases] = await Promise.all([
    sourceIds.length
      ? connectionsRepo.findSourceConnectionsByIds(sourceIds, workspaceId)
      : [],
    databaseIds.length
      ? connectionsRepo.findDatabaseConnectionSummariesByIds(
          databaseIds,
          workspaceId,
        )
      : [],
  ]);
  const owned = {
    source: new Set(sources.map(d => d.id)),
    database: new Set(databases.map(d => d.id)),
  };
  return refsPerFile.map(refs => {
    const foreign = refs.find(
      r => Types.ObjectId.isValid(r.id) && !owned[r.kind].has(r.id),
    );
    if (!foreign) return null;
    const what =
      foreign.kind === "source" ? "source connection" : "database connection";
    return `\`${foreign.field}: ${foreign.id}\` does not name a ${what} in this workspace`;
  });
}

/** `foreignConnectionRefusal` for a whole flow file. */
export function flowFileConnectionRefusal(
  workspaceId: string,
  file: FlowFile,
): Promise<string | null> {
  return foreignConnectionRefusal(workspaceId, flowFileConnectionRefs(file));
}
