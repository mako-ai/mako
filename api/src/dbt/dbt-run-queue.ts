/**
 * The dbt run queue: who may run at once, and why a queued run is waiting.
 *
 * The executor (`dbtRunExecutorFunction`) holds two Inngest concurrency
 * locks per run, both read from the "dbt/run.requested" event:
 *
 *  - `laneKey`, limit N: `<projectId>:job` or `<projectId>:interactive`.
 *    N is `DBT_PROJECT_RUN_CONCURRENCY`, default 1. Each lane has its own N
 *    slots per project, so a validation run (parse / compile / show) never
 *    waits behind a 40-minute build and never holds a build back.
 *  - `lockKey`, limit 1: `job:<jobId>` for runs of a saved job, so one job
 *    never runs twice at once whatever N is; `run:<runId>` otherwise, which
 *    locks nothing.
 *
 * A run triggered while its lane is full sits in "queued" with no other
 * signal, so a caller polling it cannot tell "behind the nightly build" from
 * "the worker never got the event". `describeQueuedRun` answers that from
 * the runs collection alone: the run holding it back, the runs queued ahead
 * of it, and a start estimate from the blocking job's recent durations.
 *
 * Inngest does not promise FIFO order inside a concurrency key, so the
 * position is an estimate. The blocking run is exact when N is 1.
 */
import { Types } from "mongoose";
import {
  DbtJob,
  DbtRun,
  type DbtRunLane,
  type IDbtRun,
} from "../database/workspace-schema";

/** Runs of one project and lane that may execute at once, unless overridden. */
export const DEFAULT_DBT_PROJECT_RUN_CONCURRENCY = 1;
/** Above this a typo reads as "no limit": two dbt processes already share RAM. */
const MAX_DBT_PROJECT_RUN_CONCURRENCY = 16;

/**
 * `DBT_PROJECT_RUN_CONCURRENCY`: how many runs of one project execute at
 * once per lane. Parallel jobs are opt-in, because two jobs whose selections
 * share a model would write the same table at once and nothing locks tables.
 * Anything that is not a whole number of at least 1 falls back to 1.
 */
export function dbtProjectRunConcurrency(
  raw: string | undefined = process.env.DBT_PROJECT_RUN_CONCURRENCY,
): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_DBT_PROJECT_RUN_CONCURRENCY;
  }
  return Math.min(parsed, MAX_DBT_PROJECT_RUN_CONCURRENCY);
}

/** dbt subcommands that only read: they validate, they build nothing. */
const INTERACTIVE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "parse",
  "compile",
  "show",
]);

/**
 * The lane a run executes in. Interactive = a person or an agent waiting on
 * a validation: no saved job, a manual or agent trigger, and every command a
 * parse, compile or show. Everything else is the job lane, CI included.
 */
export function dbtRunLane(run: {
  jobId?: string | Types.ObjectId | null;
  trigger: IDbtRun["trigger"];
  subcommands: string[];
}): DbtRunLane {
  if (run.jobId) return "job";
  if (run.trigger !== "manual" && run.trigger !== "agent") return "job";
  if (run.subcommands.length === 0) return "job";
  return run.subcommands.every(subcommand =>
    INTERACTIVE_SUBCOMMANDS.has(subcommand),
  )
    ? "interactive"
    : "job";
}

/**
 * Mongo filter for the runs of one lane. Runs that predate lanes carry no
 * `lane` and executed in the single project queue, which is the job lane.
 */
export function dbtRunLaneFilter(lane: DbtRunLane): Record<string, unknown> {
  return lane === "interactive"
    ? { lane: "interactive" }
    : { lane: { $ne: "interactive" } };
}

/** The two concurrency keys a "dbt/run.requested" event carries. */
export function dbtRunQueueKeys(run: {
  projectId: string;
  runId: string;
  jobId?: string | null;
  lane: DbtRunLane;
}): { laneKey: string; lockKey: string } {
  return {
    laneKey: `${run.projectId}:${run.lane}`,
    lockKey: run.jobId ? `job:${run.jobId}` : `run:${run.runId}`,
  };
}

/**
 * Keys for a "dbt/run.requested" event that carries none: one sent by a
 * build that predates lanes and still queued when this build took over.
 * Without them every such event of every project would share one empty
 * `lockKey` at limit 1. Returns null when the event already has both keys.
 *
 * A run that predates lanes has no `lane`: it queued in the single project
 * queue, which is the job lane.
 */
export function dbtRunFallbackQueueKeys(
  event: {
    projectId: string;
    runId: string;
    jobId?: string | null;
    laneKey?: string | null;
    lockKey?: string | null;
  },
  run?: { jobId?: string | Types.ObjectId | null; lane?: DbtRunLane } | null,
): { laneKey: string; lockKey: string } | null {
  if (event.laneKey && event.lockKey) return null;
  const jobId = event.jobId ?? run?.jobId?.toString() ?? null;
  const derived = dbtRunQueueKeys({
    projectId: event.projectId,
    runId: event.runId,
    jobId,
    lane: run?.lane ?? "job",
  });
  return {
    laneKey: event.laneKey || derived.laneKey,
    lockKey: event.lockKey || derived.lockKey,
  };
}

/**
 * Whose warm directory a run uses on the executor (`ProjectDirScope.userId`).
 * Two runs that may execute at once must never share a directory: they would
 * wait on its in-process mutex inside a step, and that wait eats the step's
 * time budget.
 *
 * With one slot per lane (N = 1, the default) the lanes alone keep runs
 * apart, so every run keeps a directory that stays warm:
 *  - Interactive runs get their own directory, apart from any build.
 *  - Working-tree and laptop runs keep their per-user directory.
 *  - Job runs and other committed builds share the deploy directory.
 *
 * With N > 1 a lane runs several runs at once, and only the per-job lock
 * still keeps two runs apart:
 *  - A job run uses its job's directory (`job:<jobId>`): one job runs one
 *    run at a time, so it is never shared and stays warm.
 *  - Every other run gets a directory of its own (`run:<runId>`): two
 *    validation runs of one user, two agent runs with no working tree, or
 *    two ad-hoc builds would otherwise meet in one directory. It starts
 *    cold (seeded from the artifact cache) and the sweep reaps it.
 */
export function dbtRunWarmDirOwner(
  run: {
    runId: string;
    lane: DbtRunLane;
    jobId?: string | null;
    workingTreeUserId?: string | null;
    localOverlayKey?: string | null;
    triggeredBy: string;
  },
  projectConcurrency: number = dbtProjectRunConcurrency(),
): string | undefined {
  const treeOwner =
    run.workingTreeUserId ??
    (run.localOverlayKey ? `local:${run.triggeredBy}` : undefined);
  if (projectConcurrency > 1) {
    // A job run that carries a tree owner never builds in the job's
    // committed dir: it gets one per (owner, job), still under the job lock.
    if (run.jobId) {
      return treeOwner ? `${treeOwner}:job:${run.jobId}` : `job:${run.jobId}`;
    }
    return run.lane === "interactive"
      ? `interactive:run:${run.runId}`
      : `run:${run.runId}`;
  }
  if (run.lane === "interactive") {
    return treeOwner ? `interactive:${treeOwner}` : "interactive";
  }
  return treeOwner;
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
  /** The lane this run waits in. */
  lane: DbtRunLane;
  /** Runs of this project and lane that may execute at once. */
  slots: number;
  /** Runs of this project and lane executing now. */
  runningCount: number;
  /**
   * Runs ahead of this one: the run holding it back plus earlier queued
   * runs. 1 = next to start once that run finishes.
   */
  runsAhead: number;
  /**
   * The run holding this one back: a running run of the same job, else the
   * longest-running run of the lane when every slot is taken. Null when a
   * slot is free.
   */
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
  /** Scopes every lookup below to the run's own workspace. */
  workspaceId?: Types.ObjectId;
  projectId?: Types.ObjectId;
  jobId?: Types.ObjectId;
  trigger?: string;
  commands?: string[];
  status: string;
  /** Unset on runs that predate lanes (= "job"). */
  lane?: string;
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

/** Why the blocking run blocks: the per-job lock, or a full lane. */
function capacitySentence(
  lane: DbtRunLane,
  slots: number,
  sameJob: boolean,
): string {
  if (sameJob) return "A job runs one run at a time.";
  if (lane === "interactive") {
    return slots === 1
      ? "Validation runs (parse, compile, show) run one at a time per project, apart from jobs."
      : `All ${slots} validation slots of the project are in use.`;
  }
  return slots === 1
    ? "The project runs one job or build at a time; validation runs (parse, compile, show) do not wait here."
    : `All ${slots} run slots of the project are in use.`;
}

/**
 * Explain a queued run. Returns null for any run that is not queued.
 */
export async function describeQueuedRun(
  run: QueueRun,
  now: Date = new Date(),
): Promise<DbtRunQueueInfo | null> {
  if (run.status !== "queued" || !run.projectId) return null;

  const lane: DbtRunLane = run.lane === "interactive" ? "interactive" : "job";
  const slots = dbtProjectRunConcurrency();
  const laneFilter = dbtRunLaneFilter(lane);
  // Every read stays inside the run's workspace. It also lets the run
  // lookups use the { workspaceId, projectId, createdAt } index.
  const inWorkspace = run.workspaceId ? { workspaceId: run.workspaceId } : {};

  const [runningInLane, ahead] = await Promise.all([
    DbtRun.find({
      ...inWorkspace,
      projectId: run.projectId,
      status: "running",
      _id: { $ne: run._id },
      ...laneFilter,
    })
      .sort({ startedAt: 1 })
      .select("_id jobId trigger commands createdAt startedAt")
      .lean(),
    DbtRun.find({
      ...inWorkspace,
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

  // Two things hold a queued run back: a running run of its own job (the
  // per-job lock, whatever N is) or a lane with every slot taken.
  const sameJobRunning = run.jobId
    ? runningInLane.find(r => r.jobId?.toString() === run.jobId?.toString())
    : undefined;
  const laneFull = runningInLane.length >= slots;
  const running = sameJobRunning ?? (laneFull ? runningInLane[0] : undefined);

  const jobIds = [
    ...new Set(
      [running?.jobId, ...ahead.map(r => r.jobId)]
        .filter((id): id is Types.ObjectId => !!id)
        .map(id => id.toString()),
    ),
  ];
  const jobs = jobIds.length
    ? await DbtJob.find({
        ...inWorkspace,
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
        ...inWorkspace,
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
      `${capacitySentence(lane, slots, Boolean(sameJobRunning))}${eta}`;
  } else if (ahead.length > 0) {
    const inUse =
      runningInLane.length === 0
        ? "none is executing yet"
        : `${runningInLane.length} of ${slots} slots are in use`;
    reason =
      `Queued behind ${ahead.length} earlier run${ahead.length === 1 ? "" : "s"} ` +
      `of this project; ${inUse}.`;
  } else {
    const free =
      runningInLane.length === 0
        ? "Nothing is ahead of this run"
        : `A slot is free (${runningInLane.length} of ${slots} in use)`;
    reason =
      `${free}, so the dbt worker should start it within seconds. If it ` +
      "stays queued, the worker is not receiving run events.";
  }

  return {
    lane,
    slots,
    runningCount: runningInLane.length,
    runsAhead,
    blockedBy,
    queuedAheadCount: ahead.length,
    queuedAhead: ahead.slice(0, MAX_LISTED_AHEAD).map(ref),
    ...(typical !== undefined ? { blockingTypicalDurationMs: typical } : {}),
    ...(estimatedStartAt ? { estimatedStartAt } : {}),
    reason,
  };
}
