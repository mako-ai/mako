import { Flow, FlowExecution } from "../../../database/workspace-schema";
import { isCronDue } from "../../../services/cron-due";
import { cdcBackfillService } from "../../../sync-cdc/backfill";
import { inngest } from "../../client";
import { scheduledBackfillGate } from "../../../sync-cdc/backfill/attempt";

// Scheduled CDC full backfill - triggers a periodic full reconciliation
// backfill for CDC flows that opted into `backfillSchedule`. The live stream
// stays active between runs; this just kicks `cdcBackfillService.startBackfill`
// on the configured cadence.
/** Backfills started per step in the CDC backfill scheduler. */
const CDC_BACKFILL_START_CHUNK = 10;

export const cdcScheduledBackfillFunction = inngest.createFunction(
  {
    id: "cdc-scheduled-backfill",
    name: "Run Scheduled CDC Backfills",
    concurrency: { limit: 1 },
    retries: 3,
    triggers: { cron: "*/5 * * * *" },
  },
  async ({ step, logger }) => {
    // Select, due-check and claim in one step (not one step per flow, and
    // no full flow documents as step output). The claim stamps
    // `backfillSchedule.lastRunAt` with compare-and-swap on the value read,
    // FIRST, so a slow/failed start doesn't re-trigger every cron tick
    // (the next attempt waits for the next cron occurrence).
    const { checked, claimed } = await step.run(
      "claim-due-backfills",
      async () => {
        const now = new Date();
        const found = await Flow.find({
          syncEngine: "cdc",
          "backfillSchedule.enabled": true,
          enabled: { $ne: false },
          ...scheduledBackfillGate,
        })
          .select("_id workspaceId backfillSchedule backfillState streamState")
          .lean();

        const due = found.filter(flow => {
          const schedule = flow.backfillSchedule;
          if (!schedule?.cron) return false;
          // Don't pile up: skip if a backfill is already in flight or the
          // stream is paused.
          if (flow.backfillState?.status === "running") return false;
          if (flow.streamState === "paused") return false;
          try {
            return isCronDue({
              cron: schedule.cron,
              timezone: schedule.timezone,
              lastRunAt: schedule.lastRunAt
                ? new Date(schedule.lastRunAt)
                : null,
              now,
            });
          } catch (error) {
            logger.error("Failed to evaluate CDC backfill schedule", {
              flowId: String(flow._id),
              cron: schedule.cron,
              error: error instanceof Error ? error.message : String(error),
            });
            return false;
          }
        });

        const running = new Set(
          due.length === 0
            ? []
            : (
                (await FlowExecution.collection.distinct("flowId", {
                  flowId: { $in: due.map(flow => flow._id) },
                  status: "running",
                })) as unknown[]
              ).map(id => String(id)),
        );

        const claims: Array<{
          flowId: string;
          workspaceId: string;
          entities?: string[];
        }> = [];
        for (const flow of due) {
          const flowId = String(flow._id);
          if (running.has(flowId)) continue;
          const res = await Flow.updateOne(
            {
              _id: flow._id,
              workspaceId: flow.workspaceId,
              ...scheduledBackfillGate,
              "backfillSchedule.lastRunAt":
                flow.backfillSchedule?.lastRunAt ?? null,
            },
            { $set: { "backfillSchedule.lastRunAt": now } },
          );
          if (res.modifiedCount === 0) continue;
          const entities = flow.backfillSchedule?.entities;
          claims.push({
            flowId,
            workspaceId: String(flow.workspaceId),
            ...(entities?.length ? { entities: [...entities] } : {}),
          });
        }
        return { checked: found.length, claimed: claims };
      },
    );

    const triggered: string[] = [];
    for (let i = 0; i < claimed.length; i += CDC_BACKFILL_START_CHUNK) {
      const chunk = claimed.slice(i, i + CDC_BACKFILL_START_CHUNK);
      const started = await step.run(
        `trigger-backfills-${i / CDC_BACKFILL_START_CHUNK}`,
        async () => {
          const ok: string[] = [];
          for (const claim of chunk) {
            try {
              // trigger "scheduled": entities whose source can filter on
              // update time fetch only what changed since their last
              // completed backfill (with an overlap), and fall back to a
              // full fetch at least weekly (see backfill-fetch-mode.ts).
              await cdcBackfillService.startBackfill(
                claim.workspaceId,
                claim.flowId,
                {
                  entities: claim.entities,
                  trigger: "scheduled",
                  reason: claim.entities
                    ? `Scheduled backfill (${claim.entities.join(", ")})`
                    : "Scheduled full backfill",
                },
              );
              ok.push(claim.flowId);
            } catch (error) {
              // Already claimed (lastRunAt stamped): the next attempt is the
              // next cron occurrence, as before.
              logger.error("Failed to start scheduled CDC backfill", {
                flowId: claim.flowId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          return ok;
        },
      );
      triggered.push(...started);
    }

    logger.info("Scheduled CDC backfill runner completed", {
      checked,
      triggered: triggered.length,
      flowIds: triggered,
    });

    return { checked, triggered: triggered.length };
  },
);
