import { Db } from "mongodb";
import { loggers } from "../logging";

export const description =
  "Create the indexes of workflow_recorded_writes and workflow_recorded_runs (a dry run's recorded connection writes): one row per run and place, one counter per run, both kept 7 days";

const log = loggers.migration();

const WEEK_SECONDS = 7 * 24 * 60 * 60;

/**
 * Idempotent, and safe before or after the new code is live. The unique
 * counter index is what caps a run at MAX_RECORDED_PER_RUN under parallel
 * steps (workflows/recorded-writes.ts `takePlace`); without it two first
 * writes could make two counters. Mongoose builds the same indexes on start
 * when autoIndex is on; this makes them exist where it is off.
 */
export async function up(db: Db): Promise<void> {
  const writes = db.collection("workflow_recorded_writes");
  await writes.createIndex(
    { workspaceId: 1, runId: 1, seq: 1 },
    { unique: true },
  );
  await writes.createIndex({ at: 1 }, { expireAfterSeconds: WEEK_SECONDS });

  const runs = db.collection("workflow_recorded_runs");
  await runs.createIndex({ workspaceId: 1, runId: 1 }, { unique: true });
  await runs.createIndex({ at: 1 }, { expireAfterSeconds: WEEK_SECONDS });

  log.info("Recorded-writes indexes are in place");
}
