/**
 * Persist a mutated MakoApp draft behind a version predicate.
 *
 * A plain `doc.save()` can overwrite a concurrent atomic file/binding edit
 * with the stale snapshot loaded at the start of the request. Callers mutate
 * `doc` in memory, then this helper `$set`s only the dirty paths and `$inc`s
 * `version` iff it still matches `expectedVersion`.
 */
import { MakoApp, type IMakoApp } from "../database/workspace-schema";
import { minimizeDirtyPaths } from "../utils/mongoose-dirty-paths";

const SKIP_DRAFT_PATHS = new Set([
  "_id",
  "workspaceId",
  "version",
  "createdAt",
  "updatedAt",
]);

export const APP_DRAFT_VERSION_CONFLICT =
  "App changed while this update was being applied. Re-read the app and retry.";

export function buildAppDraftUpdate(doc: {
  directModifiedPaths: () => string[];
  get: (path: string) => unknown;
}): {
  setFields: Record<string, unknown>;
  unsetFields: Record<string, "">;
} {
  const setFields: Record<string, unknown> = {};
  const unsetFields: Record<string, ""> = {};
  // Minimized: $set-ing both an ancestor (markModified) and a nested
  // descendant path (direct assignment) makes MongoDB reject the whole
  // update with "would create a conflict at '<ancestor>'".
  for (const path of minimizeDirtyPaths(doc.directModifiedPaths())) {
    if (SKIP_DRAFT_PATHS.has(path)) continue;
    const value = doc.get(path);
    if (value === undefined) unsetFields[path] = "";
    else setFields[path] = value;
  }
  return { setFields, unsetFields };
}

export async function persistMutatedAppDraft(
  doc: IMakoApp,
  expectedVersion: number = doc.version,
) {
  const { setFields, unsetFields } = buildAppDraftUpdate(doc);
  return MakoApp.findOneAndUpdate(
    {
      _id: doc._id,
      workspaceId: doc.workspaceId,
      version: expectedVersion,
    },
    {
      ...(Object.keys(setFields).length > 0 ? { $set: setFields } : {}),
      ...(Object.keys(unsetFields).length > 0 ? { $unset: unsetFields } : {}),
      $inc: { version: 1 },
    },
    { new: true, runValidators: true },
  );
}
