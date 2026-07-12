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
    { keys: { projectId: 1, userId: 1 }, unique: true },
    { keys: { workspaceId: 1, userId: 1 } },
    // commitChatTurn scans dirty worktrees per workspace+actor.
    { keys: { workspaceId: 1, userId: 1, wipOid: 1 } },
  ],
};

export async function up(db: Db): Promise<void> {
  for (const [collection, indexes] of Object.entries(INDEXES)) {
    for (const index of indexes) {
      const name = await db
        .collection(collection)
        .createIndex(index.keys, index.unique ? { unique: true } : {});
      log.info("Ensured Apps v2 index", { collection, name });
    }
  }
}
