/**
 * Apps v2 (experimental, flag-gated) — create the metadata collections'
 * indexes explicitly instead of relying on Mongoose's implicit index builds
 * (repo convention; adopted from the parallel apps-v2 branch).
 *
 * Touches ONLY the new v2 collections; Apps v1 is unaffected.
 */
import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Create Apps v2 metadata indexes (app_projects_v2, app_worktrees_v2)";

const INDEXES: Record<
  string,
  Array<{ keys: Record<string, 1 | -1>; unique?: boolean }>
> = {
  app_projects_v2: [
    { keys: { workspaceId: 1, updatedAt: -1 } },
    { keys: { owner_id: 1 } },
    { keys: { workspaceId: 1, "sharedWith.userId": 1 } },
  ],
  app_worktrees_v2: [
    // Pre-§10 shape: one worktree per (project, actor). The workspace-monorepo
    // migration drops this one, but it must still exist for DBs replaying
    // history in order.
    { keys: { projectId: 1, userId: 1 }, unique: true },
    // §10 Block B: worktrees are per (workspace, actor), so this is UNIQUE —
    // it must match `AppWorktreeV2Schema.index({ workspaceId: 1, userId: 1 },
    // { unique: true })` in workspace-schema.ts. Declaring it non-unique here
    // made this migration unrunnable against any database where Mongoose's
    // autoIndex had already built the unique version: same auto-generated
    // name, conflicting options => IndexOptionsConflict.
    { keys: { workspaceId: 1, userId: 1 }, unique: true },
    // commitChatTurn scans dirty worktrees per workspace+actor.
    { keys: { workspaceId: 1, userId: 1, wipOid: 1 } },
  ],
};

/** The name MongoDB auto-generates for a key spec (`a_1_b_-1`). */
function autoIndexName(keys: Record<string, 1 | -1>): string {
  return Object.entries(keys)
    .map(([field, direction]) => `${field}_${direction}`)
    .join("_");
}

/** Index names already present, or empty when the collection does not exist. */
async function existingIndexNames(
  db: Db,
  collection: string,
): Promise<Set<string>> {
  try {
    const indexes = await db.collection(collection).listIndexes().toArray();
    return new Set(indexes.map(index => index.name as string));
  } catch {
    // NamespaceNotFound: nothing exists yet, so nothing can conflict.
    return new Set<string>();
  }
}

export async function up(db: Db): Promise<void> {
  for (const [collection, indexes] of Object.entries(INDEXES)) {
    const present = await existingIndexNames(db, collection);
    for (const index of indexes) {
      const name = autoIndexName(index.keys);
      // Ensure, don't assert: Mongoose autoIndex may already have built this
      // index, possibly with options that have moved on since this migration
      // was written. Recreating it by the same auto-generated name would throw
      // IndexOptionsConflict and wedge every later migration behind it. An
      // index that already exists is left exactly as it is — reconciling
      // options is the job of whichever migration changes them, not this one.
      if (present.has(name)) {
        log.info("Apps v2 index already present, skipping", {
          collection,
          name,
        });
        continue;
      }
      const created = await db
        .collection(collection)
        .createIndex(index.keys, index.unique ? { unique: true } : {});
      log.info("Ensured Apps v2 index", { collection, name: created });
    }
  }
}
