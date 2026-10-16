/**
 * Sandbox runs, kept. A sandbox run happens on the box's own engine, which
 * keeps nothing once the run ends, so Mako keeps it here: started, it is a
 * record with a runId the caller has at once; ended, the record holds what
 * the engine recorded, each text up to a megabyte and every log line. Read
 * like a deployed run (runs.ts shapes both), and listed among the person's
 * recent runs. Only the person who started a run reads it: it ran as them.
 * Kept as long as the recent runs list looks back.
 */
import { randomUUID } from "node:crypto";
import mongoose, { Schema } from "mongoose";

import {
  cap,
  FULL_TEXT_CHARS,
  RECENT_RUNS_DAYS,
  type RunDetail,
  type ShapeOptions,
  shapeRun,
} from "./runs";

/** What run.mjs leaves: the engine's record of the run, or why there is none. */
export type SandboxResult = {
  buildError?: string;
  detail?: RunDetail;
  logs?: Record<string, Array<Record<string, unknown>>>;
};

export type SandboxRunStatus =
  "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

interface ISandboxRun {
  _id: string;
  workspaceId: string;
  userId: string;
  workflowId: string;
  input?: string;
  status: SandboxRunStatus;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  /** Renewed by the process driving the run; a stale one means it died. */
  heartbeatAt: Date;
  /** Why the run did not happen or did not finish (type errors included). */
  error?: string;
  /** True when `error` is the checkout's type errors. */
  buildFailed?: boolean;
  /** The engine's record, as JSON: its keys are the workflow's own. */
  result?: string;
  /** The end of the box's install, engine and worker output. */
  boxLog?: string;
}

const SandboxRunSchema = new Schema<ISandboxRun>(
  {
    _id: { type: String, required: true },
    workspaceId: { type: String, required: true },
    userId: { type: String, required: true },
    workflowId: { type: String, required: true },
    input: String,
    status: { type: String, required: true },
    createdAt: { type: Date, required: true },
    startedAt: Date,
    finishedAt: Date,
    heartbeatAt: { type: Date, required: true },
    error: String,
    buildFailed: Boolean,
    result: String,
    boxLog: String,
  },
  { collection: "workflow_sandbox_runs", versionKey: false },
);

SandboxRunSchema.index({ workspaceId: 1, userId: 1, createdAt: -1 });
SandboxRunSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: RECENT_RUNS_DAYS * 24 * 60 * 60 },
);

export const SandboxRun =
  (mongoose.models.WorkflowSandboxRun as mongoose.Model<ISandboxRun>) ??
  mongoose.model<ISandboxRun>("WorkflowSandboxRun", SandboxRunSchema);

const RUN_ID_PREFIX = "sandbox-";

/** A sandbox run's id, told apart from a Hatchet run id by its prefix. */
export const isSandboxRunId = (runId: string) =>
  runId.startsWith(RUN_ID_PREFIX);

/**
 * How long a run may go without a heartbeat before it counts as lost: the
 * process driving it renews every few seconds.
 */
export const STALE_AFTER_MS = 90_000;

/** A document holds 16 MB; the result keeps well under it. */
const MAX_RESULT_CHARS = 12_000_000;
const MAX_BOX_LOG_CHARS = 64_000;

const ACTIVE: SandboxRunStatus[] = ["QUEUED", "RUNNING"];

export async function createSandboxRun(
  workspaceId: string,
  userId: string,
  workflowId: string,
  input: object,
) {
  const now = new Date();
  const run = await SandboxRun.create({
    _id: `${RUN_ID_PREFIX}${randomUUID()}`,
    workspaceId,
    userId,
    workflowId,
    input: JSON.stringify(input),
    status: "QUEUED",
    createdAt: now,
    heartbeatAt: now,
  });
  return run._id;
}

export async function markSandboxRunStarted(runId: string) {
  const now = new Date();
  await SandboxRun.updateOne(
    { _id: runId, status: { $in: ACTIVE } },
    { $set: { status: "RUNNING", startedAt: now, heartbeatAt: now } },
  );
}

/** Says the run's driver is alive. False once the run has ended. */
export async function heartbeatSandboxRun(runId: string) {
  const result = await SandboxRun.updateOne(
    { _id: runId, status: { $in: ACTIVE } },
    { $set: { heartbeatAt: new Date() } },
  );
  return result.matchedCount === 1;
}

/**
 * Every text of the result cut to `max` characters: what keeps an unusually
 * large run inside one document.
 */
function clipTexts(value: unknown, max: number): unknown {
  if (typeof value === "string") return cap(value, max);
  if (Array.isArray(value)) return value.map(item => clipTexts(item, max));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clipTexts(item, max)]),
    );
  }
  return value;
}

/** The result as stored: whole when it fits, its texts cut down when not. */
export function storedResult(result: SandboxResult): string {
  let json = JSON.stringify(result);
  for (
    let max = FULL_TEXT_CHARS;
    json.length > MAX_RESULT_CHARS && max >= 1000;
    max = Math.floor(max / 4)
  ) {
    json = JSON.stringify(clipTexts(result, max));
  }
  return json.length > MAX_RESULT_CHARS
    ? JSON.stringify({ buildError: "The run's output is too large to keep." })
    : json;
}

/** The run ended: keep what the engine recorded, or why there is nothing. */
export async function finishSandboxRun(
  runId: string,
  outcome: { result?: SandboxResult; error?: string; boxLog?: string },
) {
  const { result } = outcome;
  const runStatus = result?.detail?.run?.status;
  const ended =
    typeof runStatus === "string" &&
    !ACTIVE.includes(runStatus as SandboxRunStatus);
  const status: SandboxRunStatus =
    result?.detail && ended ? (runStatus as SandboxRunStatus) : "FAILED";
  const error =
    result?.buildError ??
    outcome.error ??
    (result?.detail && !ended
      ? `The run did not end (${String(runStatus)}).`
      : undefined);
  await SandboxRun.updateOne(
    { _id: runId, status: { $in: ACTIVE } },
    {
      $set: {
        status,
        finishedAt: new Date(),
        ...(error ? { error: cap(error, FULL_TEXT_CHARS) } : {}),
        ...(result?.buildError ? { buildFailed: true } : {}),
        ...(result?.detail ? { result: storedResult(result) } : {}),
        ...(outcome.boxLog
          ? { boxLog: outcome.boxLog.slice(-MAX_BOX_LOG_CHARS) }
          : {}),
      },
    },
  );
}

/**
 * A run whose driver stopped renewing it (its API process went away) ends
 * as failed; read before answering, so nobody waits on it forever.
 */
async function settleIfLost(run: ISandboxRun, now = Date.now()) {
  if (!ACTIVE.includes(run.status)) return run;
  if (now - run.heartbeatAt.getTime() < STALE_AFTER_MS) return run;
  const error =
    "The Mako process running this sandbox run stopped before it ended. Start it again.";
  await SandboxRun.updateOne(
    { _id: run._id, status: { $in: ACTIVE }, heartbeatAt: run.heartbeatAt },
    { $set: { status: "FAILED", finishedAt: new Date(now), error } },
  );
  return (await SandboxRun.findById(run._id).lean()) ?? run;
}

const durationOf = (run: ISandboxRun) =>
  run.startedAt && run.finishedAt
    ? run.finishedAt.getTime() - run.startedAt.getTime()
    : undefined;

/** One line of the recent runs list. */
function summaryOf(run: ISandboxRun) {
  return {
    runId: run._id,
    workflowId: run.workflowId,
    status: run.status,
    startedAt: (run.startedAt ?? run.createdAt).toISOString(),
    durationMs: durationOf(run),
    error: cap(run.error),
    trigger: "sandbox",
    sandbox: true as const,
  };
}

/**
 * One sandbox run as runs.ts shapes a deployed one, or null when it is not
 * this person's (or does not exist).
 */
export async function readSandboxRun(
  workspaceId: string,
  userId: string,
  runId: string,
  options: ShapeOptions = {},
) {
  const found = await SandboxRun.findOne({
    _id: runId,
    workspaceId,
    userId,
  }).lean();
  if (!found) return null;
  const run = await settleIfLost(found);
  const max = options.full ? FULL_TEXT_CHARS : undefined;
  const result = run.result ? (JSON.parse(run.result) as SandboxResult) : null;
  const shaped = result?.detail
    ? shapeRun(result.detail, result.logs ?? {}, options)
    : null;
  return {
    ...shaped,
    ...summaryOf(run),
    // The engine's error when it has one, else why there was no run.
    error: shaped?.error ?? cap(run.error, max),
    ...(run.buildFailed ? { buildError: cap(run.error, max) } : {}),
    input:
      shaped?.input ?? cap(run.input ? JSON.parse(run.input) : undefined, max),
    steps: shaped?.steps ?? [],
    // When the box said more than the engine recorded: why it did not start.
    ...(run.boxLog && !shaped
      ? { boxLog: options.full ? run.boxLog : run.boxLog.slice(-4000) }
      : {}),
  };
}

/** The person's last sandbox runs in the workspace, newest first. */
export async function listSandboxRuns(
  workspaceId: string,
  userId: string,
  limit: number,
) {
  const runs = await SandboxRun.find({ workspaceId, userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select("-result -boxLog")
    .lean();
  const now = Date.now();
  return Promise.all(
    runs.map(async run => summaryOf(await settleIfLost(run, now))),
  );
}
