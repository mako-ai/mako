/**
 * Copy leftover Mongo `selfDirective` into `SELF_DIRECTIVE.md` before
 * `2026-09-02-120000_unset_workspace_prompt_mongo_fields` drops the field.
 *
 * The prompt cutover (`2026-09-01-020000`) copied `settings.customPrompt`
 * into `PROMPT.md` and skipped repo-less workspaces. Self-directive never
 * got an equivalent step, so the unset migration would erase every remaining
 * blob — including repo-linked workspaces whose GitHub repo does not yet
 * have `SELF_DIRECTIVE.md`.
 *
 * This file sorts before the unset (110000 < 120000). For every workspace
 * with a non-empty `selfDirective` AND a GitHub binding: write the file
 * only when it is absent (an externally-authored file wins), push the
 * mirror, leave the Mongo field for the unset to drop. Repo-less workspaces
 * have nowhere durable to copy; they stay skipped here.
 *
 * Fail-closed: a copy error aborts the deploy so 120000 does not run.
 *
 * NOTE the mongoose connect below: repo helpers (`getWorkspaceRepo`,
 * `commitWorkspaceSelfDirective`) use mongoose models. Never remove it.
 */
import { Db } from "mongodb";
import mongoose from "mongoose";
import { loggers } from "../logging";
import {
  SELF_DIRECTIVE_PATH,
  commitWorkspaceSelfDirective,
  readWorkspaceSelfDirectiveFile,
} from "../apps/workspace-prompt";
import { mirrorPushNow } from "../apps/cloud-repo.service";
import { getWorkspaceRepo } from "../services/workspace-repos.service";

const log = loggers.migration();

export const description =
  "Copy workspace selfDirective into SELF_DIRECTIVE.md for GitHub-linked workspaces before the Mongo unset";

export async function up(db: Db): Promise<void> {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(
      (db as unknown as { client: { s: { url: string } } }).client.s.url,
      { dbName: db.databaseName },
    );
  }

  const workspaces = await db
    .collection("workspaces")
    .find(
      { selfDirective: { $exists: true, $nin: [null, ""] } },
      { projection: { selfDirective: 1, name: 1 } },
    )
    .toArray();

  let migrated = 0;
  let skippedNoRepo = 0;
  let skippedExistingFile = 0;
  let failed = 0;
  for (const ws of workspaces) {
    const workspaceId = String(ws._id);
    const content = (ws as { selfDirective?: string }).selfDirective;
    if (!content?.trim()) continue;
    try {
      if (!(await getWorkspaceRepo(workspaceId))) {
        skippedNoRepo++;
        continue;
      }
      if ((await readWorkspaceSelfDirectiveFile(workspaceId)) !== null) {
        skippedExistingFile++;
        migrated++;
        continue;
      }
      await commitWorkspaceSelfDirective(workspaceId, content);
      await mirrorPushNow(workspaceId);
      migrated++;
      log.info("Workspace self-directive copied to git", {
        workspaceId,
        name: (ws as { name?: string }).name,
        path: SELF_DIRECTIVE_PATH,
      });
    } catch (error) {
      failed++;
      log.error("Workspace self-directive migration failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (failed > 0) {
    throw new Error(
      `Self-directive migration failed for ${failed} workspace(s) — Mongo fields left in place; fix and re-run`,
    );
  }
  log.info("workspace_self_directive_to_git done", {
    workspaces: workspaces.length,
    migrated,
    skippedNoRepo,
    skippedExistingFile,
  });
}
