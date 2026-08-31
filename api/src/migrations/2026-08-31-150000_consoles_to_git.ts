/**
 * Consoles into the workspace repo (apps.md §16.5, Block D2).
 *
 * For every workspace that already has a repo — a bare repo on this host or
 * a durable mirror (connected or mako-cloud) — replay each saved console's
 * `entity_versions` as commits, commit the live state, stamp the rows
 * (`path`, `sourceBlobSha`, `descriptionSourceSha` where an embedding
 * exists) and write `consoles/README.md`. Existing embeddings are kept.
 *
 * Workspaces with saved consoles but no repo are NOT adopted: there is no
 * Mako-hosted tier (apps.md §17) — they adopt on their first console write
 * after connecting a GitHub repository.
 *
 * Re-runnable: adoption skips rows whose file is already at head.
 */
import { Db } from "mongodb";
import mongoose from "mongoose";
import { loggers } from "../logging";
import { adoptWorkspaceConsoles } from "../apps/workspace-consoles.service";
import { resolveMirrorTarget } from "../apps/cloud-repo.service";
import { repoDirFor, repoExists } from "../apps/repository.service";

const log = loggers.migration();

export const description =
  "Adopt saved consoles into each workspace repo (git is the source of truth; SavedConsole becomes the derived index)";

export async function up(db: Db): Promise<void> {
  if (mongoose.connection.readyState !== 1) {
    // The adoption code uses the Mongoose models; the runner hands us the
    // native Db, so borrow its connection.
    await mongoose.connect(
      (db as unknown as { client: { s: { url: string } } }).client.s.url,
      { dbName: db.databaseName },
    );
  }
  const workspaceIds = (await db
    .collection("savedconsoles")
    .distinct("workspaceId", {
      isSaved: true,
      $or: [{ is_deleted: { $ne: true } }, { is_deleted: { $exists: false } }],
    })) as Array<{ toString(): string }>;

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
      const report = await adoptWorkspaceConsoles(workspaceId, {
        replayHistory: true,
      });
      adopted++;
      log.info("Consoles adopted", { ...report });
    } catch (error) {
      failed++;
      log.error("Console adoption failed for workspace", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  log.info("consoles_to_git done", {
    workspaces: workspaceIds.length,
    adopted,
    skippedNoRepo,
    failed,
  });
}
