/**
 * Notebooks checkpoint into the workspace repo as `.deepnote` files
 * (apps.md §24). The store (GCS) STAYS the hot working copy — nothing is
 * dropped; this only writes the initial checkpoints and stamps index rows.
 *
 * Mongoose connects first (§21 rule). NOTE for the deploy workflow: the
 * migrate step must carry NOTEBOOK_GCS_BUCKET or the runner would silently
 * read an empty filesystem store — the same env-class bug as the dbt
 * salvage, caught this time before it shipped.
 */
import { Db } from "mongodb";
import mongoose from "mongoose";
import { loggers } from "../logging";
import { adoptWorkspaceNotebooks } from "../notebooks/notebook-git.service";
import { mirrorPushNow } from "../apps/cloud-repo.service";

const log = loggers.migration();

export const description =
  "Notebooks checkpoint into the workspace repo as .deepnote files (store stays the hot layer)";

export async function up(db: Db): Promise<void> {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(
      (db as unknown as { client: { s: { url: string } } }).client.s.url,
      { dbName: db.databaseName },
    );
  }
  if (!process.env.NOTEBOOK_GCS_BUCKET) {
    log.warn(
      "NOTEBOOK_GCS_BUCKET is not set — adopting from the local filesystem store (dev only). In CI this means the migrate step env is missing the bucket.",
    );
  }
  const workspaceIds = (await db
    .collection("notebookindexes")
    .distinct("workspaceId")) as Array<{ toString(): string }>;
  let adopted = 0;
  let failed = 0;
  for (const raw of workspaceIds) {
    const workspaceId = raw.toString();
    try {
      const report = await adoptWorkspaceNotebooks(workspaceId);
      if (report.written > 0) {
        await mirrorPushNow(workspaceId);
        adopted++;
        log.info("Notebooks adopted", { workspaceId, ...report });
      }
    } catch (error) {
      failed++;
      log.error("Notebook adoption failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (failed > 0) {
    throw new Error(`Notebook adoption failed for ${failed} workspace(s)`);
  }
  log.info("notebooks_to_git done", {
    workspaces: workspaceIds.length,
    adopted,
  });
}
