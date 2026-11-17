/**
 * Mongo side of the poll cursor (see poll-cursor.ts): load an entity's
 * stamps and this run's start, and stamp a completed poll.
 */
import { Types } from "mongoose";
import { CdcEntityState, Flow } from "../database/workspace-schema";
import { decidePollSince, pollOverlapMsFromEnv, toDate } from "./poll-cursor";

/** Serializable (Inngest step output) poll cursor for one entity and run. */
export interface ResolvedPollCursor {
  /** ISO since from a poll/backfill stamp; absent → destination fallback. */
  since?: string;
  /** This run's start, stamped on completion. Absent → no stamp. */
  runStartedAt?: string;
  overlapMs: number;
  reason: string;
}

/**
 * Loads the entity's stamps and this run's start (the flow execution's
 * `startedAt`, stable across continuation invocations).
 */
export async function resolvePollCursorForEntity(params: {
  flowId: string;
  entity: string;
  executionId?: string;
  overlapMs?: number;
}): Promise<ResolvedPollCursor> {
  const overlapMs = params.overlapMs ?? pollOverlapMsFromEnv();
  const [entityState, execution] = await Promise.all([
    CdcEntityState.findOne({
      flowId: new Types.ObjectId(params.flowId),
      entity: params.entity,
    })
      .select({ lastPollRunStartedAt: 1, lastBackfillRunStartedAt: 1 })
      .lean(),
    params.executionId && Types.ObjectId.isValid(params.executionId)
      ? Flow.db
          .collection("flow_executions")
          .findOne(
            { _id: new Types.ObjectId(params.executionId) },
            { projection: { startedAt: 1 } },
          )
      : Promise.resolve(null),
  ]);
  const runStartedAt = toDate(
    (execution as { startedAt?: Date } | null)?.startedAt,
  );
  const decision = decidePollSince({
    lastPollRunStartedAt: entityState?.lastPollRunStartedAt,
    lastBackfillRunStartedAt: entityState?.lastBackfillRunStartedAt,
    runStartedAt,
    overlapMs,
  });
  const overlapMin = Math.round(overlapMs / 60_000);
  return {
    ...(decision ? { since: decision.since.toISOString() } : {}),
    ...(runStartedAt ? { runStartedAt: runStartedAt.toISOString() } : {}),
    overlapMs,
    reason: decision
      ? `records updated since ${decision.since.toISOString()} (last completed ${decision.anchorKind} run started ${decision.anchor.toISOString()}, overlap ${overlapMin} min)`
      : "no completed poll or backfill on record; anchoring on the destination",
  };
}

/** Stamp this poll's run start once the entity completed. Never moves back. */
export async function stampPollRunStartedAt(params: {
  workspaceId: string;
  flowId: string;
  entity: string;
  runStartedAt: string | Date;
}): Promise<void> {
  const startedAt = toDate(params.runStartedAt);
  if (!startedAt) return;
  await CdcEntityState.updateOne(
    { flowId: new Types.ObjectId(params.flowId), entity: params.entity },
    {
      $setOnInsert: { workspaceId: new Types.ObjectId(params.workspaceId) },
      $max: { lastPollRunStartedAt: startedAt },
    },
    { upsert: true },
  );
}
