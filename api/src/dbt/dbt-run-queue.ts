/**
 * Why a queued dbt run is waiting.
 *
 * The executor (`dbtRunExecutorFunction`) runs one dbt invocation at a time
 * per project: an Inngest concurrency lock keyed on `projectId`, limit 1. A
 * run triggered while another one holds that slot sits in "queued" with no
 * other signal, so a caller polling it cannot tell "behind a 40-minute
 * nightly build" from "the worker never got the event". This module answers
 * that from the runs collection alone: the run holding the slot, the runs
 * queued ahead of this one, and a start estimate from the blocking job's
 * recent durations.
 *
 * Inngest does not promise FIFO order inside a concurrency key, so the
 * position is an estimate. The blocking run is exact.
 */
import { Types } from "mongoose";
import { DbtJob, DbtRun } from "../database/workspace-schema";

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
  /** The run holding the project's single execution slot, if any. */
  blockedBy:
    (QueuedRunRef & { startedAt?: Date; runningForMs?: number }) | null;
  /** Other queued runs of this project created before this one. */
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

  const [running, ahead] = await Promise.all([
    DbtRun.findOne({
      projectId: run.projectId,
      status: "running",
      _id: { $ne: run._id },
    })
      .sort({ startedAt: 1 })
      .select("_id jobId trigger commands createdAt startedAt")
      .lean(),
    DbtRun.find({
      projectId: run.projectId,
      status: "queued",
      _id: { $ne: run._id },
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
      `The project runs one dbt invocation at a time.${eta}`;
  } else if (ahead.length > 0) {
    reason =
      `Queued behind ${ahead.length} earlier run${ahead.length === 1 ? "" : "s"} ` +
      `of this project; none is executing yet.`;
  } else {
    reason =
      "Nothing else is running for this project, so the dbt worker should " +
      "start it within seconds. If it stays queued, the worker is not " +
      "receiving run events.";
  }

  return {
    runsAhead,
    blockedBy,
    queuedAheadCount: ahead.length,
    queuedAhead: ahead.slice(0, MAX_LISTED_AHEAD).map(ref),
    ...(typical !== undefined ? { blockingTypicalDurationMs: typical } : {}),
    ...(estimatedStartAt ? { estimatedStartAt } : {}),
    reason,
  };
}
