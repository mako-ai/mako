import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Archive the retired skills collection: skills are files in the workspace repo (apps.md §27)";

const ARCHIVE_COLLECTION = "skills_retired_20260904";

/**
 * Rename rather than destroy the retired index. The 2026-08-31 adoption was
 * best-effort (unbound workspaces were skipped and per-workspace failures were
 * logged), so the collection can still contain the only copy of a skill. The
 * archive is outside every runtime code path and can be deleted manually once
 * each deployment has verified that its files are complete.
 */
export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const names = new Set(collections.map(collection => collection.name));
  if (!names.has("skills")) {
    log.info("skills collection already absent", {
      archivePresent: names.has(ARCHIVE_COLLECTION),
    });
    return;
  }
  if (names.has(ARCHIVE_COLLECTION)) {
    throw new Error(
      `Refusing to overwrite ${ARCHIVE_COLLECTION} while skills still exists`,
    );
  }
  const count = await db.collection("skills").estimatedDocumentCount();
  await db.collection("skills").rename(ARCHIVE_COLLECTION);
  log.info("Archived retired skills collection", {
    archiveCollection: ARCHIVE_COLLECTION,
    rows: count,
  });
}
