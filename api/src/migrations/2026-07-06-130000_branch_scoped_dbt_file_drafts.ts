import { Db } from "mongodb";

export const description =
  "Branch-scoped dbt drafts: stamp dbt_file_drafts with the owner's checked-out branch and re-key the unique index to (projectId, userId, branch, path)";

/**
 * Before: dbt_file_drafts was one uncommitted overlay per (project, user) that
 * silently followed the user across branch switches — edits made "on main"
 * re-based onto whatever branch was checked out next. After: every draft is
 * keyed to the branch it was made on (git-worktree semantics), so a user can
 * iterate on several branches with independent uncommitted state.
 *
 * This migration:
 *  1. stamps existing draft rows with `branch` = the owner's dbt_checkouts
 *     branch for the project (absent row = the project's tracked branch),
 *     which is exactly the branch those drafts overlay today;
 *  2. re-keys the unique index from (projectId, userId, path) to
 *     (projectId, userId, branch, path) and adds a (projectId, branch)
 *     index for branch-wide draft operations.
 *
 * Blank (non-repo) projects never create drafts, so any draft whose project
 * lost its repo binding is left unstamped (unreachable either way, and the
 * old unique index already guaranteed such rows cannot collide under the new
 * key). Idempotent throughout.
 */

interface RawDraft {
  _id: unknown;
  projectId: unknown;
  userId: string;
  branch?: string;
}

function hasIndexOnKeys(
  indexes: Array<{ key?: Record<string, unknown>; name?: string }>,
  keyPattern: Record<string, number>,
): boolean {
  return indexes.some(
    idx => JSON.stringify(idx.key) === JSON.stringify(keyPattern),
  );
}

export async function up(db: Db): Promise<void> {
  const projects = db.collection("dbt_projects");
  const checkouts = db.collection("dbt_checkouts");
  const drafts = db.collection<RawDraft>("dbt_file_drafts");

  // --- 1: stamp unbranched drafts with their owner's checkout branch ---
  const projectIds = await drafts.distinct("projectId", {
    branch: { $exists: false },
  });
  for (const projectId of projectIds) {
    const project = await projects.findOne({ _id: projectId as never });
    const trackedBranch = (project?.repo as { branch?: string } | undefined)
      ?.branch;
    if (!trackedBranch) continue;

    const userIds = await drafts.distinct("userId", {
      projectId,
      branch: { $exists: false },
    });
    for (const userId of userIds) {
      const checkout = await checkouts.findOne({ projectId, userId });
      const branch =
        typeof checkout?.branch === "string" && checkout.branch
          ? checkout.branch
          : trackedBranch;
      await drafts.updateMany(
        { projectId, userId, branch: { $exists: false } },
        { $set: { branch } },
      );
    }
  }

  // --- 2: re-key the unique index ---
  // On a fresh database the collection may not exist yet (indexes() throws
  // "ns does not exist"); createIndex below creates it implicitly.
  const collectionExists =
    (
      await db
        .listCollections({ name: "dbt_file_drafts" }, { nameOnly: true })
        .toArray()
    ).length > 0;
  const indexes = collectionExists ? await drafts.indexes() : [];
  const oldUnique = indexes.find(
    idx =>
      JSON.stringify(idx.key) ===
      JSON.stringify({ projectId: 1, userId: 1, path: 1 }),
  );
  if (oldUnique?.name) {
    await drafts.dropIndex(oldUnique.name);
  }
  if (
    !hasIndexOnKeys(indexes, { projectId: 1, userId: 1, branch: 1, path: 1 })
  ) {
    await drafts.createIndex(
      { projectId: 1, userId: 1, branch: 1, path: 1 },
      { unique: true, name: "dbt_file_drafts_project_user_branch_path" },
    );
  }
  if (!hasIndexOnKeys(indexes, { projectId: 1, branch: 1 })) {
    await drafts.createIndex(
      { projectId: 1, branch: 1 },
      { name: "dbt_file_drafts_project_branch" },
    );
  }
}
