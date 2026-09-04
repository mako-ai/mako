import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Drop the skills collection: skills are files in the workspace repo (apps.md §27)";

/**
 * The derived retrieval index (rows, $text index, Atlas vector index) is
 * gone with the collection; the agent reads `skills/<name>/SKILL.md` at main.
 * Nothing is migrated out: every workspace with a bound repo already holds
 * its skills as files (adopted 2026-08-31), and there are no users on
 * unbound workspaces.
 */
export async function up(db: Db): Promise<void> {
  const names = await db.listCollections({ name: "skills" }).toArray();
  if (names.length === 0) {
    log.info("skills collection already absent");
    return;
  }
  const count = await db.collection("skills").estimatedDocumentCount();
  await db.collection("skills").drop();
  log.info("Dropped skills collection", { rows: count });
}
