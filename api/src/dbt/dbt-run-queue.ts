/**
 * dbt run lanes and why a queued run is waiting.
 *
 * The executor (`dbtRunExecutorFunction`) runs one dbt invocation at a time
 * per project and lane. A project has two lanes: "default" and "fast". Short
 * scheduled jobs run in the fast lane (see `resolveJobLane`), so a 2-minute
 * staging job no longer waits behind a 40-minute nightly build. Every other
 * run uses the default lane. Two Inngest concurrency locks enforce it: one
 * keyed on `<projectId>:<lane>`, one keyed on `job:<jobId>` (a run without a
 * job holds `run:<runId>`, which locks nothing else). `claimDbtRunSlot`
 * checks the same two slots in Mongo before a run starts, so a lapse of the
 * Inngest locks never starts a second run.
 *
 * A run triggered while another run of its lane holds the slot sits in
 * "queued" with no other signal, so a caller polling it cannot tell "behind a
 * 40-minute nightly build" from "the worker never got the event".
 * `describeQueuedRun` answers that from the runs collection alone: the run
 * holding the lane's slot, the runs of the lane queued ahead of this one, and
 * a start estimate from the blocking job's recent durations.
 *
 * Inngest does not promise FIFO order inside a concurrency key, so the
 * position is an estimate. The blocking run is exact.
 */
import { Types } from "mongoose";
import {
  DbtJob,
  DbtRun,
  type DbtRunLane,
  type IDbtRun,
} from "../database/workspace-schema";

export type { DbtRunLane };

/** A job joins the fast lane when its median run is under this. */
export const FAST_LANE_MAX_MEDIAN_MS = 5 * 60_000;
/** Successful runs a job needs before it can join the fast lane. */
export const FAST_LANE_MIN_RUNS = 5;
/** Successful runs sampled for a job's median duration. */
export const FAST_LANE_SAMPLE = 20;
/** A job's cached lane is recomputed once it is older than this. */
export const FAST_LANE_TTL_MS = 24 * 60 * 60_000;

/**
 * The lane a job's history earns: "fast" when it has at least
 * FAST_LANE_MIN_RUNS successful runs and their median is under
 * FAST_LANE_MAX_MEDIAN_MS.
 */
export function laneForDurations(durations: number[]): {
  lane: DbtRunLane;
  medianMs?: number;
} {
  const medianMs = median(durations);
  const lane: DbtRunLane =
    durations.length >= FAST_LANE_MIN_RUNS &&
    medianMs !== undefined &&
    medianMs < FAST_LANE_MAX_MEDIAN_MS
      ? "fast"
      : "default";
  return medianMs !== undefined ? { lane, medianMs } : { lane };
}

/**
 * A job's lane, cached on the job doc (`lane`, `laneEvaluatedAt`,
 * `laneMedianMs`) and recomputed from its last FAST_LANE_SAMPLE successful
 * runs once the cache is older than FAST_LANE_TTL_MS.
 */
export async function resolveJobLane(
  jobId: Types.ObjectId | string,
  now: Date = new Date(),
): Promise<DbtRunLane> {
  const _id = typeof jobId === "string" ? new Types.ObjectId(jobId) : jobId;
  const job = await DbtJob.findById(_id).select("lane laneEvaluatedAt").lean();
  if (!job) return "default";
  if (
    job.lane &&
    job.laneEvaluatedAt &&
    now.getTime() - new Date(job.laneEvaluatedAt).getTime() < FAST_LANE_TTL_MS
  ) {
    return job.lane;
  }
  const recent = await DbtRun.find({
    jobId: _id,
    status: "success",
    durationMs: { $gt: 0 },
  })
    .sort({ createdAt: -1 })
    .limit(FAST_LANE_SAMPLE)
    .select("durationMs")
    .lean();
  const { lane, medianMs } = laneForDurations(
    recent
      .map(r => r.durationMs)
      .filter((d): d is number => typeof d === "number"),
  );
  await DbtJob.updateOne(
    { _id },
    medianMs !== undefined
      ? { $set: { lane, laneEvaluatedAt: now, laneMedianMs: medianMs } }
      : { $set: { lane, laneEvaluatedAt: now }, $unset: { laneMedianMs: "" } },
  );
  return lane;
}

/**
 * The lane a new run goes to. Only a scheduled run of a saved job can be
 * fast. Manual, agent, CI and pre-deploy runs (no job) use the default lane.
 */
export async function chooseRunLane(
  run: { trigger: IDbtRun["trigger"]; jobId?: string | Types.ObjectId | null },
  now: Date = new Date(),
): Promise<DbtRunLane> {
  if (run.trigger !== "schedule" || !run.jobId) return "default";
  return resolveJobLane(run.jobId, now);
}

/**
 * Mongo filter for the runs of one lane. Runs that predate lanes carry no
 * `lane` and ran in the single project queue, which is the default lane.
 */
export function dbtRunLaneFilter(
  lane: DbtRunLane | null | undefined,
): Record<string, unknown> {
  return lane === "fast" ? { lane: "fast" } : { lane: { $ne: "fast" } };
}

/** The two concurrency keys a "dbt/run.requested" event carries. */
export function dbtRunQueueKeys(run: {
  projectId: string;
  runId: string;
  jobId?: string | null;
  lane?: DbtRunLane | null;
}): { laneKey: string; jobKey: string } {
  return {
    laneKey: `${run.projectId}:${run.lane ?? "default"}`,
    jobKey: run.jobId ? `job:${run.jobId}` : `run:${run.runId}`,
  };
}

/**
 * Keys for a "dbt/run.requested" event that carries none: one sent by a
 * build that predates lanes and still queued when this build took over. It
 * goes to the default lane, where it queued before. Returns null when the
 * event already has both keys.
 */
export function dbtRunFallbackQueueKeys(event: {
  projectId: string;
  runId: string;
  jobId?: string | null;
  laneKey?: string | null;
  jobKey?: string | null;
}): { laneKey: string; jobKey: string } | null {
  if (event.laneKey && event.jobKey) return null;
  const derived = dbtRunQueueKeys({
    projectId: event.projectId,
    runId: event.runId,
    jobId: event.jobId,
    lane: "default",
  });
  return {
    laneKey: event.laneKey || derived.laneKey,
    jobKey: event.jobKey || derived.jobKey,
  };
}

/**
 * Mongo filter for the runs holding the slot `run` needs: a running run of
 * its project lane, or a running run of its own job in the other lane. These
 * are the two Inngest concurrency locks, read from the runs collection.
 */
export function dbtRunSlotHolderFilter(run: {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  jobId?: Types.ObjectId | null;
  lane?: DbtRunLane | null;
}): Record<string, unknown> {
  const laneFilter = dbtRunLaneFilter(run.lane);
  return {
    projectId: run.projectId,
    status: "running",
    _id: { $ne: run._id },
    ...(run.jobId ? { $or: [laneFilter, { jobId: run.jobId }] } : laneFilter),
  };
}

export type DbtRunSlotClaim =
  | { state: "claimed"; run: IDbtRun }
  | { state: "busy"; holderId: string }
  | { state: "gone" };

/**
 * Move a queued run to "running" only when no other run holds its slot.
 *
 * The Inngest locks alone let 8 runs of one project lane run together on
 * 19 Nov 2026: the deploy of #1424 changed the lock keys, and runs created
 * around the switch ran under no lock. This check reads the runs collection,
 * so it holds whatever Inngest does with its keys.
 *
 * Two runs can claim at the same moment. Each re-reads after its write and
 * steps back to "queued" when it sees another holder, so at most one keeps
 * the slot. Both may step back. The caller waits and tries again.
 */
export async function claimDbtRunSlot(
  runId: Types.ObjectId,
  now: Date = new Date(),
): Promise<DbtRunSlotClaim> {
  const queued = await DbtRun.findOne({ _id: runId, status: "queued" })
    .select("_id projectId jobId lane")
    .lean();
  if (!queued) return { state: "gone" };

  const holderOf = async () =>
    queued.projectId
      ? DbtRun.findOne(
          dbtRunSlotHolderFilter({ ...queued, projectId: queued.projectId }),
        )
          .select("_id")
          .lean()
      : null;

  const before = await holderOf();
  if (before) return { state: "busy", holderId: before._id.toString() };

  const claimed = await DbtRun.findOneAndUpdate(
    { _id: runId, status: "queued" },
    { $set: { status: "running", startedAt: now } },
    { returnDocument: "after" },
  ).lean();
  if (!claimed) return { state: "gone" };

  const after = await holderOf();
  if (after) {
    await DbtRun.updateOne(
      { _id: runId, status: "running" },
      { $set: { status: "queued" }, $unset: { startedAt: 1 } },
    );
    return { state: "busy", holderId: after._id.toString() };
  }
  return { state: "claimed", run: claimed as IDbtRun };
}

/** Runs listed in `queuedAhead`; the count stays exact past it. */
const MAX_LISTED_AHEAD = 5;
/** Completed runs of the blocking job sampled for its typical duration. */
const DURATION_SAMPLE = 5;

export interface QueuedRunRef {
  runId: string;
  jobId?: string;
  jobName?: string;
  trigger?: string;
  commands?: string[];
  createdAt?: Date;
}

export interface DbtRunQueueInfo {
  /**
   * Runs ahead of this one: the run holding the slot plus earlier queued
   * runs. 1 = next to start once the slot frees.
   */
  runsAhead: number;
  /** The lane this run waits in ("default" or "fast"). */
  lane: DbtRunLane;
  /** The run holding this lane's single execution slot, if any. */
  blockedBy:
    (QueuedRunRef & { startedAt?: Date; runningForMs?: number }) | null;
  /** Other queued runs of this project and lane created before this one. */
  queuedAheadCount: number;
  queuedAhead: QueuedRunRef[];
  /**
   * Median duration of the blocking job's recent successful runs, when it is
   * a saved job with history. Used for `estimatedStartAt`.
   */
  blockingTypicalDurationMs?: number;
  /** When the blocking run should finish, from its typical duration. */
  estimatedStartAt?: Date;
  /** One sentence for a human or an agent. */
  reason: string;
}

type QueueRun = {
  _id: Types.ObjectId;
  projectId?: Types.ObjectId;
  jobId?: Types.ObjectId;
  trigger?: string;
  commands?: string[];
  status: string;
  /** Absent on runs that predate lanes: the default lane. */
  lane?: DbtRunLane | null;
  createdAt?: Date;
  startedAt?: Date;
};

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function formatMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? "under a minute" : `${minutes} min`;
}

/**
 * Explain a queued run. Returns null for any run that is not queued.
 */
export async function describeQueuedRun(
  run: QueueRun,
  now: Date = new Date(),
): Promise<DbtRunQueueInfo | null> {
  if (run.status !== "queued" || !run.projectId) return null;

  const lane: DbtRunLane = run.lane === "fast" ? "fast" : "default";
  const laneFilter = dbtRunLaneFilter(lane);
  const [running, ahead] = await Promise.all([
    // The run holding this lane's slot. A job run also waits on a run of the
    // same job in the other lane (the per-job lock).
    DbtRun.findOne(dbtRunSlotHolderFilter({ ...run, projectId: run.projectId }))
      .sort({ startedAt: 1 })
      .select("_id jobId trigger commands createdAt startedAt")
      .lean(),
    DbtRun.find({
      projectId: run.projectId,
      status: "queued",
      _id: { $ne: run._id },
      ...laneFilter,
      ...(run.createdAt ? { createdAt: { $lt: run.createdAt } } : {}),
    })
      .sort({ createdAt: 1 })
      .select("_id jobId trigger commands createdAt")
      .lean(),
  ]);

  const jobIds = [
    ...new Set(
      [running?.jobId, ...ahead.map(r => r.jobId)]
        .filter((id): id is Types.ObjectId => !!id)
        .map(id => id.toString()),
    ),
  ];
  const jobs = jobIds.length
    ? await DbtJob.find({
        _id: { $in: jobIds.map(id => new Types.ObjectId(id)) },
      })
        .select("_id name")
        .lean()
    : [];
  const jobName = new Map(jobs.map(j => [j._id.toString(), j.name]));

  const ref = (r: {
    _id: Types.ObjectId;
    jobId?: Types.ObjectId;
    trigger?: string;
    commands?: string[];
    createdAt?: Date;
  }): QueuedRunRef => ({
    runId: r._id.toString(),
    ...(r.jobId
      ? {
          jobId: r.jobId.toString(),
          jobName: jobName.get(r.jobId.toString()),
        }
      : {}),
    trigger: r.trigger,
    commands: r.commands,
    createdAt: r.createdAt,
  });

  let blockedBy: DbtRunQueueInfo["blockedBy"] = null;
  let typical: number | undefined;
  let estimatedStartAt: Date | undefined;
  if (running) {
    const startedAt = running.startedAt
      ? new Date(running.startedAt)
      : undefined;
    blockedBy = {
      ...ref(running),
      startedAt,
      runningForMs: startedAt ? now.getTime() - startedAt.getTime() : undefined,
    };
    if (running.jobId) {
      const recent = await DbtRun.find({
        jobId: running.jobId,
        status: "success",
        durationMs: { $gt: 0 },
      })
        .sort({ createdAt: -1 })
        .limit(DURATION_SAMPLE)
        .select("durationMs")
        .lean();
      typical = median(
        recent
          .map(r => r.durationMs)
          .filter((d): d is number => typeof d === "number"),
      );
      if (typical !== undefined && startedAt) {
        // Never estimate a start in the past: an overrunning job is "any
        // moment now", which is the current time.
        estimatedStartAt = new Date(
          Math.max(startedAt.getTime() + typical, now.getTime()),
        );
      }
    }
  }

  const runsAhead = ahead.length + (running ? 1 : 0);
  let reason: string;
  if (blockedBy) {
    const what = blockedBy.jobName
      ? `job "${blockedBy.jobName}"`
      : `a ${blockedBy.trigger ?? "manual"} run`;
    const age =
      blockedBy.runningForMs !== undefined
        ? `, running for ${formatMinutes(blockedBy.runningForMs)}`
        : "";
    const behind =
      ahead.length > 0
        ? ` and ${ahead.length} other queued run${ahead.length === 1 ? "" : "s"}`
        : "";
    const eta =
      typical !== undefined
        ? ` It usually takes ${formatMinutes(typical)}.`
        : "";
    reason =
      `Queued behind run ${blockedBy.runId} of ${what}${age}${behind}. ` +
      `The project's ${lane} lane runs one dbt invocation at a time.${eta}`;
  } else if (ahead.length > 0) {
    reason =
      `Queued behind ${ahead.length} earlier run${ahead.length === 1 ? "" : "s"} ` +
      `in this project's ${lane} lane; none is executing yet.`;
  } else {
    reason =
      `Nothing else is running in this project's ${lane} lane, so the dbt ` +
      "worker should start it within seconds. If it stays queued, the " +
      "worker is not receiving run events.";
  }

  return {
    lane,
    runsAhead,
    blockedBy,
    queuedAheadCount: ahead.length,
    queuedAhead: ahead.slice(0, MAX_LISTED_AHEAD).map(ref),
    ...(typical !== undefined ? { blockingTypicalDurationMs: typical } : {}),
    ...(estimatedStartAt ? { estimatedStartAt } : {}),
    reason,
  };
}
