import { Types } from "mongoose";
import { Flow, ScheduledQueryRun } from "../database/workspace-schema";
import { inngest } from "../inngest/client";
import type { FlowRunTerminalEventData } from "./flow-run-notification.types";

export async function emitScheduledQueryTerminalEvent(params: {
    workspaceId: string;
    consoleId: string;
    runId: string;
    triggerType: "schedule" | "manual";
  },
): Promise<void> {
  const run = await ScheduledQueryRun.findById(params.runId).lean();
  if (!run?.completedAt || run.status === "queued" || run.status === "running") {
    return;
  }
  const success = run.status === "success";
  const data: FlowRunTerminalEventData = {
    workspaceId: params.workspaceId,
    resourceType: "scheduled_query",
    resourceId: params.consoleId,
    runId: params.runId,
    status: run.status,
    success,
    triggerType: params.triggerType,
    completedAt: run.completedAt.toISOString(),
    durationMs: run.durationMs,
    rowCount: run.rowCount,
    errorMessage: run.error?.message,
  };
  await inngest.send({ name: "flow.run.terminal", data });
}

export async function emitFlowExecutionTerminalEvent(params: {
    workspaceId: string;
    flowId: string;
    executionId: string;
    triggerType: "schedule" | "manual";
  },
): Promise<void> {
  const collection = Flow.db.collection("flow_executions");
  const execution = await collection.findOne({
    _id: new Types.ObjectId(params.executionId),
  });
  if (!execution?.completedAt) {
    return;
  }
  const status = execution.status as string;
  if (status === "cancelled" || status === "abandoned") {
    return;
  }
  const success = status === "completed" && execution.success === true;
  const failed = status === "failed";
  if (!success && !failed) {
    return;
  }
  const err = execution.error as { message?: string } | undefined;
  const data: FlowRunTerminalEventData = {
    workspaceId: params.workspaceId,
    resourceType: "flow",
    resourceId: params.flowId,
    runId: params.executionId,
    status,
    success,
    triggerType: params.triggerType,
    completedAt: new Date(execution.completedAt).toISOString(),
    durationMs:
      typeof execution.duration === "number" ? execution.duration : undefined,
    errorMessage: err?.message,
  };
  await inngest.send({ name: "flow.run.terminal", data });
}
