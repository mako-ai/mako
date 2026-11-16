/**
 * Every minute: kill connector boxes whose lease expired or stopped beating,
 * pause idle ones, enforce the paused-box TTLs, retire old boxes and delete
 * unused snapshot templates (connectors/workspace/boxes/scheduler.ts).
 *
 * It runs whether or not leases are on: with the flag off and no box records
 * it is one empty query, and with the flag just turned off it still drains
 * the boxes leases left behind.
 */
import { inngest } from "../client";
import { getBoxScheduler } from "../../connectors/workspace/boxes/scheduler";

export const connectorBoxReaperFunction = inngest.createFunction(
  {
    id: "connector-box-reaper",
    name: "Connectors: reap leased connector boxes",
    concurrency: { limit: 1 },
    retries: 0,
    triggers: { cron: "* * * * *" },
  },
  async ({ step }) => step.run("reap", async () => getBoxScheduler().reap()),
);
