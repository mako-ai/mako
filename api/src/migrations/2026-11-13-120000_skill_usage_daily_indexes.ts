import { Db } from "mongodb";
import { loggers } from "../logging";

export const description =
  "Create the indexes of skill_usage_daily (skill loads per workspace, skill, source and UTC day): one row per key, a window scan by day, rows kept 400 days";

const log = loggers.migration();

const TTL_SECONDS = 400 * 24 * 60 * 60;

/**
 * Idempotent, and safe before or after the new code is live. The unique
 * index is what makes two parallel first loads of a skill on one day bump
 * one row (services/skill-usage.service.ts). Mongoose builds the same
 * indexes on start when autoIndex is on; this makes them exist where it is
 * off.
 */
export async function up(db: Db): Promise<void> {
  const usage = db.collection("skill_usage_daily");
  await usage.createIndex(
    { workspaceId: 1, scope: 1, skill: 1, source: 1, day: 1 },
    { unique: true },
  );
  await usage.createIndex({ workspaceId: 1, day: 1 });
  await usage.createIndex({ lastAt: 1 }, { expireAfterSeconds: TTL_SECONDS });

  log.info("Skill usage indexes are in place");
}
