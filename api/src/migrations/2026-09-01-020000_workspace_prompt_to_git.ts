/**
 * The workspace custom prompt becomes `PROMPT.md` in the workspace repo
 * (apps.md §21).
 *
 * For every workspace with a `settings.customPrompt` AND a repo (local or
 * connected mirror): write `PROMPT.md` (only when absent — an
 * externally-authored file wins), push the mirror, then unset the Mongo
 * field. Repo-less workspaces keep the Mongo value — reads fall back to it,
 * and their first edit after connecting GitHub commits it.
 *
 * NOTE the mongoose connect below: repo helpers (`resolveMirrorTarget` →
 * `getWorkspaceRepo`) use mongoose models. The dbt cutover migration skipped
 * this and every model read buffered for 10s, timed out, and was swallowed
 * into "no repo" — the draft salvage silently no-opped on the deploy runner
 * (apps.md §20.3 post-mortem). Never remove it.
 */
import { Db } from "mongodb";
import mongoose from "mongoose";
import { loggers } from "../logging";
import {
  PROMPT_PATH,
  commitWorkspacePrompt,
  readWorkspacePromptFile,
} from "../apps/workspace-prompt";
import {
  ensureLocalRepo,
  mirrorPushNow,
  resolveMirrorTarget,
} from "../apps/cloud-repo.service";
import { repoDirFor, repoExists } from "../apps/repository.service";

const log = loggers.migration();

export const description =
  "Workspace custom prompt into the workspace repo as PROMPT.md (Mongo field kept only for repo-less workspaces)";

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
      { "settings.customPrompt": { $exists: true, $nin: [null, ""] } },
      { projection: { "settings.customPrompt": 1, name: 1 } },
    )
    .toArray();

  let migrated = 0;
  let skippedNoRepo = 0;
  let failed = 0;
  for (const ws of workspaces) {
    const workspaceId = String(ws._id);
    const content = (ws as { settings?: { customPrompt?: string } }).settings
      ?.customPrompt;
    if (!content?.trim()) continue;
    try {
      await ensureLocalRepo(workspaceId);
      const hasRepo =
        (await repoExists(repoDirFor(workspaceId))) ||
        Boolean(await resolveMirrorTarget(workspaceId).catch(() => null));
      if (!hasRepo) {
        skippedNoRepo++;
        continue;
      }
      if ((await readWorkspacePromptFile(workspaceId)) === null) {
        await commitWorkspacePrompt(workspaceId, content);
        await mirrorPushNow(workspaceId);
      }
      await db
        .collection("workspaces")
        .updateOne(
          { _id: ws._id },
          { $unset: { "settings.customPrompt": "" } },
        );
      migrated++;
      log.info("Workspace prompt migrated", {
        workspaceId,
        name: (ws as { name?: string }).name,
        path: PROMPT_PATH,
      });
    } catch (error) {
      failed++;
      log.error("Workspace prompt migration failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (failed > 0) {
    throw new Error(
      `Prompt migration failed for ${failed} workspace(s) — Mongo fields left in place; fix and re-run`,
    );
  }
  log.info("workspace_prompt_to_git done", {
    workspaces: workspaces.length,
    migrated,
    skippedNoRepo,
  });
}
