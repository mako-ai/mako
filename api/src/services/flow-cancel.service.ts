/**
 * Cancel a sync's running work: the one step behind POST
 * /flows/:flowId/cancel and the MCP `flow_cancel` tool.
 *
 * Each running execution gets its own `flow.cancel` event. The Inngest
 * functions cancel on the flowId; `cancel-flow` marks the named execution
 * row `cancelled`. A CDC flow whose backfill is running or paused also gets
 * the backfill cancel (`cdcBackfillService.cancelBackfill`), so the state
 * machine goes back to idle instead of resuming the run.
 */
import { Types } from "mongoose";

import { FlowExecution, type IFlow } from "../database/workspace-schema";
import { inngest } from "../inngest";
import { cdcBackfillService } from "../sync-cdc/backfill";

export class FlowCancelError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
    this.name = "FlowCancelError";
  }
}

export interface CancelledExecution {
  executionId: string;
  startedAt: Date | null;
  eventId: string | null;
}

export interface FlowCancelResult {
  flowId: string;
  executions: CancelledExecution[];
  /** The CDC backfill run cancelled with them, when one was running or paused. */
  backfill: { runId: string | null; previousStatus: string } | null;
}

const ACTIVE_BACKFILL = new Set(["running", "paused"]);

type CancellableFlow = Pick<IFlow, "_id" | "syncEngine" | "backfillState">;

/**
 * Cancel `executionId`, or every running execution of the flow when it is
 * omitted. Throws FlowCancelError (404) when nothing runs.
 */
export async function cancelFlowRuns(
  workspaceId: string,
  flow: CancellableFlow,
  executionId?: string,
): Promise<FlowCancelResult> {
  const flowId = flow._id.toString();
  const scope = {
    flowId: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  };

  let executions: Array<{ _id: Types.ObjectId; startedAt?: Date }>;
  if (executionId) {
    if (!Types.ObjectId.isValid(executionId)) {
      throw new FlowCancelError(`"${executionId}" is not an execution id`, 400);
    }
    const one = await FlowExecution.findOne({
      ...scope,
      _id: new Types.ObjectId(executionId),
    })
      .select("status startedAt")
      .lean();
    if (!one) {
      throw new FlowCancelError(
        `Execution ${executionId} is not a run of this flow`,
        404,
      );
    }
    if (one.status !== "running") {
      throw new FlowCancelError(
        `Execution ${executionId} is ${one.status}, not running`,
        404,
      );
    }
    executions = [one];
  } else {
    executions = await FlowExecution.find({ ...scope, status: "running" })
      .sort({ startedAt: -1 })
      .select("startedAt")
      .lean();
  }

  // A backfill run is cancelled with the whole flow, never with one named
  // execution: the caller asked for that one only.
  const backfillStatus = flow.backfillState?.status;
  const cancelBackfill =
    !executionId &&
    flow.syncEngine === "cdc" &&
    !!backfillStatus &&
    ACTIVE_BACKFILL.has(backfillStatus);

  if (executions.length === 0 && !cancelBackfill) {
    throw new FlowCancelError("No running execution found", 404);
  }

  let backfill: FlowCancelResult["backfill"] = null;
  if (cancelBackfill) {
    await cdcBackfillService.cancelBackfill(workspaceId, flowId);
    backfill = {
      runId: flow.backfillState?.runId ?? null,
      previousStatus: backfillStatus as string,
    };
  }

  const cancelled: CancelledExecution[] = [];
  for (const execution of executions) {
    const sent = await inngest.send({
      name: "flow.cancel",
      data: { flowId, executionId: execution._id.toString() },
    });
    cancelled.push({
      executionId: execution._id.toString(),
      startedAt: execution.startedAt ?? null,
      eventId: sent.ids?.[0] ?? null,
    });
  }

  return { flowId, executions: cancelled, backfill };
}
