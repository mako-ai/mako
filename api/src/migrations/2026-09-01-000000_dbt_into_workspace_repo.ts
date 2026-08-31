/**
 * dbt moves into the workspace repo (apps.md §20, Block D3).
 *
 * The dbt project's files become the `dbt/` folder of the ONE workspace
 * repo; the Mongo file mirror (dbt_files), the per-user draft overlay
 * (dbt_file_drafts) and the per-project checkouts (dbt_checkouts) are
 * retired, along with the per-project repo binding and the never-enabled PR
 * CI config. The file import itself (git subtree of the old dbt repo) is a
 * supervised runbook step, not this migration — see apps.md §20.
 *
 * Before dropping anything, uncommitted DRAFTS are salvaged: each
 * (user, branch) group becomes a commit on `dbt-drafts/<userId>/<branch>` in
 * the workspace repo, so nobody's in-flight edit dies with the collection.
 * Salvage failures leave the draft collection in place (fail closed).
 */
import { Db } from "mongodb";
import { loggers } from "../logging";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  repoDirFor,
  repoExists,
  resolveCommit,
  updateRefCas,
} from "../apps/repository.service";
import { ensureLocalRepo, mirrorPushNow } from "../apps/cloud-repo.service";
import { ZERO_OID } from "../apps/git";

const log = loggers.migration();

export const description =
  "dbt into the workspace repo: salvage draft overlays to dbt-drafts/* branches, drop dbt_files/drafts/checkouts, retire repo binding + CI config + dbt-file entity versions";

function sanitizeRef(segment: string): string {
  return segment
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

export async function up(db: Db): Promise<void> {
  const drafts = db.collection("dbt_file_drafts");
  const projects = db.collection("dbt_projects");

  // ---- 1. Salvage drafts to branches in the workspace repo ----
  const groups = (await drafts
    .aggregate([
      {
        $group: {
          _id: {
            projectId: "$projectId",
            userId: "$userId",
            branch: "$branch",
          },
          files: {
            $push: {
              path: "$path",
              content: "$content",
              is_deleted: "$is_deleted",
            },
          },
        },
      },
    ])
    .toArray()) as Array<{
    _id: { projectId: { toString(): string }; userId: string; branch: string };
    files: Array<{ path: string; content?: string; is_deleted?: boolean }>;
  }>;

  let salvaged = 0;
  let salvageFailed = 0;
  const workspaceByProject = new Map<string, string>();
  for (const p of await projects
    .find({}, { projection: { workspaceId: 1 } })
    .toArray()) {
    workspaceByProject.set(String(p._id), String(p.workspaceId));
  }

  for (const group of groups) {
    const workspaceId = workspaceByProject.get(String(group._id.projectId));
    const label = `${group._id.userId}@${group._id.branch} (${group.files.length} files)`;
    if (!workspaceId) {
      log.warn("Draft group has no project; skipping", { label });
      continue;
    }
    try {
      await ensureLocalRepo(workspaceId);
      const repoDir = repoDirFor(workspaceId);
      if (!(await repoExists(repoDir))) {
        // No workspace repo (toy workspace, never connected): drafts have no
        // durable home — logged and dropped with the collection (§17: no
        // repo, no durability).
        log.warn("No workspace repo for draft salvage; drafts will drop", {
          workspaceId,
          label,
        });
        continue;
      }
      const branch = sanitizeRef(
        `dbt-drafts/${group._id.userId}/${group._id.branch}`,
      );
      if (!(await resolveCommit(repoDir, `refs/heads/${branch}`))) {
        const mainHead = await resolveCommit(
          repoDir,
          `refs/heads/${DEFAULT_BRANCH}`,
        );
        if (!mainHead) throw new Error("workspace repo has no default branch");
        await updateRefCas(repoDir, `refs/heads/${branch}`, mainHead, ZERO_OID);
      }
      const writes: Record<string, string> = {};
      for (const f of group.files) {
        if (!f.is_deleted) writes[`dbt/${f.path}`] = f.content ?? "";
      }
      if (Object.keys(writes).length === 0) continue;
      await commitBlobsOnBranch(
        repoDir,
        branch,
        { writes },
        {
          message: `dbt: salvage uncommitted drafts of ${group._id.userId} from realadvisor/dbt branch "${group._id.branch}"`,
        },
      );
      // The runner's local clone is thrown away with the job — the mirror
      // push is what makes the salvage real. Fail closed on push failure.
      await mirrorPushNow(workspaceId);
      salvaged++;
      log.info("Draft group salvaged and pushed", { branch, label });
    } catch (error) {
      salvageFailed++;
      log.error("Draft salvage failed", {
        label,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (salvageFailed > 0) {
    throw new Error(
      `Draft salvage failed for ${salvageFailed} group(s); dbt collections left untouched — fix and re-run`,
    );
  }

  // ---- 2. Drop the Mongo file layer ----
  for (const name of ["dbt_files", "dbt_file_drafts", "dbt_checkouts"]) {
    const exists = await db.listCollections({ name }).hasNext();
    if (exists) {
      await db.collection(name).drop();
      log.info("Dropped collection", { name });
    }
  }

  // ---- 3. Retire dbt-file entity versions (git history replaces them) ----
  const versions = await db
    .collection("entity_versions")
    .deleteMany({ entityType: "dbt-file" });

  // ---- 4. Retire the per-project repo binding + CI + protected branches ----
  const unbound = await projects.updateMany(
    {},
    { $unset: { repo: "", protectedBranches: "", ci: "" } },
  );

  log.info("dbt_into_workspace_repo done", {
    draftGroupsSalvaged: salvaged,
    versionsDeleted: versions.deletedCount,
    projectsUnbound: unbound.modifiedCount,
  });
}
