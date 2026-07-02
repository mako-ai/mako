import { createHash } from "crypto";
import { Db } from "mongodb";

export const description =
  "Per-user dbt working trees: brand dbt_files with their branch, move uncommitted edits into per-user dbt_file_drafts, and re-key the dbt_files unique index to (projectId, branch, path)";

/**
 * Before: dbt_files was one shared working tree per project (uncommitted edits
 * visible to everyone). After: dbt_files rows are the COMMITTED base tree of a
 * branch, per-user uncommitted work lives in dbt_file_drafts, and each user
 * has a dbt_checkouts branch pointer (absent row = project default branch).
 *
 * This migration, for every repo-bound project:
 *  1. stamps existing dbt_files rows with `branch` = the project's tracked
 *     branch;
 *  2. converts dirty rows into drafts owned by the row's last editor
 *     (`updatedBy`):
 *       - locally-added rows (no repoBlobSha) → draft "added"; base row removed
 *       - modified rows (blob mismatch)       → draft with the edited content;
 *         the base row keeps its content and is corrected by the next sync
 *       - soft-deleted rows with a repoBlobSha (pending deletions) → draft
 *         deletion; the base row is restored
 *  3. re-keys the unique index from (projectId, path) to
 *     (projectId, branch, path) so one project can hold several branch trees.
 *
 * Blank (non-repo) projects are untouched: their rows keep no branch and stay
 * the single shared tree. Idempotent throughout.
 */

/** Git blob SHA (sha1 of "blob <len>\0<content>") — mirrors git-blob.ts. */
function gitBlobSha(content: string): string {
  const body = Buffer.from(content, "utf8");
  const header = Buffer.from(`blob ${body.length}\0`, "utf8");
  return createHash("sha1")
    .update(Buffer.concat([header, body]))
    .digest("hex");
}

interface RawDbtFile {
  _id: unknown;
  workspaceId: unknown;
  projectId: unknown;
  branch?: string;
  path: string;
  content?: string;
  updatedBy?: string;
  is_deleted?: boolean;
  repoBlobSha?: string;
}

export async function up(db: Db): Promise<void> {
  const projects = db.collection("dbt_projects");
  const files = db.collection<RawDbtFile>("dbt_files");
  const drafts = db.collection("dbt_file_drafts");

  // --- 1 + 2: per repo-bound project, stamp branches and extract drafts ---
  const repoProjects = projects.find({ repo: { $exists: true } });
  for await (const project of repoProjects) {
    const branch = (project.repo as { branch?: string } | undefined)?.branch;
    if (!branch) continue;

    // Stamp unbranched rows with the tracked branch (idempotent: only rows
    // that still miss `branch`).
    await files.updateMany(
      { projectId: project._id, branch: { $exists: false } },
      { $set: { branch } },
    );

    const rows = files.find({ projectId: project._id, branch });
    for await (const row of rows) {
      const owner = row.updatedBy || "unknown";
      const content = row.content ?? "";

      const upsertDraft = async (isDeleted: boolean) => {
        // Idempotent: never clobber a draft that already exists (a partial
        // earlier run, or work done after the code deploy).
        const existing = await drafts.findOne({
          projectId: project._id,
          userId: owner,
          path: row.path,
        });
        if (existing) return;
        const now = new Date();
        await drafts.insertOne({
          workspaceId: row.workspaceId,
          projectId: project._id,
          userId: owner,
          path: row.path,
          content: isDeleted ? "" : content,
          is_deleted: isDeleted,
          baseBlobSha: row.repoBlobSha,
          createdAt: now,
          updatedAt: now,
        });
      };

      if (row.is_deleted) {
        if (row.repoBlobSha) {
          // Pending deletion of a committed file → draft deletion; restore
          // the base row (its retained content approximates the committed
          // blob; the next sync corrects it exactly).
          await upsertDraft(true);
          await files.updateOne(
            { _id: row._id },
            { $set: { is_deleted: false } },
          );
        }
        // Soft-deleted without a blob = legacy recoverable content — keep.
        continue;
      }

      if (!row.repoBlobSha) {
        // Locally added, never committed → pure draft; drop the base row so
        // other users stop seeing uncommitted work.
        await upsertDraft(false);
        await files.deleteOne({ _id: row._id });
        continue;
      }

      if (gitBlobSha(content) !== row.repoBlobSha) {
        // Modified → the edit becomes the editor's draft. The base row keeps
        // the (dirty) content until the next branch sync fast-forwards it;
        // status/diff stay correct because they key off repoBlobSha.
        await upsertDraft(false);
      }
    }
  }

  // --- 3: re-key the unique index ---
  const indexes = await files.indexes();
  const oldUnique = indexes.find(
    idx =>
      JSON.stringify(idx.key) === JSON.stringify({ projectId: 1, path: 1 }),
  );
  if (oldUnique?.name) {
    await files.dropIndex(oldUnique.name);
  }
  const hasNewUnique = indexes.some(
    idx =>
      JSON.stringify(idx.key) ===
      JSON.stringify({ projectId: 1, branch: 1, path: 1 }),
  );
  if (!hasNewUnique) {
    await files.createIndex(
      { projectId: 1, branch: 1, path: 1 },
      { unique: true, name: "dbt_files_project_branch_path" },
    );
  }
}
