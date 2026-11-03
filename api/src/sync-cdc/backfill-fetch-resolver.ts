import { Types } from "mongoose";
import { CdcEntityState, Flow } from "../database/workspace-schema";
import { sourceConnectionManager } from "../sync/database-data-source-manager";
import {
  decideBackfillFetchMode,
  isIncrementalResyncConnector,
} from "./backfill-fetch-mode";

/**
 * Serializable (Inngest step output) form of a BackfillFetchDecision, plus
 * the run start time the entity's anchor is stamped with on completion.
 */
export type ResolvedBackfillFetch =
  | { mode: "full"; reason: string; runStartedAt?: string }
  | {
      mode: "incremental";
      since: string;
      reason: string;
      runStartedAt?: string;
    };

/**
 * Loads what `decideBackfillFetchMode` needs for one entity of the current
 * backfill run. Returns null for connectors that are not covered, which keeps
 * their historical fetch behaviour byte-for-byte.
 */
export async function resolveBackfillFetchForEntity(params: {
  flowId: string;
  dataSourceId: string;
  entity: string;
}): Promise<ResolvedBackfillFetch | null> {
  const source = await sourceConnectionManager.getSourceConnection(
    params.dataSourceId,
  );
  const connectorType: string | undefined = source?.type;
  if (!isIncrementalResyncConnector(connectorType)) return null;

  const flowObjectId = new Types.ObjectId(params.flowId);
  const [flow, entityState] = await Promise.all([
    Flow.findById(flowObjectId)
      .select({ backfillState: 1, writeMode: 1 })
      .lean(),
    CdcEntityState.findOne({ flowId: flowObjectId, entity: params.entity })
      .select({ lastBackfillRunStartedAt: 1, lastFullBackfillRunStartedAt: 1 })
      .lean(),
  ]);

  const runStartedAt = flow?.backfillState?.startedAt
    ? new Date(flow.backfillState.startedAt)
    : null;
  const decision = decideBackfillFetchMode({
    connectorType,
    entity: params.entity,
    trigger: flow?.backfillState?.trigger,
    writeMode: flow?.writeMode,
    runStartedAt,
    lastBackfillRunStartedAt: entityState?.lastBackfillRunStartedAt,
    lastFullBackfillRunStartedAt: entityState?.lastFullBackfillRunStartedAt,
  });

  const runStartedAtIso = runStartedAt ? runStartedAt.toISOString() : undefined;
  return decision.mode === "incremental"
    ? {
        mode: "incremental",
        since: decision.since.toISOString(),
        reason: decision.reason,
        runStartedAt: runStartedAtIso,
      }
    : { mode: "full", reason: decision.reason, runStartedAt: runStartedAtIso };
}
