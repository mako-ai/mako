import { inngest } from "../../client";
import { Flow } from "../../../database/workspace-schema";
import { Types } from "mongoose";
import { syncMachineService } from "../../../sync-cdc/sync-state";
import { cdcBackfillService } from "../../../sync-cdc/backfill";
import { EXECUTION_HEARTBEAT_STALE_MS } from "../../../services/flow-execution-tracking";
import { infraResumeDue } from "./infra-failure";

// Cleanup function for abandoned flows
export const cleanupAbandonedFlowsFunction = inngest.createFunction(
  {
    id: "cleanup-abandoned-flows",
    name: "Cleanup Abandoned Flows",
    // One sweep at a time: overlapping sweeps would race on the same rows.
    concurrency: { limit: 1 },
    retries: 2,
    triggers: { cron: "*/5 * * * *" },
  },
  async ({ step, logger }) => {
    const result = await step.run("cleanup-abandoned-flows", async () => {
      const db = Flow.db;
      const now = new Date();
      const heartbeatTimeout = new Date(
        now.getTime() - EXECUTION_HEARTBEAT_STALE_MS,
      );

      const executionsCollection = db.collection("flow_executions");
      const locksCollection = db.collection("flow_execution_locks");

      const MAX_CONSECUTIVE_FAILURES = 10;
      let abandonedCount = 0;
      let staleLockCount = 0;

      // 1. Find and mark abandoned flow executions. The staleness predicate
      //    is repeated in the updateMany filter: a heartbeat or completion
      //    that lands between the find and the update must win, not be
      //    overwritten with "abandoned".
      const staleRunningFilter = {
        status: "running",
        $or: [
          { lastHeartbeat: { $lt: heartbeatTimeout } },
          {
            lastHeartbeat: { $exists: false },
            startedAt: { $lt: heartbeatTimeout },
          },
        ],
      };
      const candidates = await executionsCollection
        .find(staleRunningFilter, { projection: { _id: 1 } })
        .toArray();

      if (candidates.length > 0) {
        const candidateIds = candidates.map(e => e._id);
        await executionsCollection.updateMany(
          { _id: { $in: candidateIds }, ...staleRunningFilter },
          {
            $set: {
              status: "abandoned",
              completedAt: now,
              error: {
                message:
                  "Flow execution abandoned due to worker crash or timeout",
                code: "WORKER_TIMEOUT",
              },
            },
          },
        );
        // Only the executions this update actually marked (same completedAt).
        const abandonedExecutions = await executionsCollection
          .find(
            {
              _id: { $in: candidateIds },
              status: "abandoned",
              completedAt: now,
            },
            { projection: { _id: 1, flowId: 1 } },
          )
          .toArray();
        abandonedCount = abandonedExecutions.length;

        if (abandonedCount > 0) {
          logger.warn("Marked abandoned flow executions", {
            count: abandonedCount,
            executionIds: abandonedExecutions.map(e => e._id.toString()),
          });
        }

        // Clear stale backfill gates and recover CDC state for flows
        // that no longer have any running execution.
        const abandonedFlowIds = Array.from(
          new Map(
            abandonedExecutions
              .filter(e => e.flowId != null)
              .map(e => {
                const id =
                  e.flowId instanceof Types.ObjectId
                    ? e.flowId
                    : new Types.ObjectId(String(e.flowId));
                return [id.toString(), id] as const;
              }),
          ).values(),
        );

        if (abandonedFlowIds.length > 0) {
          const stillRunningFlowIds = (await executionsCollection.distinct(
            "flowId",
            {
              flowId: { $in: abandonedFlowIds },
              status: "running",
            },
          )) as Types.ObjectId[];

          const runningSet = new Set(
            stillRunningFlowIds.map(id => id.toString()),
          );
          const staleGateFlowIds = abandonedFlowIds.filter(
            id => !runningSet.has(id.toString()),
          );

          if (staleGateFlowIds.length > 0) {
            const gatedFlows = await Flow.find(
              {
                _id: { $in: staleGateFlowIds },
                "backfillState.status": "running",
              },
              { _id: 1, workspaceId: 1, syncEngine: 1 },
            ).lean();

            // Through the state machine (running -FAIL-> error, CAS): a
            // backfill the user paused, or that completed, since the read
            // above is left alone.
            const resetFlowIds: string[] = [];
            for (const gated of gatedFlows) {
              const fId = String(gated._id);
              try {
                if (gated.syncEngine === "cdc") {
                  const transition =
                    await syncMachineService.applyBackfillTransition({
                      workspaceId: String(gated.workspaceId),
                      flowId: fId,
                      event: {
                        type: "FAIL",
                        reason:
                          "Flow execution abandoned due to worker crash or timeout",
                        errorCode: "WORKER_TIMEOUT",
                      },
                      onlyFrom: ["running"],
                    });
                  if (transition.changed) resetFlowIds.push(fId);
                } else {
                  // Not a state-machine flow: same CAS, by hand.
                  const res = await Flow.updateOne(
                    {
                      _id: gated._id,
                      workspaceId: gated.workspaceId,
                      "backfillState.status": "running",
                    },
                    { $set: { "backfillState.status": "error" } },
                  );
                  if (res.modifiedCount > 0) resetFlowIds.push(fId);
                }
              } catch (gateErr) {
                logger.error("Failed to reset stale backfill gate", {
                  flowId: fId,
                  error:
                    gateErr instanceof Error
                      ? gateErr.message
                      : String(gateErr),
                });
              }
            }

            logger.warn("Reset stale backfill gates", {
              matched: gatedFlows.length,
              modified: resetFlowIds.length,
              flowIds: resetFlowIds,
            });
            // CDC restart is handled by the unified recovery loop below
            // (Section 3) which picks up flows in "error" state with runId.
          }
        }
      }

      // 2. Clean up stale flow locks
      const heartbeatStaleThreshold = new Date(
        now.getTime() - EXECUTION_HEARTBEAT_STALE_MS,
      );
      const staleLocks = await locksCollection
        .find({
          $or: [
            { expiresAt: { $lt: now } },
            { lastHeartbeat: { $lt: heartbeatStaleThreshold } },
            {
              lastHeartbeat: { $exists: false },
              startedAt: { $lt: heartbeatStaleThreshold },
            },
          ],
        })
        .toArray();

      if (staleLocks.length > 0) {
        await locksCollection.deleteMany({
          _id: { $in: staleLocks.map(lock => lock._id) },
        });
        staleLockCount = staleLocks.length;

        logger.info("Cleaned up stale flow locks", {
          count: staleLockCount,
          lockIds: staleLocks.map(l => l._id.toString()),
        });
      }

      // 3. Recover interrupted CDC backfills left in "error" state by
      //    startup recovery (server restart). These have a runId (checkpoint)
      //    and low consecutiveFailures since startup resets the counter.
      let cdcRecoveredCount = 0;
      const interruptedCdcFlows = await Flow.find({
        syncEngine: "cdc",
        "backfillState.status": "error",
        "backfillState.runId": { $exists: true, $ne: null },
        $or: [
          { "backfillState.consecutiveFailures": { $exists: false } },
          {
            "backfillState.consecutiveFailures": {
              $lt: MAX_CONSECUTIVE_FAILURES,
            },
          },
        ],
      }).lean();

      for (const cdcFlow of interruptedCdcFlows) {
        const wId = String(cdcFlow.workspaceId);
        const fId = String(cdcFlow._id);
        const failures = cdcFlow.backfillState?.consecutiveFailures ?? 0;

        const hasRunningExec = await executionsCollection.findOne({
          flowId: cdcFlow._id,
          status: "running",
        });
        if (hasRunningExec) continue;
        // A platform failure does not use up an attempt; it waits 1, 2,
        // 4 … 30 min before the next resume instead (infra-failure.ts).
        if (!infraResumeDue(cdcFlow.backfillState, now)) continue;

        try {
          const restartResult = await cdcBackfillService.startBackfill(
            wId,
            fId,
            {
              reuseExistingRunId: true,
              reason: `Auto-resumed interrupted backfill (attempt ${failures + 1}/${MAX_CONSECUTIVE_FAILURES}${
                cdcFlow.backfillState?.infraFailures
                  ? `; ${cdcFlow.backfillState.infraFailures} platform failures not counted`
                  : ""
              })`,
            },
          );
          logger.info("Auto-restarted interrupted CDC backfill", {
            flowId: fId,
            consecutiveFailures: failures,
            runId: restartResult.runId,
            reusedRunId: restartResult.reusedRunId,
          });
          cdcRecoveredCount++;
        } catch (cdcErr) {
          logger.error("Failed to restart interrupted CDC backfill", {
            flowId: fId,
            error: cdcErr instanceof Error ? cdcErr.message : String(cdcErr),
          });
        }
      }

      logger.info("Cleanup abandoned flows completed", {
        abandonedExecutions: abandonedCount,
        staleLocks: staleLockCount,
        cdcRecovered: cdcRecoveredCount,
        timestamp: now.toISOString(),
      });

      return {
        abandonedExecutions: abandonedCount,
        staleLocks: staleLockCount,
        cdcRecovered: cdcRecoveredCount,
        timestamp: now,
      };
    });

    return result;
  },
);
