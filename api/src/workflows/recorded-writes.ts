/**
 * Writes a dry run (`dryRun: true`) recorded instead of sending. A dry run
 * never writes through a connection; its write is answered as recorded, and
 * the whole request (URL, headers and body, every credential value
 * redacted: connections/forward.ts `describeRequest`) is kept here so the
 * agent can check a Slack or email payload in `workflows_status` without
 * sending it, with whether a real run would be allowed to send it. Kept 7
 * days, by workspace and run; a sandbox run's only for its person.
 */
import type { RecordedRequest } from "../connections/forward";
import { loggers } from "../logging";
import { workflowRecordedWritesRepo } from "../repositories/control-plane-app";

export {
  WorkflowRecordedRun,
  WorkflowRecordedWrite,
  type IWorkflowRecordedWrite,
} from "../database/models/workflow-recorded-writes";

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
  { wouldSend }: { wouldSend?: boolean } = {},
): Promise<"kept" | "full" | "failed"> {
  try {
    const body = request.body === undefined ? "" : textOf(request.body);
    const cut = body.length > MAX_BODY_CHARS;
    const seq = await workflowRecordedWritesRepo.appendWrite(
      {
        workspaceId,
        runId: run.runId,
        ...(run.userId ? { userId: run.userId } : {}),
        connectionId: String(connection._id),
        connection: connection.name,
        ...(run.step ? { step: run.step } : {}),
        request: cut
          ? { ...request, body: `${body.slice(0, MAX_BODY_CHARS)}…` }
          : request,
        ...(cut ? { bodyCut: true } : {}),
        ...(wouldSend !== undefined ? { wouldSend } : {}),
      },
      MAX_RECORDED_PER_RUN,
    );
    return seq === null ? "full" : "kept";
  } catch (error) {
    logger.warn("Could not keep a recorded write", {
      workspaceId,
      runId: run.runId,
      errorName: error instanceof Error ? error.name : "unknown",
    });
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
  /** False: a real run would be refused (not on the writers list). */
  wouldSend?: boolean;
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
  const filter = {
    workspaceId,
    runId,
    ...(userId !== undefined ? { userId } : {}),
  };
  const start = Number.isInteger(from) && from > 0 ? from : 0;
  const [total, rows] = await Promise.all([
    workflowRecordedWritesRepo.countWrites(filter),
    workflowRecordedWritesRepo.listWrites(filter, {
      offset: start,
      limit: RECORDED_PAGE_SIZE,
    }),
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
      ...(row.wouldSend !== undefined ? { wouldSend: row.wouldSend } : {}),
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
        `warn: ${count} connection ${count === 1 ? "write" : "writes"} recorded, not sent (a dry run): see recordedWrites`,
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
