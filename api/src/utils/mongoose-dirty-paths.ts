/**
 * Reduce a list of dirty Mongoose paths (from `doc.directModifiedPaths()`)
 * to the minimal set safe to use as `$set`/`$unset` keys in a single update.
 *
 * MongoDB rejects an update that writes both a path and one of its
 * descendants with "Updating the path 'x' would create a conflict at 'x'".
 * That combination occurs whenever a caller both assigns a nested field
 * (dirtying e.g. `dataBindings.2.materializationSchedule.enabled`) and calls
 * `markModified()` on an ancestor (e.g. `dataBindings`). Keeping only the
 * shortest dirty ancestors is lossless: their values are read from the
 * mutated document, so every descendant change is already included.
 */
export function minimizeDirtyPaths(paths: string[]): string[] {
  return paths.filter(
    path => !paths.some(other => path.startsWith(`${other}.`)),
  );
}
