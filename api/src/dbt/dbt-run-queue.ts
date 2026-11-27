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
 * checks the same two slots in the database before a run starts, so a lapse of the
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
  dbtRepo,
  type DbtRunLane,
  type DbtRunRecord,
  type DbtRunSlotClaim,
} from "../repositories/dbt";

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
  const job = await dbtRepo.findJobById(String(jobId));
  if (!job) return "default";
  if (
    job.lane &&
    job.laneEvaluatedAt &&
    now.getTime() - new Date(job.laneEvaluatedAt).getTime() < FAST_LANE_TTL_MS
  ) {
    return job.lane;
  }
  const recent = await dbtRepo.listRuns(
    { jobId: String(jobId), status: "success", durationMsGreaterThan: 0 },
    { limit: FAST_LANE_SAMPLE },
  );
  const { lane, medianMs } = laneForDurations(
    recent
      .map(r => r.durationMs)
      .filter((d): d is number => typeof d === "number"),
  );
  await dbtRepo.updateJob(String(jobId), {
    lane,
    laneEvaluatedAt: now,
    laneMedianMs: medianMs ?? null,
  });
  return lane;
}

/**
 * The lane a new run goes to. Only a scheduled run of a saved job can be
 * fast. Manual, agent, CI and pre-deploy runs (no job) use the default lane.
 */
export async function chooseRunLane(
  run: {
    trigger: DbtRunRecord["trigger"];
    jobId?: string | Types.ObjectId | null;
  },
  now: Date = new Date(),
): Promise<DbtRunLane> {
  if (run.trigger !== "schedule" || !run.jobId) return "default";
  return resolveJobLane(run.jobId, now);
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

export type { DbtRunSlotClaim };

/**
 * Move a queued run to "running" only when no other run holds its slot.
 *
 * The Inngest locks alone let 8 runs of one project lane run together on
 * 19 Nov 2026: the deploy of #1424 changed the lock keys, and runs created
 * around the switch ran under no lock. This check reads the runs collection,
 * so it holds whatever Inngest does with its keys.
 *
 */
export async function claimDbtRunSlot(
  runId: Types.ObjectId | string,
  now: Date = new Date(),
): Promise<DbtRunSlotClaim> {
  return dbtRepo.claimRunSlot(String(runId), now);
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
  _id: Types.ObjectId | string;
  projectId?: Types.ObjectId | string;
  jobId?: Types.ObjectId | string;
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
  const [running, ahead] = await Promise.all([
    // The run holding this lane's slot. A job run also waits on a run of the
    // same job in the other lane (the per-job lock).
    dbtRepo.findRunSlotHolder({
      _id: String(run._id),
      projectId: String(run.projectId),
      jobId: run.jobId?.toString(),
      lane,
    }),
    dbtRepo.listRuns(
      {
        projectId: String(run.projectId),
        status: "queued",
        excludeRunId: String(run._id),
        lane,
        createdBefore: run.createdAt,
      },
      { sort: "createdAtAsc" },
    ),
  ]);

  const jobIds = [
    ...new Set(
      [running?.jobId, ...ahead.map(r => r.jobId)]
        .filter((id): id is string => !!id)
        .map(id => id.toString()),
    ),
  ];
  const jobs = jobIds.length ? await dbtRepo.listJobsByIds(jobIds) : [];
  const jobName = new Map(jobs.map(j => [j._id.toString(), j.name]));

  const ref = (r: {
    _id: Types.ObjectId | string;
    jobId?: Types.ObjectId | string;
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
      const recent = await dbtRepo.listRuns(
        { jobId: running.jobId, status: "success", durationMsGreaterThan: 0 },
        { limit: DURATION_SAMPLE },
      );
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
