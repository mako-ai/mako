import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Invert workspace AI model config from allowlist (enabledModelIds/enabledModels) to blocklist (disabledModelIds=[]). New super-admin-visible models now auto-appear in every workspace.";

export async function up(db: Db): Promise<void> {
  const workspaces = db.collection("workspaces");

  const result = await workspaces.updateMany(
    {},
    {
      $set: { "settings.disabledModelIds": [] },
      $unset: {
        "settings.enabledModelIds": "",
        "settings.enabledModels": "",
      },
    },
  );

  log.info("Inverted workspace model allowlist to empty blocklist", {
    matched: result.matchedCount,
    modified: result.modifiedCount,
  });
}
