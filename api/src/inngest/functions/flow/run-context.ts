/**
 * What every phase of one `flow` run shares: the step tools, the run's
 * event-derived settings, and the state the phases hand each other (the
 * execution id once created, the fetched flow, the CDC backfill run id).
 */
import type { GetStepTools, Logger } from "inngest";
import { Types } from "mongoose";
import type { inngest } from "../../client";
import { Flow, type IFlow } from "../../../database/workspace-schema";
import { appendExecutionLog as appendFlowExecutionLog } from "../../../services/flow-execution-tracking";

export type FlowRunTriggerType = "manual" | "schedule";

export interface FlowRunEventData {
  flowId: string;
  noJitter?: boolean;
  backfill?: boolean;
  backfillRunId?: string;
  backfillEntities?: string[];
  triggerType?: FlowRunTriggerType;
}

export interface FlowRunState {
  executionId?: string;
  /** The flow as fetched, for the failure handler. */
  flowRef?: IFlow;
  cdcBackfillRunId?: string;
}

export interface FlowRunContext {
  step: GetStepTools<typeof inngest>;
  logger: Logger;
  flowId: string;
  data: FlowRunEventData;
  runTriggerType: FlowRunTriggerType;
  requestedBackfillEntities: string[];
  state: FlowRunState;
  /** Persist a log line on the execution document (live UI activity). */
  appendExecutionLog: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    metadata?: Record<string, unknown>,
  ) => ReturnType<typeof appendFlowExecutionLog>;
  /** Throw `USER_CANCELLED` when the execution was cancelled meanwhile. */
  throwIfExecutionCancelled: (
    scope: string,
    metadata?: Record<string, unknown>,
  ) => Promise<void>;
}

/** An explicit trigger type wins; otherwise `noJitter` marks a manual run. */
export function resolveRunTriggerType(
  data: Pick<FlowRunEventData, "triggerType" | "noJitter">,
): FlowRunTriggerType {
  if (data.triggerType === "manual") return "manual";
  if (data.triggerType === "schedule") return "schedule";
  return data.noJitter ? "manual" : "schedule";
}

/** The requested backfill subset: trimmed, non-empty, de-duplicated. */
export function normalizeBackfillEntities(entities: unknown): string[] {
  if (!Array.isArray(entities)) return [];
  return Array.from(
    new Set(
      entities
        .filter(
          (entity): entity is string =>
            typeof entity === "string" && entity.trim().length > 0,
        )
        .map(entity => entity.trim()),
    ),
  );
}

export function createFlowRunContext(params: {
  step: GetStepTools<typeof inngest>;
  logger: Logger;
  data: FlowRunEventData;
}): FlowRunContext {
  const { step, logger, data } = params;
  const { flowId } = data;
  const state: FlowRunState = {};

  return {
    step,
    logger,
    flowId,
    data,
    runTriggerType: resolveRunTriggerType(data),
    requestedBackfillEntities: normalizeBackfillEntities(data.backfillEntities),
    state,
    appendExecutionLog: (level, message, metadata) =>
      appendFlowExecutionLog({
        executionId: state.executionId,
        flowId: String(flowId),
        level,
        message,
        metadata,
      }),
    throwIfExecutionCancelled: async (scope, metadata) => {
      const { executionId } = state;
      if (!executionId) return;
      const db = Flow.db;
      const collection = db.collection("flow_executions");
      const execution = await collection.findOne(
        { _id: new Types.ObjectId(executionId) },
        { projection: { status: 1 } },
      );

      if (execution?.status === "cancelled") {
        logger.warn("Detected cancelled flow execution; stopping run", {
          flowId,
          executionId,
          scope,
          ...metadata,
        });
        const cancelError = new Error("Flow execution cancelled by user");
        (cancelError as Error & { code?: string }).code = "USER_CANCELLED";
        throw cancelError;
      }
    },
  };
}
