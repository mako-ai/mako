/**
 * The fetch-due + optimistic-claim pair shared by every "scheduledRun.nextAt"
 * scheduler (scheduled queries, dbt jobs — previously copy-pasted per kind).
 *
 * These docs precompute their next occurrence in `scheduledRun.nextAt`; the
 * scan selects `nextAt <= now` (an indexed query — no cron parsing over the
 * whole collection) and claims a run by flipping `nextAt` with the OLD value
 * in the filter. The flip is what advances the schedule; that it is
 * compare-and-swap also makes the trigger exactly-once when scans overlap
 * (a slow scan running past the next tick, an Inngest retry of the scan
 * step, or a manual trigger racing the schedule). Note the cron function
 * itself already fires once per tick globally — Inngest invokes one
 * instance — so multi-instance dedup is NOT what this is for.
 *
 * Both helpers are called inside `step.run` by their Inngest functions; the
 * claim deliberately returns the raw update result (not a boolean) so the
 * memoized step shape stays what in-flight runs already recorded.
 */
import { Types, type Model } from "mongoose";

import { getNextScheduledConsoleRunAt } from "./scheduled-query-schedule.service";

export interface DueScheduledRunDoc {
  id: string;
  workspaceId: string;
  /** As stored (a Date here, an ISO string after step serialization). */
  nextAt: Date | string | null;
  schedule: { cron?: string | null; timezone?: string | null } | null;
}

export async function findDueScheduledRuns(
  // Docs only need the schedule/scheduledRun shape; models are invariant.
  model: Model<any>,
  now: Date,
  extraFilter: Record<string, unknown> = {},
): Promise<DueScheduledRunDoc[]> {
  const docs = (await model
    .find({
      "schedule.cron": { $exists: true, $ne: "" },
      "scheduledRun.nextAt": { $lte: now },
      ...extraFilter,
    })
    .select("_id workspaceId schedule scheduledRun")
    .lean()) as unknown as Array<{
    _id: Types.ObjectId;
    workspaceId: Types.ObjectId;
    schedule?: { cron?: string | null; timezone?: string | null } | null;
    scheduledRun?: { nextAt?: Date | null } | null;
  }>;

  return docs.map(doc => ({
    id: doc._id.toString(),
    workspaceId: doc.workspaceId.toString(),
    nextAt: doc.scheduledRun?.nextAt ?? null,
    schedule: doc.schedule ?? null,
  }));
}

/**
 * Flip `scheduledRun.nextAt` from the value this scan saw to the schedule's
 * next occurrence. `modifiedCount === 0` means another instance (or a later
 * scan) claimed it first — the caller must skip the trigger.
 */
export async function claimScheduledRun(
  model: Model<any>,
  doc: DueScheduledRunDoc,
  now: Date,
): Promise<{ modifiedCount: number }> {
  const nextAt = getNextScheduledConsoleRunAt(
    {
      cron: doc.schedule?.cron ?? "",
      timezone: doc.schedule?.timezone ?? "UTC",
    },
    now,
  );
  const result = await model.updateOne(
    {
      _id: new Types.ObjectId(doc.id),
      "scheduledRun.nextAt": doc.nextAt,
    },
    { $set: { "scheduledRun.nextAt": nextAt } },
  );
  return { modifiedCount: result.modifiedCount };
}
