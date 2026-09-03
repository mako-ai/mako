/**
 * Drop leftover workspace prompt / self-directive blobs from Mongo.
 *
 * `2026-09-01-020000_workspace_prompt_to_git` copied `settings.customPrompt`
 * into `PROMPT.md` and unset the field when a repo existed. Repo-less
 * workspaces kept the Mongo value as a fallback. Issue #956 removes that
 * fallback: git is the only store, a missing file is an empty prompt, and
 * the Mongoose schema no longer declares these fields.
 *
 * Idempotent `$unset` of whatever remains. Dashboards are untouched.
 */
import { Db } from "mongodb";

export const description =
  "Unset leftover workspace settings.customPrompt and selfDirective (git is the store)";

export async function up(db: Db): Promise<void> {
  await db.collection("workspaces").updateMany(
    {
      $or: [
        { "settings.customPrompt": { $exists: true } },
        { selfDirective: { $exists: true } },
      ],
    },
    { $unset: { "settings.customPrompt": "", selfDirective: "" } },
  );
}
