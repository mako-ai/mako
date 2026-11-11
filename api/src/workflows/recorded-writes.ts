/**
 * Writes an agent's test run recorded instead of sending. A run an agent
 * started (a sandbox run on its key, a deployed run Mako started for an
 * agent) never writes through a connection; its write is answered as
 * recorded, and the whole request (URL, headers and body, every credential
 * value redacted: connections/forward.ts `describeRequest`) is kept here so
 * the agent can check a Slack or email payload in `workflows_status` without
 * sending it. Kept 7 days, by workspace and run; a sandbox run's only for
 * its person.
 */
import mongoose, { Schema, Types } from "mongoose";

import type { RecordedRequest } from "../connections/forward";
import { loggers } from "../logging";

const logger = loggers.api("workflows-recorded-writes");

/** The longest body kept, as text; longer is cut and marked. */
const MAX_BODY_CHARS = 64_000;
/** The most recorded writes one run keeps. */
export const MAX_RECORDED_PER_RUN = 200;
/** A run's answer shows bodies up to this long unless asked for all. */
const SUMMARY_BODY_CHARS = 4000;
/** One answer shows at most this many recorded writes... */
export const RECORDED_PAGE_SIZE = 20;
/** ...and stops before this many characters (always at least one write). */
const RECORDED_PAGE_CHARS = 100_000;

export interface IWorkflowRecordedWrite {
  workspaceId: Types.ObjectId;
  runId: string;
  /** A sandbox run's person: only they read it. */
  userId?: string;
  connectionId: Types.ObjectId;
  connection: string;
  step?: string;
  request: RecordedRequest;
  /** Its place in the run, from 0: the order an answer pages them in. */
  seq: number;
  /** The body was longer than kept. */
  bodyCut?: boolean;
  at: Date;
}

const WorkflowRecordedWriteSchema = new Schema<IWorkflowRecordedWrite>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    runId: { type: String, required: true },
    userId: { type: String },
    connectionId: { type: Schema.Types.ObjectId, required: true },
    connection: { type: String, required: true },
    step: { type: String },
    request: { type: Schema.Types.Mixed, required: true },
    seq: { type: Number, required: true },
    bodyCut: { type: Boolean },
    at: { type: Date, default: () => new Date() },
  },
  { collection: "workflow_recorded_writes", versionKey: false },
);

WorkflowRecordedWriteSchema.index(
  { workspaceId: 1, runId: 1, seq: 1 },
  { unique: true },
);
WorkflowRecordedWriteSchema.index(
  { at: 1 },
  { expireAfterSeconds: 7 * 24 * 60 * 60 },
);

export const WorkflowRecordedWrite =
  (mongoose.models
    .WorkflowRecordedWrite as mongoose.Model<IWorkflowRecordedWrite>) ??
  mongoose.model<IWorkflowRecordedWrite>(
    "WorkflowRecordedWrite",
    WorkflowRecordedWriteSchema,
  );

/**
 * One run's count of recorded writes: taking a place is one atomic update,
 * so parallel steps cannot record past MAX_RECORDED_PER_RUN.
 */
interface IWorkflowRecordedRun {
  workspaceId: Types.ObjectId;
  runId: string;
  count: number;
  at: Date;
}

const WorkflowRecordedRunSchema = new Schema<IWorkflowRecordedRun>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    runId: { type: String, required: true },
    count: { type: Number, required: true, default: 0 },
    at: { type: Date, default: () => new Date() },
  },
  { collection: "workflow_recorded_runs", versionKey: false },
);

WorkflowRecordedRunSchema.index({ workspaceId: 1, runId: 1 }, { unique: true });
WorkflowRecordedRunSchema.index(
  { at: 1 },
  { expireAfterSeconds: 7 * 24 * 60 * 60 },
);

export const WorkflowRecordedRun =
  (mongoose.models
    .WorkflowRecordedRun as mongoose.Model<IWorkflowRecordedRun>) ??
  mongoose.model<IWorkflowRecordedRun>(
    "WorkflowRecordedRun",
    WorkflowRecordedRunSchema,
  );

const isDuplicateKey = (error: unknown) =>
  (error as { code?: number } | null)?.code === 11000;

/**
 * The next place in `runId`'s recorded writes, or null when it holds
 * MAX_RECORDED_PER_RUN. Two first writes may race on the upsert: the one
 * that loses tries again once, finding the run's row.
 */
async function takePlace(
  workspaceId: Types.ObjectId,
  runId: string,
): Promise<number | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const row = await WorkflowRecordedRun.findOneAndUpdate(
        { workspaceId, runId, count: { $lt: MAX_RECORDED_PER_RUN } },
        { $inc: { count: 1 }, $setOnInsert: { at: new Date() } },
        { upsert: true, new: true },
      ).lean();
      return row ? row.count - 1 : null;
    } catch (error) {
      // The run's row exists: at the cap (no row matched, the upsert
      // collided), or a parallel first write made it. Ask again.
      if (!isDuplicateKey(error)) throw error;
      const full = await WorkflowRecordedRun.exists({
        workspaceId,
        runId,
        count: { $gte: MAX_RECORDED_PER_RUN },
      });
      if (full) return null;
    }
  }
  return null;
}

/** The run a recorded write belongs to. */
export interface RecordRun {
  runId: string;
  /** A sandbox run's person. */
  userId?: string;
  step?: string;
}

const textOf = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");

/**
 * Keep one recorded write of `run`: "kept", "full" when the run holds
 * MAX_RECORDED_PER_RUN already, "failed" when the database failed.
 */
export async function keepRecordedWrite(
  workspaceId: string,
  run: RecordRun,
  connection: { _id: unknown; name: string },
  request: RecordedRequest,
): Promise<"kept" | "full" | "failed"> {
  try {
    const workspace = new Types.ObjectId(workspaceId);
    const seq = await takePlace(workspace, run.runId);
    if (seq === null) return "full";
    const body = request.body === undefined ? "" : textOf(request.body);
    const cut = body.length > MAX_BODY_CHARS;
    await WorkflowRecordedWrite.create({
      workspaceId: workspace,
      runId: run.runId,
      ...(run.userId ? { userId: run.userId } : {}),
      connectionId: new Types.ObjectId(String(connection._id)),
      connection: connection.name,
      ...(run.step ? { step: run.step } : {}),
      request: cut
        ? { ...request, body: `${body.slice(0, MAX_BODY_CHARS)}…` }
        : request,
      seq,
      ...(cut ? { bodyCut: true } : {}),
    });
    return "kept";
  } catch (error) {
    logger.warn("Could not keep a recorded write", { error });
    return "failed";
  }
}

export type RecordedWrite = {
  connection: string;
  step?: string;
  at: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  bodyCut?: boolean;
};

export type RecordedWritesPage = {
  /** How many writes the run recorded (a sandbox run's: its person's). */
  total: number;
  /** Writes `from` on, oldest first, at most one page. */
  writes: RecordedWrite[];
  /** Where the next page starts, when there is one. */
  next?: number;
};

/**
 * One page of the writes `runId` recorded, oldest first, from place `from`:
 * at most RECORDED_PAGE_SIZE and about RECORDED_PAGE_CHARS (always one). A
 * body past SUMMARY_BODY_CHARS is cut unless `full`. A sandbox run's are
 * only its person's.
 */
export async function recordedWritesOf(
  workspaceId: string,
  runId: string,
  {
    userId,
    full = false,
    from = 0,
  }: { userId?: string; full?: boolean; from?: number } = {},
): Promise<RecordedWritesPage> {
  if (!Types.ObjectId.isValid(workspaceId)) return { total: 0, writes: [] };
  const filter = {
    workspaceId: new Types.ObjectId(workspaceId),
    runId,
    ...(userId !== undefined ? { userId } : {}),
  };
  const start = Number.isInteger(from) && from > 0 ? from : 0;
  const [total, rows] = await Promise.all([
    WorkflowRecordedWrite.countDocuments(filter),
    WorkflowRecordedWrite.find(filter)
      .sort({ seq: 1 })
      .skip(start)
      .limit(RECORDED_PAGE_SIZE)
      .lean(),
  ]);
  const writes: RecordedWrite[] = [];
  let chars = 0;
  for (const row of rows) {
    const body = row.request.body;
    const text = body === undefined ? "" : textOf(body);
    const shortened = !full && text.length > SUMMARY_BODY_CHARS;
    const write: RecordedWrite = {
      connection: row.connection,
      ...(row.step ? { step: row.step } : {}),
      at: row.at.toISOString(),
      method: row.request.method,
      url: row.request.url,
      headers: row.request.headers,
      ...(body === undefined
        ? {}
        : {
            body: shortened
              ? `${text.slice(0, SUMMARY_BODY_CHARS)}… (${text.length} chars; full: true for all)`
              : body,
          }),
      ...(row.bodyCut ? { bodyCut: true } : {}),
    };
    chars += JSON.stringify(write).length;
    if (writes.length > 0 && chars > RECORDED_PAGE_CHARS) break;
    writes.push(write);
  }
  const shown = start + writes.length;
  return { total, writes, ...(shown < total ? { next: shown } : {}) };
}

/** What a run's answer gains when it recorded writes. */
export type RecordedSection = {
  recordedWriteCount?: number;
  recordedWrites?: RecordedWrite[];
  recordedWritesNext?: number;
};

/** A step of a run, as runs.ts and sandbox.ts shape it. */
type StepLike = { step?: unknown; logs?: unknown };

/**
 * `run` with the writes it recorded: `recordedWriteCount`, one page of
 * `recordedWrites` (`recordedWritesNext` when there is more), and a line in
 * each step's logs saying how many of its writes were recorded, not sent.
 * A run that recorded none is answered as it is. A sandbox run's are only
 * its person's (`userId`).
 */
export async function withRecordedWrites<Run extends { steps?: StepLike[] }>(
  workspaceId: string,
  runId: string,
  run: Run,
  options: { userId?: string; full?: boolean; from?: number } = {},
): Promise<Run & RecordedSection> {
  const page = await recordedWritesOf(workspaceId, runId, options);
  if (page.total === 0) return run;
  // Counted by step on this page only when every write is on it.
  const byStep = new Map<string, number>();
  if (page.writes.length === page.total) {
    for (const write of page.writes) {
      if (write.step) {
        byStep.set(write.step, (byStep.get(write.step) ?? 0) + 1);
      }
    }
  }
  const steps = run.steps?.map(step => {
    const count = byStep.get(String(step.step));
    if (!count || !Array.isArray(step.logs)) return step;
    return {
      ...step,
      logs: [
        ...step.logs,
        `warn: ${count} connection ${count === 1 ? "write" : "writes"} recorded, not sent (an agent started this run): see recordedWrites`,
      ],
    };
  });
  return {
    ...run,
    ...(steps ? { steps } : {}),
    recordedWriteCount: page.total,
    recordedWrites: page.writes,
    ...(page.next !== undefined ? { recordedWritesNext: page.next } : {}),
  };
}
