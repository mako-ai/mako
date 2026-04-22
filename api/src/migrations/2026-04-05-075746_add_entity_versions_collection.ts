import { Db } from "mongodb";

export const description =
  "Create entity_versions collection with indexes and seed v1 for existing saved consoles and dashboards";

export async function up(db: Db): Promise<void> {
  const col = db.collection("entity_versions");

  const indexes = await col.listIndexes().toArray();
  const hasKeys = (kp: Record<string, number>) =>
    indexes.some(i => JSON.stringify(i.key) === JSON.stringify(kp));

  if (!hasKeys({ entityId: 1, version: -1 })) {
    await col.createIndex({ entityId: 1, version: -1 });
  }
  if (!hasKeys({ entityId: 1, entityType: 1, version: 1 })) {
    await col.createIndex(
      { entityId: 1, entityType: 1, version: 1 },
      { unique: true },
    );
  }
  if (!hasKeys({ workspaceId: 1, entityType: 1, createdAt: -1 })) {
    await col.createIndex({ workspaceId: 1, entityType: 1, createdAt: -1 });
  }

  // Set version: 1 on all saved consoles that don't have it yet
  await db
    .collection("savedconsoles")
    .updateMany(
      { isSaved: true, version: { $exists: false } },
      { $set: { version: 1 } },
    );

  // Seed v1 for existing saved consoles without a version record
  const savedConsoles = await db
    .collection("savedconsoles")
    .find({ isSaved: true })
    .project({
      _id: 1,
      workspaceId: 1,
      name: 1,
      description: 1,
      code: 1,
      language: 1,
      connectionId: 1,
      databaseName: 1,
      databaseId: 1,
      chartSpec: 1,
      resultsViewMode: 1,
      mongoOptions: 1,
      folderId: 1,
      access: 1,
      createdBy: 1,
      createdAt: 1,
    })
    .toArray();

  for (const c of savedConsoles) {
    const exists = await col.findOne({
      entityId: c._id,
      entityType: "console",
      version: 1,
    });
    if (exists) continue;

    // Look up display name
    const user = await db
      .collection("users")
      .findOne({ _id: c.createdBy }, { projection: { name: 1, email: 1 } });
    const displayName = user?.name || user?.email || String(c.createdBy);

    await col.insertOne({
      workspaceId: c.workspaceId,
      entityType: "console",
      entityId: c._id,
      version: 1,
      snapshot: {
        name: c.name,
        description: c.description,
        code: c.code,
        language: c.language,
        connectionId: c.connectionId?.toString(),
        databaseName: c.databaseName,
        databaseId: c.databaseId,
        chartSpec: c.chartSpec,
        resultsViewMode: c.resultsViewMode,
        mongoOptions: c.mongoOptions,
        folderId: c.folderId?.toString(),
        access: c.access ?? "private",
      },
      savedBy: String(c.createdBy),
      savedByName: displayName,
      comment: "Initial version (migrated)",
      createdAt: c.createdAt ?? new Date(),
    });
  }

  // Seed v1 for existing dashboards without a version record
  const dashboards = await db
    .collection("dashboards")
    .find({})
    .project({
      _id: 1,
      workspaceId: 1,
      title: 1,
      description: 1,
      dataSources: 1,
      widgets: 1,
      relationships: 1,
      globalFilters: 1,
      crossFilter: 1,
      layout: 1,
      materializationSchedule: 1,
      createdBy: 1,
      createdAt: 1,
    })
    .toArray();

  for (const d of dashboards) {
    const exists = await col.findOne({
      entityId: d._id,
      entityType: "dashboard",
      version: 1,
    });
    if (exists) continue;

    const user = await db
      .collection("users")
      .findOne({ _id: d.createdBy }, { projection: { name: 1, email: 1 } });
    const displayName = user?.name || user?.email || String(d.createdBy);

    await col.insertOne({
      workspaceId: d.workspaceId,
      entityType: "dashboard",
      entityId: d._id,
      version: 1,
      snapshot: {
        title: d.title,
        description: d.description,
        dataSources: d.dataSources,
        widgets: d.widgets,
        relationships: d.relationships,
        globalFilters: d.globalFilters,
        crossFilter: d.crossFilter,
        layout: d.layout,
        materializationSchedule: d.materializationSchedule,
      },
      savedBy: String(d.createdBy),
      savedByName: displayName,
      comment: "Initial version (migrated)",
      createdAt: d.createdAt ?? new Date(),
    });
  }
}
