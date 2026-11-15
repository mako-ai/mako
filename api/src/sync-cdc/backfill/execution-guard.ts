/**
 * Whether a backfill may start: abandon stale executions, wait out (or force)
 * a run that is still cancelling, and bulk-cancel orphaned Inngest runs.
 */
import { Types } from "mongoose";
import { Flow, FlowExecution } from "../../database/workspace-schema";
import { inngest } from "../../inngest/client";
import { loggers } from "../../logging";
import { EXECUTION_HEARTBEAT_STALE_MS } from "../../services/flow-execution-tracking";

const log = loggers.sync("cdc.backfill");

// Same threshold as cleanup-abandoned-flows (withHeartbeat keeps live runs
// well inside it).
const STALE_HEARTBEAT_MS = EXECUTION_HEARTBEAT_STALE_MS;

const CANCEL_WAIT_POLL_MS = 1000;
const CANCEL_WAIT_TIMEOUT_MS = 30_000;

const INNGEST_APP_ID = "mako-sync";
const INNGEST_FLOW_FUNCTION_ID = `${INNGEST_APP_ID}-flow`;
const INNGEST_ENTITY_FUNCTION_ID = `${INNGEST_APP_ID}-sync-backfill-entity`;

/**
 * Cancel all running Inngest function runs for a given flowId via the
 * bulk-cancellation REST API.  Cancels both the parent "flow" function and
 * child "sync-backfill-entity" functions so that restarted backfills don't
 * get blocked by orphaned children holding the concurrency slot.
 */
export async function cancelInngestFlowRuns(flowId: string): Promise<boolean> {
  const signingKey = process.env.INNGEST_SIGNING_KEY;
  if (!signingKey) {
    log.warn(
      "cancelInngestFlowRuns: INNGEST_SIGNING_KEY not set, skipping API cancel",
      { flowId },
    );
    return false;
  }

  const functionIds = [INNGEST_FLOW_FUNCTION_ID, INNGEST_ENTITY_FUNCTION_ID];
  const results = await Promise.allSettled(
    functionIds.map(async functionId => {
      const res = await fetch("https://api.inngest.com/v1/cancellations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${signingKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          app_id: INNGEST_APP_ID,
          function_id: functionId,
          started_after: new Date(
            Date.now() - 24 * 60 * 60 * 1000,
          ).toISOString(),
          started_before: new Date().toISOString(),
          if: `event.data.flowId == '${flowId}'`,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log.error("Inngest bulk cancel API returned non-OK", {
          flowId,
          functionId,
          status: res.status,
          body: body.slice(0, 500),
        });
        return false;
      }

      const data = (await res.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      log.info("Inngest bulk cancel API succeeded", {
        flowId,
        functionId,
        cancellationId: data?.id,
      });
      return true;
    }),
  );

  const allOk = results.every(
    r => r.status === "fulfilled" && r.value === true,
  );
  if (!allOk) {
    log.warn("Some Inngest bulk cancel calls failed", {
      flowId,
      results: results.map((r, i) => ({
        functionId: functionIds[i],
        status: r.status,
        value: r.status === "fulfilled" ? r.value : undefined,
        reason:
          r.status === "rejected"
            ? r.reason instanceof Error
              ? r.reason.message
              : String(r.reason)
            : undefined,
      })),
    });
  }
  return allOk;
}

export async function assertCanStartBackfill(
  workspaceId: string,
  flowId: string,
): Promise<void> {
  const abandonedCount = await abandonStaleExecutions(workspaceId, flowId);
  if (abandonedCount > 0) {
    log.warn("Abandoned stale executions before starting backfill", {
      flowId,
      workspaceId,
      abandonedCount,
    });
  }

  const workspaceObjectId = new Types.ObjectId(workspaceId);
  const flowObjectId = new Types.ObjectId(flowId);

  const running = await FlowExecution.findOne({
    workspaceId: workspaceObjectId,
    flowId: flowObjectId,
    status: "running",
  })
    .sort({ startedAt: -1 })
    .lean();

  if (!running) return;

  const executionAge = running.startedAt
    ? Date.now() - new Date(running.startedAt).getTime()
    : undefined;
  const heartbeatAge = running.lastHeartbeat
    ? Date.now() - new Date(running.lastHeartbeat).getTime()
    : undefined;

  // If the backfill was paused (or cancelled), an Inngest cancel is already
  // in-flight.  Wait for the worker to finish rather than rejecting — the
  // user expects reset-entity / resume to work immediately after pause.
  const flow = await Flow.findById(flowId)
    .select("backfillState.status")
    .lean();
  const isPendingCancel =
    flow?.backfillState?.status === "paused" ||
    flow?.backfillState?.status === "error" ||
    flow?.backfillState?.status === "completed" ||
    flow?.backfillState?.status === "idle";

  if (!isPendingCancel) {
    log.error("Cannot start backfill — execution still running", {
      flowId,
      executionId: running._id?.toString(),
      backfillStatus: flow?.backfillState?.status,
      executionStartedAt: running.startedAt,
      executionAgeMs: executionAge,
      lastHeartbeat: running.lastHeartbeat,
      heartbeatAgeMs: heartbeatAge,
    });
    throw new Error(
      `Cannot start backfill while an execution is still running (execution ${running._id?.toString()}, started ${executionAge ? Math.round(executionAge / 1000) + "s ago" : "unknown"}, last heartbeat ${heartbeatAge ? Math.round(heartbeatAge / 1000) + "s ago" : "never"})`,
    );
  }

  // Send cancel via event (for functions that are actively running steps)
  // AND via REST API (to release the concurrency lock on ghost functions)
  log.info("Waiting for previous execution to finish before starting", {
    flowId,
    executionId: running._id?.toString(),
    backfillStatus: flow?.backfillState?.status,
    executionAgeMs: executionAge,
    heartbeatAgeMs: heartbeatAge,
  });

  await Promise.all([
    inngest.send({
      name: "flow.cancel",
      data: {
        flowId,
        executionId: running._id?.toString(),
      },
    }),
    cancelInngestFlowRuns(flowId),
  ]);

  const deadline = Date.now() + CANCEL_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, CANCEL_WAIT_POLL_MS));
    const still = await FlowExecution.exists({
      _id: running._id,
      status: "running",
    });
    if (!still) {
      log.info("Previous execution finished after cancel signal", {
        flowId,
        executionId: running._id?.toString(),
        waitedMs: CANCEL_WAIT_TIMEOUT_MS - (deadline - Date.now()),
      });
      return;
    }
  }

  log.error("Cancel wait timed out — force-abandoning stuck execution", {
    flowId,
    executionId: running._id?.toString(),
    executionStartedAt: running.startedAt,
    executionAgeMs: executionAge,
    heartbeatAgeMs: heartbeatAge,
    cancelWaitTimeoutMs: CANCEL_WAIT_TIMEOUT_MS,
  });

  // Write the error into the execution so it's visible in the UI
  await FlowExecution.updateOne(
    { _id: running._id, status: "running" },
    {
      $push: {
        logs: {
          $each: [
            {
              timestamp: new Date(),
              level: "error",
              message: `Backfill execution stuck — no heartbeat for ${heartbeatAge ? Math.round(heartbeatAge / 1000) + "s" : "unknown"}. Force-abandoning to allow restart.`,
              metadata: { flowId, executionId: running._id?.toString() },
            },
          ],
          $slice: -200,
        },
      },
    },
  );

  await abandonStaleExecutions(workspaceId, flowId, { force: true });
}

export async function abandonStaleExecutions(
  workspaceId: string,
  flowId: string,
  options?: { force?: boolean },
): Promise<number> {
  const filter: Record<string, unknown> = {
    workspaceId: new Types.ObjectId(workspaceId),
    flowId: new Types.ObjectId(flowId),
    status: "running",
  };

  if (!options?.force) {
    const cutoff = new Date(Date.now() - STALE_HEARTBEAT_MS);
    filter.$or = [
      { lastHeartbeat: { $lt: cutoff } },
      { lastHeartbeat: { $exists: false }, startedAt: { $lt: cutoff } },
    ];
  }

  const result = await FlowExecution.updateMany(filter, {
    $set: {
      status: "abandoned",
      completedAt: new Date(),
      error: {
        message: options?.force
          ? "Execution abandoned on server startup — previous process no longer running"
          : "Execution abandoned during recovery — no heartbeat for 10+ minutes",
        code: "RECOVERY_ABANDON",
      },
    },
  });

  if (result.modifiedCount > 0) {
    log.warn("Abandoned stale executions during recovery", {
      flowId,
      workspaceId,
      abandonedCount: result.modifiedCount,
      force: options?.force ?? false,
    });
  }

  return result.modifiedCount;
}
