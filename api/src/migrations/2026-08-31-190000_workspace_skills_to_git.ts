/**
 * Workspace skills into the workspace repo (apps.md §10 Block D1).
 *
 * For every workspace that has skills AND already has a repo — a local bare
 * repo or a connected mirror — write each Mongo skill as
 * `skills/<name>/SKILL.md` (only missing files) plus the `skills/README.md`
 * adoption marker, in one commit, and push the mirror. Mongo rows stay as
 * the derived retrieval index (embeddings, $text, useCount); the push-driven
 * sync keeps them level from here on.
 *
 * Workspaces without a repo are left alone (no Mako-hosted tier, apps.md
 * §17): their first skill save adopts lazily after they connect GitHub.
 * Re-runnable: only missing paths are written.
 */
import { Db } from "mongodb";
import mongoose from "mongoose";
import { loggers } from "../logging";
import { adoptWorkspaceSkills } from "../apps/workspace-skills.service";
import { resolveMirrorTarget } from "../apps/cloud-repo.service";
import { repoDirFor, repoExists } from "../apps/repository.service";

const log = loggers.migration();

export const description =
  "Adopt workspace skills into each workspace repo (skills/<name>/SKILL.md; Mongo stays the derived retrieval index)";

export async function up(db: Db): Promise<void> {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(
      (db as unknown as { client: { s: { url: string } } }).client.s.url,
      { dbName: db.databaseName },
    );
  }
  const workspaceIds = (await db
    .collection("skills")
    .distinct("workspaceId")) as Array<{ toString(): string }>;

  let adopted = 0;
  let skippedNoRepo = 0;
  let failed = 0;
  for (const raw of workspaceIds) {
    const workspaceId = raw.toString();
    try {
      const hasLocal = await repoExists(repoDirFor(workspaceId));
      const hasMirror = hasLocal
        ? true
        : Boolean(await resolveMirrorTarget(workspaceId).catch(() => null));
      if (!hasLocal && !hasMirror) {
        skippedNoRepo++;
        continue;
      }
      const report = await adoptWorkspaceSkills(workspaceId);
      adopted++;
      log.info("Skills adopted", { ...report });
    } catch (error) {
      failed++;
      log.error("Skills adoption failed for workspace", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  log.info("workspace_skills_to_git done", {
    workspaces: workspaceIds.length,
    adopted,
    skippedNoRepo,
    failed,
  });
}
