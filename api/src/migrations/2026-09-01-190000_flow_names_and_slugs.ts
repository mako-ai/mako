/**
 * Give every flow a name and a slug (RFC #904, block 1).
 *
 * Flows shipped without a name: the UI derived a `source → destination`
 * label at render time, and both create forms POSTed a synthesized `name`
 * that the strict Mongoose schema silently dropped. Config-as-code needs a
 * stable identity — `flows/<slug>.yml` cannot be named after a value that
 * changes when someone renames a connection.
 *
 * This backfills, per workspace:
 * - `name`: the same source → destination derivation the UI showed, so no
 *   label visibly changes on deploy.
 * - `slug`: minted once from that name, unique within the workspace
 *   (`-2`, `-3`… on collision, which the derivation makes likely — several
 *   flows can share one source/destination pair).
 *
 * Idempotent: rows that already carry both are skipped, so a re-run after a
 * partial failure completes the remainder.
 */
import { Db, ObjectId } from "mongodb";

export const description = "Backfill flow.name and flow.slug (RFC #904)";

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || "flow";
}

interface FlowRow {
  _id: ObjectId;
  workspaceId: ObjectId;
  name?: string;
  slug?: string;
  sourceType?: string;
  dataSourceId?: ObjectId;
  databaseSource?: { connectionId?: ObjectId };
  tableDestination?: { connectionId?: ObjectId; tableName?: string };
  destinationDatabaseId?: ObjectId;
}

export async function up(db: Db): Promise<void> {
  // Untyped on purpose: a migration queries raw documents, and the
  // "missing or empty" filters below do not fit the typed Filter<T>.
  const flows = db.collection("flows");
  const connections = db.collection("databaseconnections");
  const connectors = db.collection("connectors");

  const rows = (await flows
    .find({
      $or: [{ name: { $in: [null, ""] } }, { slug: { $in: [null, ""] } }],
    })
    .toArray()) as unknown as FlowRow[];
  if (rows.length === 0) return;

  // One lookup per referenced connection/connector, not per flow.
  const nameCache = new Map<string, string | undefined>();
  const lookup = async (
    coll: typeof connections,
    id: ObjectId | undefined,
  ): Promise<string | undefined> => {
    if (!id) return undefined;
    const key = `${coll.collectionName}:${id.toString()}`;
    if (!nameCache.has(key)) {
      const doc = await coll.findOne({ _id: id }, { projection: { name: 1 } });
      nameCache.set(key, (doc as { name?: string } | null)?.name);
    }
    return nameCache.get(key);
  };

  // Slugs already taken per workspace, so a re-run cannot collide with rows
  // stamped by an earlier partial run.
  const takenByWorkspace = new Map<string, Set<string>>();
  const stamped = (await flows
    .find(
      { slug: { $nin: [null, ""] } },
      { projection: { workspaceId: 1, slug: 1 } },
    )
    .toArray()) as unknown as Array<{ workspaceId: ObjectId; slug: string }>;
  for (const existing of stamped) {
    const ws = existing.workspaceId.toString();
    if (!takenByWorkspace.has(ws)) takenByWorkspace.set(ws, new Set());
    takenByWorkspace.get(ws)!.add(existing.slug);
  }

  let named = 0;
  for (const flow of rows) {
    const sourceName =
      flow.sourceType === "database" && flow.databaseSource?.connectionId
        ? ((await lookup(connections, flow.databaseSource.connectionId)) ??
          flow.databaseSource.connectionId.toString())
        : flow.dataSourceId
          ? ((await lookup(connectors, flow.dataSourceId)) ??
            flow.dataSourceId.toString())
          : "Unknown Source";

    let destName: string;
    if (flow.tableDestination?.connectionId) {
      const db_ = await lookup(connections, flow.tableDestination.connectionId);
      destName = flow.tableDestination.tableName
        ? `${db_ || "DB"}.${flow.tableDestination.tableName}`
        : db_ || flow.tableDestination.connectionId.toString();
    } else {
      destName =
        (await lookup(connections, flow.destinationDatabaseId)) ??
        flow.destinationDatabaseId?.toString() ??
        "Unknown Destination";
    }

    const name = flow.name?.trim() || `${sourceName} → ${destName}`;

    const ws = flow.workspaceId.toString();
    if (!takenByWorkspace.has(ws)) takenByWorkspace.set(ws, new Set());
    const taken = takenByWorkspace.get(ws)!;
    let slug = flow.slug?.trim() || "";
    if (!slug) {
      const base = slugify(name);
      slug = base;
      for (let i = 2; taken.has(slug) && i < 1000; i++) slug = `${base}-${i}`;
    }
    taken.add(slug);

    await flows.updateOne({ _id: flow._id }, { $set: { name, slug } });
    named++;
  }

  console.log(`[flow-names] stamped ${named} flow(s) with name + slug`);
}
