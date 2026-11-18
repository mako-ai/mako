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
      .select({
        lastPollRunStartedAt: 1,
        lastBackfillRunStartedAt: 1,
        mode: 1,
        backfillCursor: 1,
      })
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
  const hasStamp = Boolean(
    entityState?.lastPollRunStartedAt || entityState?.lastBackfillRunStartedAt,
  );
  // A past run is a safe anchor only while the entity's rows still come
  // from it. A reset or resync deletes the entity state (and the reset drops
  // the table); a backfill that started and has not completed leaves its
  // cursor and backfill mode. In each case a run from before reaches back
  // past rows the destination no longer holds, or never got: fall back to
  // the destination instead.
  const runAnchorSafe =
    !!entityState &&
    entityState.mode !== "backfill" &&
    entityState.backfillCursor == null;
  const lastSuccessfulRunStartedAt =
    hasStamp || !runAnchorSafe
      ? null
      : await lastSuccessfulRunStart({
          flowId: params.flowId,
          entity: params.entity,
          before: runStartedAt,
          excludeExecutionId: params.executionId,
        });
  const decision = decidePollSince({
    lastPollRunStartedAt: entityState?.lastPollRunStartedAt,
    lastBackfillRunStartedAt: entityState?.lastBackfillRunStartedAt,
    lastSuccessfulRunStartedAt,
    runStartedAt,
    overlapMs,
  });
  const overlapMin = Math.round(overlapMs / 60_000);
  return {
    ...(decision ? { since: decision.since.toISOString() } : {}),
    ...(runStartedAt ? { runStartedAt: runStartedAt.toISOString() } : {}),
    overlapMs,
    reason: decision
      ? `records updated since ${decision.since.toISOString()} (${
          decision.anchorKind === "run"
            ? "no poll stamp yet; last successful run of this entity"
            : `last completed ${decision.anchorKind} run`
        } started ${decision.anchor.toISOString()}, overlap ${overlapMin} min)`
      : "no completed poll, backfill or successful run on record; anchoring on the destination",
  };
}

/**
 * The start of the flow's last successful run that synced `entity`, before
 * `before`. Polls, backfills and resyncs write flow_executions; webhooks
 * never do, so this cannot run ahead of a change a webhook missed.
 */
async function lastSuccessfulRunStart(params: {
  flowId: string;
  entity: string;
  before: Date | null;
  excludeExecutionId?: string;
}): Promise<Date | null> {
  if (!Types.ObjectId.isValid(params.flowId)) return null;
  const filter: Record<string, unknown> = {
    flowId: new Types.ObjectId(params.flowId),
    status: "completed",
    success: true,
    "stats.syncedEntities": params.entity,
    ...(params.before ? { startedAt: { $lt: params.before } } : {}),
    ...(params.excludeExecutionId &&
    Types.ObjectId.isValid(params.excludeExecutionId)
      ? { _id: { $ne: new Types.ObjectId(params.excludeExecutionId) } }
      : {}),
  };
  const run = await Flow.db.collection("flow_executions").findOne(filter, {
    sort: { startedAt: -1 },
    projection: { startedAt: 1 },
  });
  return toDate((run as { startedAt?: Date } | null)?.startedAt);
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
