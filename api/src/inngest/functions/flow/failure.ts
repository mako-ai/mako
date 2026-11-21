/**
 * The failure path of a flow run: clean up a database full sync's staging
 * table, record the execution as failed (or cancelled), and — for a CDC
 * backfill — release the backfill gate so the scheduler and auto-recovery
 * are not blocked forever. Always rethrows: Inngest owns the retry.
 */
import { inWorkspace } from "../../../utils/workspace-scope";
import { readBoxedReadFailure } from "../../../connectors/workspace/boxed-read-failure";
import { Types } from "mongoose";
import {
  DatabaseConnection,
  Flow,
  type IFlow,
} from "../../../database/workspace-schema";
import { withHeartbeat } from "../../../services/flow-execution-tracking";
import { emitFlowExecutionTerminalEvent } from "../../../services/flow-run-notification.emit";
import { hasCdcDestinationAdapter } from "../../../sync-cdc/adapters/registry";
import { forceDrainCdcFlow } from "../../../sync-cdc/backfill";
import { syncMachineService } from "../../../sync-cdc/sync-state";
import { createDbSourceWriter } from "./database-source";
import type { FlowRunContext } from "./run-context";
import { isInfrastructureFailure } from "./infra-failure";

type FlowRunError = Error & { code?: unknown };

/** Inngest's cancellation, under any of the names and messages it uses. */
export function isCancellationError(
  error: FlowRunError,
  allowMessageMatch = true,
): boolean {
  return (
    error.name === "InngestFunctionCancelledError" ||
    error.name === "FunctionCancelledError" ||
    error.code === "FUNCTION_CANCELLED" ||
    (allowMessageMatch &&
      (Boolean(error.message?.includes("cancelled")) ||
        Boolean(error.message?.includes("canceled"))))
  );
}

export async function handleFlowRunFailure(
  ctx: FlowRunContext,
  // A thrown value: almost always an Error, read defensively.

  error: any,
): Promise<never> {
  const { step, logger, flowId, runTriggerType } = ctx;
  const { backfill } = ctx.data;
  const { executionId, flowRef } = ctx.state;

  void ctx.appendExecutionLog("error", "Flow execution failed", {
    flowId,
    error: error?.message || String(error),
    errorName: error?.name,
    errorCode: error?.code,
    stack: error?.stack,
  });

  logger.error("Flow failed", {
    flowId,
    error: error.message,
    errorName: error.name,
    errorCode: error.code,
    stack: error.stack,
  });

  // Boxed provider errors can describe a cancellation in their message.
  const readFailure = readBoxedReadFailure(error);
  const isCancelled = isCancellationError(error, !readFailure);

  logger.info("Error analysis", {
    flowId,
    errorName: error.name,
    errorCode: error.code,
    errorMessage: error.message,
    isCancelled,
  });

  // Cleanup staging tables on failure (for database source full sync)
  // Note: We intentionally do NOT check dbSyncStagingPrepared here.
  // The flag is only set after step.run returns successfully, but the
  // staging table is created inside step.run (in executeDbSyncChunk).
  // If the first chunk creates the staging table then fails permanently,
  // the flag would remain false and cleanup would be skipped — leaving
  // an orphaned staging table. The cleanup logic below handles the case
  // where no staging table exists (via try/catch), so it's safe to
  // always attempt cleanup for database full syncs.
  if (
    flowRef?.sourceType === "database" &&
    flowRef?.syncMode === "full" &&
    flowRef.databaseSource?.connectionId
  ) {
    const cleanupFlow = flowRef; // Capture for closure
    const cleanupDbSource = flowRef.databaseSource;
    await step.run("cleanup-staging-on-failure", () =>
      withHeartbeat(executionId, async () => {
        try {
          logger.info("Cleaning up staging table after failure", {
            flowId,
          });

          const sourceConnection = await DatabaseConnection.findOne(
            inWorkspace(cleanupDbSource.connectionId, cleanupFlow.workspaceId),
          );

          const destinationWriter = await createDbSourceWriter(
            cleanupFlow,
            cleanupDbSource,
            sourceConnection,
          );

          destinationWriter.markStagingActive();
          await destinationWriter.cleanup();
          logger.info("Staging table cleanup completed", { flowId });
        } catch (cleanupError) {
          logger.error("Failed to cleanup staging table", {
            flowId,
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
          });
        }
      }),
    );
  }

  // Complete execution logging in a step to ensure it runs
  await step.run("complete-execution-error", async () => {
    if (executionId) {
      try {
        const db = Flow.db;
        const collection = db.collection("flow_executions");
        const completedAt = new Date();

        // Calculate duration from the document's startedAt
        const execution = await collection.findOne({
          _id: new Types.ObjectId(executionId),
        });
        if (execution) {
          const duration =
            completedAt.getTime() - new Date(execution.startedAt).getTime();

          // Update the execution to failed or cancelled
          await collection.updateOne(
            { _id: new Types.ObjectId(executionId) },
            {
              $set: {
                completedAt,
                lastHeartbeat: completedAt,
                duration,
                status: isCancelled ? "cancelled" : "failed",
                success: false,
                error: {
                  message: isCancelled
                    ? "Flow execution cancelled by user"
                    : error.message,
                  stack: isCancelled ? undefined : error.stack,
                  code: isCancelled ? "USER_CANCELLED" : error.code,
                  ...(!isCancelled && readFailure ? { readFailure } : {}),
                },
              },
            },
          );
        }

        logger.info("Error execution logging completed", {
          flowId,
          executionId,
          status: isCancelled ? "cancelled" : "failed",
        });

        if (!isCancelled && flowRef && executionId) {
          const failureTerminalWorkspaceId = String(flowRef.workspaceId);
          const failureTerminalExecutionId = executionId;
          await emitFlowExecutionTerminalEvent({
            workspaceId: failureTerminalWorkspaceId,
            flowId,
            executionId: failureTerminalExecutionId,
            triggerType: runTriggerType,
          });
        }
      } catch (completeError) {
        logger.error("Failed to complete error execution logging", {
          flowId,
          executionId,
          originalError: error.message,
          completeError:
            completeError instanceof Error
              ? completeError.message
              : String(completeError),
        });
        // Don't re-throw here, we want the original error to propagate
      }
    }
  });

  // Update error status (unless cancelled)
  if (!isCancelled) {
    await Flow.findByIdAndUpdate(flowId, {
      lastError: error.message || "Unknown error",
    });
  }

  // Safety: ensure the CDC backfill gate is not left active after
  // failures. Mirrors the happy-path gating: any CDC backfill under the
  // unified model, webhook flows otherwise. Without this, a failed
  // backfill leaves backfillState.status stuck on "running", which blocks
  // the reconcile scheduler and the auto-recovery loop forever.
  if (backfill && flowRef) {
    await releaseCdcBackfillGate(ctx, flowRef, error, isCancelled);
  }

  throw error;
}

/** The counter a failed backfill bumps: platform failures do not count. */
export function backfillFailureUpdate(message: string | undefined) {
  if (isInfrastructureFailure(message)) {
    return {
      $inc: { "backfillState.infraFailures": 1 },
      $set: { "backfillState.lastInfraFailureAt": new Date() },
    };
  }
  return {
    $inc: { "backfillState.consecutiveFailures": 1 },
    $set: { "backfillState.infraFailures": 0 },
  };
}

async function releaseCdcBackfillGate(
  ctx: FlowRunContext,
  flowRef: IFlow,
  error: FlowRunError,
  isCancelled: boolean,
): Promise<void> {
  const { step, flowId } = ctx;
  const destinationType = flowRef.tableDestination?.connectionId
    ? (
        await DatabaseConnection.findOne(
          inWorkspace(
            flowRef.tableDestination.connectionId,
            flowRef.workspaceId,
          ),
        )
          .select({ type: 1 })
          .lean()
      )?.type
    : undefined;
  const isCdcEnabled =
    flowRef.syncEngine === "cdc" &&
    Boolean(flowRef.tableDestination?.connectionId) &&
    hasCdcDestinationAdapter(destinationType);
  if (!isCdcEnabled) return;

  const wasPausedByUser = await step.run("check-pause-vs-cancel", async () => {
    const freshFlow = await Flow.findById(flowId)
      .select("backfillState")
      .lean();
    return isCancelled && freshFlow?.backfillState?.status === "paused";
  });

  if (wasPausedByUser) {
    throw error;
  }

  await step.run("cdc-transition-fail", async () => {
    await syncMachineService.applyBackfillTransition({
      workspaceId: String(flowRef.workspaceId),
      flowId: String(flowId),
      event: {
        type: "FAIL",
        reason: "Backfill execution failed",
        errorCode: error?.code ? String(error.code) : "FLOW_EXECUTION_FAILED",
        errorMessage: error.message,
      },
    });
  });
  await step.run("mark-cdc-backfill-interrupted", async () => {
    // cdc-transition-fail already set status=error via the state
    // machine. Only bump a failure counter here: the platform's own
    // failures never use up a resume attempt (infra-failure.ts).
    await Flow.findByIdAndUpdate(flowId, backfillFailureUpdate(error.message));
  });
  await step.run("drain-cdc-on-failure", async () => {
    await forceDrainCdcFlow({
      workspaceId: String(flowRef.workspaceId),
      flowId: String(flowId),
    });
  });
}
