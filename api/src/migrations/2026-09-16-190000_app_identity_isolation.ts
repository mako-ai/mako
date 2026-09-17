import { Db } from "mongodb";

export const description =
  "Rebuild the disposable apps index with globally unique app ids";

export async function up(db: Db): Promise<void> {
  const index = db.collection("app_index");
  const indexes = await index.indexes();
  // Older index rows may alias a foreign id or omit a legacy project's id.
  // Clear the head first so an interrupted migration cannot mark them fresh.
  await db.collection("app_index_heads").deleteMany({});
  await index.deleteMany({});
  // The global unique appId index makes the compound one's uniqueness
  // redundant; keep the compound as a plain lookup index.
  const compound = indexes.find(
    i =>
      i.unique &&
      JSON.stringify(i.key) === JSON.stringify({ workspaceId: 1, appId: 1 }),
  );
  if (compound?.name) {
    await index.dropIndex(compound.name);
    await index.createIndex({ workspaceId: 1, appId: 1 });
  }
  if (
    indexes.some(
      i => i.unique && JSON.stringify(i.key) === JSON.stringify({ appId: 1 }),
    )
  ) {
    return;
  }
  await index.createIndex({ appId: 1 }, { unique: true });
}
