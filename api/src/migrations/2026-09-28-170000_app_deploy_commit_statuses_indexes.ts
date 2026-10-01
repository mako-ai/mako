import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Indexes for app_deploy_commit_statuses (per-app, per-commit GitHub deploy status ledger)";

function hasIndexOnKeys(
  indexes: Array<{ key?: Record<string, unknown> }>,
  keyPattern: Record<string, number>,
): boolean {
  const target = JSON.stringify(keyPattern);
  return indexes.some(idx => JSON.stringify(idx.key ?? {}) === target);
}

async function ensureIndex(
  db: Db,
  keyPattern: Record<string, number>,
  options: { name: string; unique?: boolean },
): Promise<void> {
  const collection = db.collection("app_deploy_commit_statuses");
  const existing = await collection.indexes().catch(() => []);
  if (hasIndexOnKeys(existing, keyPattern)) {
    log.info(`Index ${options.name} already exists`);
    return;
  }
  try {
    await collection.createIndex(keyPattern, options);
    log.info(`Created index ${options.name}`);
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    const codeName = (err as { codeName?: string })?.codeName;
    if (code === 85 || codeName === "IndexOptionsConflict") {
      log.info(`Index ${options.name} exists under another name, skipping`);
      return;
    }
    throw err;
  }
}

export async function up(db: Db): Promise<void> {
  await ensureIndex(
    db,
    { workspaceId: 1, appId: 1, sha: 1 },
    { name: "app_deploy_commit_statuses_app_sha", unique: true },
  );
  await ensureIndex(
    db,
    { workspaceId: 1, appId: 1, state: 1 },
    { name: "app_deploy_commit_statuses_app_state" },
  );
}
