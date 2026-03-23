import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Split single syncState into independent streamState + backfillState.status";

const STATE_MAP: Record<
  string,
  { streamState: string; backfillStatus: string }
> = {
  idle: { streamState: "idle", backfillStatus: "idle" },
  backfill: { streamState: "idle", backfillStatus: "running" },
  catchup: { streamState: "active", backfillStatus: "completed" },
  live: { streamState: "active", backfillStatus: "completed" },
  paused: { streamState: "paused", backfillStatus: "paused" },
  degraded: { streamState: "error", backfillStatus: "error" },
};

export async function up(db: Db): Promise<void> {
  const flows = db.collection("flows");

  const cdcFlows = await flows
    .find({ syncEngine: "cdc" })
    .project({ _id: 1, syncState: 1 })
    .toArray();

  let updated = 0;
  for (const flow of cdcFlows) {
    const oldState = (flow.syncState as string) || "idle";
    const mapped = STATE_MAP[oldState] || STATE_MAP.idle;

    await flows.updateOne(
      { _id: flow._id },
      {
        $set: {
          streamState: mapped.streamState,
          "backfillState.status": mapped.backfillStatus,
        },
      },
    );
    updated++;
  }

  log.info("Migrated CDC flow states", {
    totalCdcFlows: cdcFlows.length,
    updated,
  });

  const nonCdc = await flows.updateMany(
    {
      $or: [{ syncEngine: { $ne: "cdc" } }, { syncEngine: { $exists: false } }],
    },
    {
      $set: {
        streamState: "idle",
        "backfillState.status": "idle",
      },
    },
  );

  log.info("Set defaults for non-CDC flows", {
    matched: nonCdc.matchedCount,
    modified: nonCdc.modifiedCount,
  });
}
