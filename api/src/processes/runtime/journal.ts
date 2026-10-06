/**
 * The run journal: append-only `process_events`.
 *
 * Three jobs in one stream:
 *   1. timeline/audit  — every primitive, tool call, agent turn, decision;
 *   2. memo            — `step.completed` (dedupeKey `step:<key>`) is the
 *                        engine-independent record that a step finished;
 *   3. effect ledger   — `tool.started`/`tool.completed` with dedupe keys make
 *                        destructive calls at-most-once.
 *
 * Writes that carry a `dedupeKey` are idempotent: a duplicate insert (retry,
 * replay) is swallowed and reported as `inserted: false`.
 */
import { Types } from "mongoose";
import {
  ProcessEvent,
  type IProcessEvent,
  type ProcessEventType,
} from "./models";

export interface JournalScope {
  runId: string;
  workspaceId: string;
  versionId: string;
}

export interface AppendInput {
  type: ProcessEventType;
  stepKey?: string;
  data?: Record<string, unknown>;
  dedupeKey?: string;
}

/** Hard cap for values that become durable state (step outputs). */
export const MAX_STATE_BYTES = 1_000_000;
/** Soft cap for values that are only displayed (tool I/O, logs). */
export const MAX_DISPLAY_BYTES = 64_000;

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: number }).code === 11000
  );
}

export async function append(
  scope: JournalScope,
  input: AppendInput,
): Promise<{ inserted: boolean }> {
  try {
    await ProcessEvent.create({
      runId: new Types.ObjectId(scope.runId),
      workspaceId: new Types.ObjectId(scope.workspaceId),
      versionId: new Types.ObjectId(scope.versionId),
      ts: new Date(),
      type: input.type,
      stepKey: input.stepKey,
      data: input.data ?? {},
      dedupeKey: input.dedupeKey,
    });
    return { inserted: true };
  } catch (error) {
    if (input.dedupeKey && isDuplicateKeyError(error)) {
      return { inserted: false };
    }
    throw error;
  }
}

export async function findByDedupeKey(
  runId: string,
  dedupeKey: string,
): Promise<IProcessEvent | null> {
  return ProcessEvent.findOne({
    runId: new Types.ObjectId(runId),
    dedupeKey,
  }).lean<IProcessEvent>();
}

export async function listEvents(
  runId: string,
  filter: { stepKey?: string; type?: ProcessEventType } = {},
): Promise<IProcessEvent[]> {
  return ProcessEvent.find({
    runId: new Types.ObjectId(runId),
    ...(filter.stepKey ? { stepKey: filter.stepKey } : {}),
    ...(filter.type ? { type: filter.type } : {}),
  })
    .sort({ ts: 1, _id: 1 })
    .lean<IProcessEvent[]>();
}

/** Round-trip through JSON: what a step returns is what a replay returns. */
export function toJson<T>(value: T, what: string): T {
  if (value === undefined) return value;
  const text = JSON.stringify(value);
  if (text === undefined) return undefined as T;
  if (text.length > MAX_STATE_BYTES) {
    throw new Error(
      `${what} is ${Math.round(text.length / 1000)} KB; durable values are capped at ` +
        `${MAX_STATE_BYTES / 1000} KB. Store large data with s.artifact() and return a summary.`,
    );
  }
  return JSON.parse(text) as T;
}

/** For display-only fields: keep it, or keep a preview of it. */
export function capForDisplay(value: unknown): unknown {
  if (value === undefined) return undefined;
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return { unserializable: String(value) };
  }
  if (text === undefined) return undefined;
  if (text.length <= MAX_DISPLAY_BYTES) return JSON.parse(text);
  return {
    truncated: true,
    bytes: text.length,
    preview: text.slice(0, MAX_DISPLAY_BYTES),
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}
