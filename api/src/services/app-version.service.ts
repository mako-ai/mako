/**
 * App version snapshots.
 *
 * React Apps autosave on every edit (each PUT bumps `MakoApp.version`), so
 * unlike consoles we do NOT snapshot on every write — that would bury real
 * checkpoints under hundreds of keystroke-level versions. Instead, app
 * versions are *explicit checkpoints*: a user clicks "Save version" or the
 * agent calls `app_save_version`, and we freeze the editable app definition
 * into an immutable `EntityVersion` (entityType "app").
 *
 * `buildAppSnapshot` captures the editable definition only. `applyAppSnapshot`
 * reverts a doc to a snapshot while preserving the server-owned binding
 * materialization `cache` by id (mirrors the PUT /apps/:id contract), so a
 * restore never resurrects a stale parquet artifact pointer or drops a fresh
 * one.
 */
import type { IMakoApp } from "../database/workspace-schema";
import { snapshotsEqual } from "./snapshot-diff";

/** The editable body of an app, frozen into a version snapshot (no caches). */
export interface AppSnapshot {
  title: string;
  description?: string;
  template: string;
  runtime: "cdn" | "webcontainer";
  entrypoint: string;
  files: Array<{ path: string; contents: string }>;
  dependencies: Record<string, string>;
  dataBindings: Array<Record<string, unknown>>;
}

/**
 * True when the working draft differs from the last published snapshot (or the
 * app has never been published). Drives the "unpublished changes" hint in the
 * editor so users know the live/shared version is behind the draft.
 */
export function appHasUnpublishedChanges(doc: IMakoApp): boolean {
  if (!doc.published) return true;
  return !snapshotsEqual(buildAppSnapshot(doc), doc.published);
}

/** Freeze the current editable definition of an app into a snapshot. */
export function buildAppSnapshot(doc: IMakoApp): AppSnapshot {
  return {
    title: doc.title,
    description: doc.description,
    template: doc.template,
    runtime: doc.runtime,
    entrypoint: doc.entrypoint,
    files: (doc.files ?? []).map(f => ({ path: f.path, contents: f.contents })),
    dependencies: { ...(doc.dependencies ?? {}) },
    // Binding query definitions only — `cache` is server-owned and excluded.
    dataBindings: (doc.dataBindings ?? []).map(b => ({
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

/**
 * Revert `doc` to `snapshot` in place. Binding materialization caches are
 * preserved by binding id so a restore re-points at the same artifacts the
 * server already built (and a binding that did not exist before simply has no
 * cache). The caller is responsible for bumping `version` and saving.
 */
export function applyAppSnapshot(doc: IMakoApp, snapshot: AppSnapshot): void {
  doc.title = snapshot.title;
  doc.description = snapshot.description;
  doc.template = snapshot.template;
  doc.runtime = snapshot.runtime;
  doc.entrypoint = snapshot.entrypoint;
  doc.files = (snapshot.files ?? []).map(f => ({
    path: f.path,
    contents: f.contents,
  })) as IMakoApp["files"];
  doc.dependencies = { ...(snapshot.dependencies ?? {}) };

  const cacheById = new Map(
    (doc.dataBindings ?? []).map(b => [b.id, b.cache]),
  );
  doc.dataBindings = (snapshot.dataBindings ?? []).map(b => ({
    id: b.id as string,
    name: b.name as string,
    connectionId: b.connectionId as string,
    language: (b.language as "sql" | "javascript" | "mongodb") || "sql",
    code: (b.code as string) ?? "",
    databaseId: b.databaseId as string | undefined,
    databaseName: b.databaseName as string | undefined,
    materialization: b.materialization === "parquet" ? "parquet" : "live",
    materializationSchedule: b.materializationSchedule,
    cache: cacheById.get(b.id as string),
  })) as IMakoApp["dataBindings"];
  // `dependencies` is a Mixed path — assignment isn't auto-tracked by Mongoose.
  doc.markModified("dependencies");
}
