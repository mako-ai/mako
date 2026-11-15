/**
 * The success epilogue every flow run ends with, whichever source it read:
 * mark the flow succeeded, complete its `flow_executions` document, and emit
 * the terminal notification. Step ids are fixed — Inngest memoizes by them.
 */
import { Types } from "mongoose";
import { Flow } from "../../../database/workspace-schema";
import { emitFlowExecutionTerminalEvent } from "../../../services/flow-run-notification.emit";
import type { FlowRunContext } from "./run-context";

/** `lastSuccessAt` now, `lastError` cleared — after a last cancel check. */
export async function markFlowSucceeded(
  ctx: FlowRunContext,
  cancelScope: string,
): Promise<void> {
  const { step, logger, flowId } = ctx;
  await ctx.throwIfExecutionCancelled(cancelScope);
  await step.run("update-success-status", async () => {
    logger.info("Updating flow success status", { flowId });
    await Flow.findByIdAndUpdate(flowId, {
      lastSuccessAt: new Date(),
      lastError: null,
    });
  });
}

/**
 * Complete the execution document with `stats`, then stamp its duration.
 *
 * Reclaims executions falsely marked "abandoned" by the cleanup cron (stale
 * heartbeat while a step was still running) or "failed" by the error handler
 * on a previous retry attempt. A cancelled execution is left as it is.
 *
 * `strict` (connector runs): an execution that matched nothing and is not
 * cancelled fails the step, a write error is logged and rethrown, and a
 * missing execution id is warned about. Database-source runs have always
 * been lenient on all three.
 */
export async function completeExecutionStep(
  ctx: FlowRunContext,
  params: {
    stats: Record<string, unknown>;
    strict: boolean;
    /** Extra fields for the "Execution completed successfully" log line. */
    completedLog?: Record<string, unknown>;
  },
): Promise<void> {
  const { step, logger, flowId } = ctx;
  const { executionId } = ctx.state;
  const { stats, strict, completedLog } = params;

  const complete = async (id: string) => {
    const db = Flow.db;
    const collection = db.collection("flow_executions");
    const completedAt = new Date();

    const result = await collection.updateOne(
      {
        _id: new Types.ObjectId(id),
        status: { $in: ["running", "abandoned", "failed"] },
      },
      {
        $set: {
          completedAt,
          lastHeartbeat: completedAt,
          status: "completed",
          success: true,
          stats,
        },
      },
    );

    if (result.matchedCount === 0) {
      const current = await collection.findOne(
        { _id: new Types.ObjectId(id) },
        { projection: { status: 1 } },
      );
      if (current?.status === "cancelled") {
        logger.info(
          "Skipping completion update because execution is cancelled",
          { flowId, executionId: id },
        );
        return;
      }
      if (strict) throw new Error(`Failed to update execution: ${id}`);
    }

    // Calculate duration after update
    const execution = await collection.findOne({
      _id: new Types.ObjectId(id),
    });
    if (execution?.startedAt) {
      const duration =
        completedAt.getTime() - new Date(execution.startedAt).getTime();
      await collection.updateOne(
        { _id: new Types.ObjectId(id) },
        { $set: { duration } },
      );

      logger.info("Execution completed successfully", {
        flowId,
        executionId: id,
        duration,
        ...completedLog,
      });
    }
  };

  await step.run("complete-execution", async () => {
    logger.info("Completing execution logging", { flowId, executionId });
    if (!executionId) {
      if (strict) {
        logger.warn("No execution ID available to complete", { flowId });
      }
      return;
    }
    if (!strict) {
      await complete(executionId);
      return;
    }
    try {
      await complete(executionId);
    } catch (error) {
      logger.error("Failed to complete execution logging", {
        flowId,
        executionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error; // Re-throw to ensure the step fails
    }
  });
}

/** The run-finished notification fan-out, once per successful run. */
export async function emitSuccessNotification(
  ctx: FlowRunContext,
): Promise<void> {
  const { executionId, flowRef } = ctx.state;
  if (!executionId || !flowRef) return;
  const terminalWorkspaceId = String(flowRef.workspaceId);
  const terminalExecutionId = executionId;
  await ctx.step.run("emit-flow-terminal-notification", async () => {
    await emitFlowExecutionTerminalEvent({
      workspaceId: terminalWorkspaceId,
      flowId: ctx.flowId,
      executionId: terminalExecutionId,
      triggerType: ctx.runTriggerType,
    });
  });
}
