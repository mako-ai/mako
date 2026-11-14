import { isWrite } from "./connection-writes";

/**
 * Why a workspace viewer may not run `query`: a viewer only reads, whatever
 * the connection's writers list says (the role may have changed since they
 * were listed; the connection proxy treats viewers the same). Null for
 * anyone else, and for a viewer's read. Every route that runs a query on a
 * member's behalf checks this before executing.
 */
export function viewerWriteRefusal(
  memberRole: string | undefined,
  databaseType: string,
  query: unknown,
): string | null {
  if (memberRole !== "viewer") return null;
  if (!isWrite(databaseType, query)) return null;
  return "Viewers can only run queries that read. Ask a workspace admin for the member role to write.";
}
