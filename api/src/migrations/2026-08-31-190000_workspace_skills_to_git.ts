import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Adopt workspace skills into each workspace repo (skills/<name>/SKILL.md; Mongo stays the derived retrieval index)";

/**
 * Applied on 2026-08-31. Since apps.md §27 the files at main are the only
 * store and the `skills` collection is dropped (2026-09-04), so there is
 * nothing left to adopt from; the ledger entry stays so the migration
 * history is contiguous.
 */
export async function up(_db: Db): Promise<void> {
  log.info("workspace_skills_to_git: superseded by files-only skills; no-op");
}
