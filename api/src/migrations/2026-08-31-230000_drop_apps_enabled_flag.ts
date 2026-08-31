/**
 * Remove `settings.appsEnabled` — the v1→v2 rollout flag (apps.md §19).
 *
 * The rollout it managed is over (v1 erased, §17): the flag gated only UI
 * visibility while agents/MCP could write regardless, and the real
 * precondition for the surface is a connected repo, which is a fact on the
 * workspace doc rather than an admin-maintained bit. Apps and Source
 * Control are visible everywhere now.
 */
import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Drop settings.appsEnabled (v1→v2 rollout flag); Apps/Source Control are always visible";

export async function up(db: Db): Promise<void> {
  const result = await db
    .collection("workspaces")
    .updateMany(
      { "settings.appsEnabled": { $exists: true } },
      { $unset: { "settings.appsEnabled": "" } },
    );
  log.info("drop_apps_enabled_flag done", { unset: result.modifiedCount });
}
