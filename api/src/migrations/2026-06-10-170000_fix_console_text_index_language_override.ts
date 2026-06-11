import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Recreate console_text_search with language_override so console saves work " +
  "(the default override field 'language' collides with the console language " +
  "column: MongoDB rejects writes with \"language override unsupported: sql\")";

const TEXT_INDEX_NAME = "console_text_search";
const LANGUAGE_OVERRIDE = "_textSearchLanguage";

export async function up(db: Db): Promise<void> {
  const col = db.collection("savedconsoles");

  let indexes: Array<Record<string, unknown>> = [];
  try {
    indexes = (await col.indexes()) as Array<Record<string, unknown>>;
  } catch {
    // Collection does not exist yet (fresh install before first console).
    // Mongoose will create the index with the fixed schema options.
    log.info("savedconsoles collection not found, nothing to fix");
    return;
  }

  const textIndex = indexes.find(idx => idx.textIndexVersion !== undefined);

  if (!textIndex) {
    // No text index (e.g. production where the original creation failed on
    // existing docs). Create it correctly. Best-effort: keyword search is
    // optional, console saves must not depend on this succeeding.
    try {
      await col.createIndex(
        { name: "text", description: "text" },
        { name: TEXT_INDEX_NAME, language_override: LANGUAGE_OVERRIDE },
      );
      log.info("Created console text index with language_override");
    } catch (err) {
      log.warn(
        "Could not create console text index — keyword search unavailable",
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
    return;
  }

  if (textIndex.language_override === LANGUAGE_OVERRIDE) {
    log.info("Console text index already has language_override, skipping");
    return;
  }

  // Existing text index with the default override ('language'): every
  // console write on a collection with this index fails because console
  // documents carry language: "sql" | "javascript" | "mongodb". Drop and
  // recreate with a non-colliding override field.
  const indexName = String(textIndex.name);
  await col.dropIndex(indexName);
  log.info("Dropped console text index with bad language_override", {
    indexName,
  });
  await col.createIndex(
    { name: "text", description: "text" },
    { name: TEXT_INDEX_NAME, language_override: LANGUAGE_OVERRIDE },
  );
  log.info("Recreated console text index with language_override");
}
