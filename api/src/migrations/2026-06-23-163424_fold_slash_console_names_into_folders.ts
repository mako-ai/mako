import { Db, ObjectId } from "mongodb";

export const description =
  "Fold slash-delimited console names into the folder hierarchy (name becomes the leaf, placement becomes folderId)";

/**
 * Canonical console model: `SavedConsole.name` is the LEAF display name and
 * folder placement is `folderId` → `ConsoleFolder.parentId`. The slash path is
 * always DERIVED. Some consoles (legacy data, or agent `create_console` calls
 * that put a path in the title) stored a slash-delimited PATH in `name` with
 * no `folderId`, which the UI then rendered as a flat "fr/csm/customer_list"
 * title/breadcrumb. Convert those to the canonical form: ensure the folder
 * chain exists (under the console's current folder, or root) and set
 * `name` = leaf, `folderId` = deepest folder.
 *
 * Idempotent: only touches consoles whose `name` still contains "/"; after
 * conversion the name has no "/", so a re-run is a no-op. Folder creation is
 * find-or-create.
 */
export async function up(db: Db): Promise<void> {
  const consoles = db.collection("savedconsoles");
  const folders = db.collection("consolefolders");

  // (workspaceId|parent|segmentName) -> folder _id, to dedupe within a run.
  const folderCache = new Map<string, ObjectId>();

  const resolveFolder = async (
    workspaceId: ObjectId,
    parentId: ObjectId | null,
    name: string,
    access: string,
    isPrivate: boolean,
    ownerId: string | undefined,
  ): Promise<ObjectId> => {
    const cacheKey = `${workspaceId.toString()}|${
      parentId ? parentId.toString() : "root"
    }|${name}`;
    const cached = folderCache.get(cacheKey);
    if (cached) return cached;

    const parentMatch = parentId
      ? { parentId }
      : { $or: [{ parentId: null }, { parentId: { $exists: false } }] };
    const existing = await folders.findOne({
      workspaceId,
      name,
      ...parentMatch,
    });

    let id: ObjectId;
    if (existing) {
      id = existing._id as ObjectId;
    } else {
      const res = await folders.insertOne({
        workspaceId,
        name,
        ...(parentId ? { parentId } : {}),
        isPrivate,
        ownerId,
        access,
        createdAt: new Date(),
      });
      id = res.insertedId;
    }
    folderCache.set(cacheKey, id);
    return id;
  };

  const cursor = consoles.find({ name: { $regex: "/" } });
  for await (const doc of cursor) {
    const rawName: string = typeof doc.name === "string" ? doc.name : "";
    const segments = rawName.split("/").filter(Boolean);

    // A name like "report/" or "/report" has a single real segment — just
    // clean the stray slashes off the leaf, no folders.
    if (segments.length <= 1) {
      const leaf = segments[0] ?? rawName;
      if (leaf !== rawName) {
        await consoles.updateOne({ _id: doc._id }, { $set: { name: leaf } });
      }
      continue;
    }

    const leaf = segments[segments.length - 1];
    const folderParts = segments.slice(0, -1);

    const workspaceId = doc.workspaceId as ObjectId;
    const access: string =
      typeof doc.access === "string"
        ? doc.access
        : doc.isPrivate === false
          ? "workspace"
          : "private";
    const isPrivate = access !== "workspace";
    const ownerId: string | undefined =
      (typeof doc.owner_id === "string" && doc.owner_id) ||
      (typeof doc.createdBy === "string" && doc.createdBy) ||
      undefined;

    let parentId: ObjectId | null = (doc.folderId as ObjectId) ?? null;
    for (const segment of folderParts) {
      parentId = await resolveFolder(
        workspaceId,
        parentId,
        segment,
        access,
        isPrivate,
        ownerId,
      );
    }

    await consoles.updateOne(
      { _id: doc._id },
      { $set: { name: leaf, folderId: parentId } },
    );
  }
}
