import { Db } from "mongodb";

export const description =
  "Backfill an initial published version (v1) for every MakoApp that has no version history";

/**
 * Apps shipped without creating an initial EntityVersion on creation (unlike
 * consoles/dashboards), so apps created before that fix show an empty Version
 * History panel. This backfills a v1 snapshot + `published` baseline for every
 * app that has no "app" EntityVersion yet, so version history appears for
 * existing apps. Idempotent: apps that already have a version are skipped.
 */

interface RawBinding {
  id?: string;
  name?: string;
  connectionId?: string;
  language?: string;
  code?: string;
  databaseId?: string;
  databaseName?: string;
  materialization?: string;
  materializationSchedule?: unknown;
}

interface RawApp {
  _id: unknown;
  workspaceId: unknown;
  title?: string;
  description?: string;
  template?: string;
  runtime?: string;
  entrypoint?: string;
  files?: Array<{ path?: string; contents?: string }>;
  dependencies?: Record<string, string>;
  dataBindings?: RawBinding[];
  published?: unknown;
  createdBy?: string;
}

/** Mirror of services/app-version.service buildAppSnapshot (raw form). */
function buildSnapshot(app: RawApp): Record<string, unknown> {
  return {
    title: app.title,
    description: app.description,
    template: app.template,
    runtime: app.runtime,
    entrypoint: app.entrypoint,
    files: (app.files ?? []).map(f => ({
      path: f.path,
      contents: f.contents,
    })),
    dependencies: { ...(app.dependencies ?? {}) },
    dataBindings: (app.dataBindings ?? []).map(b => ({
      id: b.id,
      name: b.name,
      connectionId: b.connectionId,
      language: b.language,
      code: b.code,
      databaseId: b.databaseId,
      databaseName: b.databaseName,
      materialization: b.materialization ?? "live",
      materializationSchedule: b.materializationSchedule,
    })),
  };
}

export async function up(db: Db): Promise<void> {
  const apps = db.collection<RawApp>("makoapps");
  // EntityVersion model maps to the "entity_versions" collection (see
  // EntityVersionSchema in workspace-schema.ts) — NOT Mongoose's default
  // "entityversions".
  const versions = db.collection("entity_versions");

  const cursor = apps.find({});
  for await (const app of cursor) {
    // Idempotent: skip apps that already have any version history.
    const existing = await versions.findOne({
      entityType: "app",
      entityId: app._id,
    });
    if (existing) continue;

    const snapshot = buildSnapshot(app);
    const now = new Date();

    await versions.insertOne({
      workspaceId: app.workspaceId,
      entityType: "app",
      entityId: app._id,
      version: 1,
      snapshot,
      savedBy: app.createdBy || "system",
      savedByName: "System",
      comment: "Backfilled initial version",
      createdAt: now,
    });

    // Only set the published baseline if the app was never published, so we
    // never clobber an existing published snapshot.
    if (app.published === undefined || app.published === null) {
      await apps.updateOne(
        { _id: app._id },
        {
          $set: {
            published: snapshot,
            publishedVersion: 1,
            publishedAt: now,
          },
        },
      );
    }
  }
}
