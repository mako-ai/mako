import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Backfill settings.enabledModelIds with current ALL_MODELS IDs for existing workspaces";

const DEFAULT_MODEL_IDS = [
  "openai/gpt-5.2-codex",
  "openai/gpt-5.2",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-opus-4-5",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-3-5-haiku-latest",
  "google/gemini-3-pro-preview",
  "google/gemini-2.5-pro",
  "google/gemini-2.5-flash",
  "google/gemma-4-26b-a4b-it",
];

export async function up(db: Db): Promise<void> {
  const workspaces = db.collection("workspaces");

  const result = await workspaces.updateMany(
    { "settings.enabledModelIds": { $exists: false } },
    { $set: { "settings.enabledModelIds": DEFAULT_MODEL_IDS } },
  );

  log.info("Backfilled enabledModelIds", {
    matched: result.matchedCount,
    modified: result.modifiedCount,
  });
}
