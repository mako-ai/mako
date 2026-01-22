import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Mark all existing consoles as saved (isSaved: true) to distinguish from auto-saved drafts";

/**
 * Migration: Mark existing consoles as saved
 *
 * Before this migration, all consoles were considered "saved".
 * Now we distinguish between:
 * - Saved consoles (isSaved: true): Explicitly saved by user, shown in explorer
 * - Draft consoles (isSaved: false): Auto-saved, not shown in explorer
 *
 * This migration sets isSaved: true for all existing consoles that don't have
 * the field set yet, preserving their visibility in the explorer.
 */
export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  if (!collectionNames.includes("savedconsoles")) {
    log.info("ℹ️  Collection 'savedconsoles' not found, skipping migration.");
    return;
  }

  // Set isSaved: true for all consoles that don't have the field
  const result = await db
    .collection("savedconsoles")
    .updateMany({ isSaved: { $exists: false } }, { $set: { isSaved: true } });

  log.info(
    `✅ Marked ${result.modifiedCount} existing consoles as saved (isSaved: true)`,
  );
}
