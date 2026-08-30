/**
 * Skills to git (apps-v2.md §10 Block D1): adopt every workspace's Mongo
 * skills into its repo as `skills/<name>/SKILL.md`, and bring every existing
 * repo level with the workspace starter template (AGENTS.md, skills/README).
 *
 * Source of truth flips to the repo; the Mongo `skills` collection stays as
 * the derived retrieval index (embeddings, $text, useCount), so no rows are
 * deleted here — the committed `skills/README.md` is the adoption marker that
 * lets the push-driven sync (workspace-skills.service) reconcile from now on.
 *
 * Two sweeps, one commit per workspace:
 *   1. Workspaces WITH Mongo skills, found via the collection — their repo is
 *      restored from the mirror (or initialized from the template) and the
 *      missing skill files are committed. Driving this off Mongo matters on
 *      serverless hosts, where the local repos root only holds warm caches.
 *   2. Workspaces with a local repo but no skills — template backfill only.
 *
 * Idempotent by construction: only missing paths are written, so a re-run
 * (or a workspace already self-adopted by a post-deploy save_skill) commits
 * nothing. Failures log and continue; a failed workspace self-heals on its
 * first in-product skill write, which performs the same adoption.
 */
import { Db, ObjectId } from "mongodb";
import fs from "node:fs/promises";
import path from "node:path";
import { loggers } from "../logging";
import { appsV2ReposRoot } from "../apps-v2/config";
import { ensureLocalRepo, mirrorPushNow } from "../apps-v2/cloud-repo.service";
import {
  initRepo,
  readBlob,
  repoDirFor,
  repoExists,
  resolveCommit,
} from "../apps-v2/repository.service";
import {
  serializeSkillFile,
  skillFilePath,
  SKILL_NAME_RE,
} from "../apps-v2/skill-files";
import { workspaceSeedFiles } from "../apps-v2/workspace-template";
import { missingTemplateWrites } from "../apps-v2/workspace-skills.service";
import { commitFilesOnBranch } from "../apps-v2/worktree.service";

const log = loggers.migration();

export const description =
  "Workspace skills to git: commit Mongo skills as skills/<name>/SKILL.md; seed AGENTS.md + skills/README into workspace repos";

interface SkillDoc {
  name: string;
  loadWhen: string;
  body: string;
  entities?: string[];
  suppressed?: boolean;
}

async function fileExists(repoDir: string, relPath: string): Promise<boolean> {
  try {
    await readBlob(repoDir, "refs/heads/main", relPath);
    return true;
  } catch {
    return false;
  }
}

async function adoptWorkspace(
  db: Db,
  workspaceId: string,
  hasRepoAlready: boolean,
): Promise<void> {
  const skills = (await db
    .collection("skills")
    .find({ workspaceId: new ObjectId(workspaceId) })
    .project({ name: 1, loadWhen: 1, body: 1, entities: 1, suppressed: 1 })
    .toArray()) as unknown as SkillDoc[];

  // Restore-from-mirror only matters when we intend to write; a workspace
  // with neither skills nor a warm repo is left alone entirely.
  if (skills.length === 0 && !hasRepoAlready) return;

  await ensureLocalRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);

  if (!(await repoExists(repoDir))) {
    if (skills.length === 0) return;
    await initRepo(repoDir, workspaceSeedFiles(), {
      message: "Initialize workspace repository",
    });
  }
  if (!(await resolveCommit(repoDir, "refs/heads/main"))) {
    log.warn("Workspace repo has no main branch; skipping", { workspaceId });
    return;
  }

  const writes = await missingTemplateWrites(repoDir);
  for (const skill of skills) {
    if (!SKILL_NAME_RE.test(skill.name)) {
      log.warn("Skill name not representable as a path; skipping", {
        workspaceId,
        name: skill.name,
      });
      continue;
    }
    const relPath = skillFilePath(skill.name);
    if (await fileExists(repoDir, relPath)) continue;
    writes[relPath] = serializeSkillFile({
      name: skill.name,
      loadWhen: skill.loadWhen,
      entities: skill.entities ?? [],
      suppressed: !!skill.suppressed,
      body: skill.body,
    });
  }

  if (Object.keys(writes).length > 0) {
    await commitFilesOnBranch(
      repoDir,
      "main",
      { writes },
      {
        message:
          skills.length > 0
            ? "Adopt workspace skills into git"
            : "Add workspace agent context (AGENTS.md, skills/)",
      },
    );
    log.info("Workspace adopted", {
      workspaceId,
      files: Object.keys(writes).length,
      skills: skills.length,
    });
  }
  // Awaited (not queued): the migration process exits when the run ends, and
  // a queued push that never drains would leave the adoption commit only in
  // the ephemeral local cache. A mirror failure is logged, not fatal — Mongo
  // rows are untouched, and the first in-product skill write re-adopts.
  try {
    await mirrorPushNow(workspaceId);
  } catch (error) {
    log.warn("Mirror push failed after adoption", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function up(db: Db): Promise<void> {
  const withSkills = (
    await db.collection("skills").distinct("workspaceId")
  ).map(id => String(id));

  const localRepos = new Set(
    (await fs.readdir(appsV2ReposRoot()).catch(() => [] as string[]))
      .filter(entry => entry.endsWith(".git"))
      .map(entry => path.basename(entry, ".git")),
  );

  const all = new Set<string>([...withSkills, ...localRepos]);
  for (const workspaceId of all) {
    if (!/^[0-9a-f]{24}$/i.test(workspaceId)) continue;
    try {
      await adoptWorkspace(db, workspaceId, localRepos.has(workspaceId));
    } catch (error) {
      log.warn("Workspace skills adoption failed; continuing", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
