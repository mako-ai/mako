/**
 * Model calls recorded before Mako kept their run (LlmUsage without
 * `workflowRun`), matched afterwards to the step they were made in by time:
 * a call belongs to a step of the same workspace when the whole call falls
 * inside the step's run time. The steps that hold it exactly come first; a
 * few seconds' slack (Hatchet's and Mako's clocks) only when none does. One
 * such step: a match. Several (two runs overlapping): ambiguous, left as it
 * is rather than guessed. None: not a deployed run's (a person's own test
 * run, say). Used by scripts/backfill-workflow-ai-costs.ts.
 */
import { Types } from "mongoose";
import { LlmUsage } from "../database/schema";
import { tenantJson, type WorkspaceTenant } from "./hatchet";

/** One step of one run, as Hatchet ran it. */
export interface StepWindow {
  workflowId: string;
  runId: string;
  step: string;
  start: number;
  end: number;
}

/** One recorded model call: when it ended, and how long it took. */
export interface RecordedCall {
  id: string;
  endedAt: number;
  durationMs?: number;
}

/** Recording lags the call a little; a step's times are to the second. */
const START_SLACK_MS = 2_000;
const END_SLACK_MS = 5_000;

export function matchCallsToSteps(calls: RecordedCall[], steps: StepWindow[]) {
  const matched: Array<{ call: RecordedCall; step: StepWindow }> = [];
  const ambiguous: RecordedCall[] = [];
  const unmatched: RecordedCall[] = [];
  for (const call of calls) {
    const startedAt = call.endedAt - (call.durationMs ?? 0);
    const within = (startSlack: number, endSlack: number) =>
      steps.filter(
        step =>
          startedAt >= step.start - startSlack &&
          call.endedAt <= step.end + endSlack,
      );
    const exact = within(0, 0);
    const inside =
      exact.length > 0 ? exact : within(START_SLACK_MS, END_SLACK_MS);
    if (inside.length === 1) matched.push({ call, step: inside[0] });
    else if (inside.length > 1) ambiguous.push(call);
    else unmatched.push(call);
  }
  return { matched, ambiguous, unmatched };
}

type Row = Record<string, unknown>;

/** The steps of a workspace's runs since `since`, with their run times. */
export async function readStepWindows(
  tenant: WorkspaceTenant,
  since: Date,
): Promise<StepWindow[]> {
  const runs = await tenantJson<{ rows?: Row[] }>(
    tenant,
    `/api/v1/stable/tenants/${tenant.tenantId}/workflow-runs`,
    {
      query: new URLSearchParams({
        since: since.toISOString(),
        only_tasks: "false",
        limit: "1000",
      }),
    },
  );
  const windows: StepWindow[] = [];
  for (const run of runs.rows ?? []) {
    const runId = (run.metadata as { id?: string } | undefined)?.id;
    if (!runId) continue;
    const detail = await tenantJson<{ tasks?: Row[] }>(
      tenant,
      `/api/v1/stable/workflow-runs/${runId}`,
    ).catch(() => ({ tasks: [] }) as { tasks?: Row[] });
    for (const task of detail.tasks ?? []) {
      const [workflowId, step] = String(task.actionId ?? "").split(":");
      const start = Date.parse(String(task.startedAt ?? ""));
      const end = Date.parse(String(task.finishedAt ?? ""));
      if (!workflowId || !step || !Number.isFinite(start)) continue;
      windows.push({
        workflowId,
        runId,
        step,
        start,
        // A step still running has no end yet: up to now.
        end: Number.isFinite(end) ? end : Date.now(),
      });
    }
  }
  return windows;
}

/** A workspace's workflow model calls since `since` that have no run yet. */
export async function readUnattributedCalls(
  workspaceId: string,
  since: Date,
): Promise<Array<RecordedCall & { costUsd: number }>> {
  const rows = await LlmUsage.find({
    workspaceId: new Types.ObjectId(workspaceId),
    invocationType: "workflow",
    workflowRun: { $exists: false },
    createdAt: { $gte: since },
  })
    .select("_id createdAt durationMs costUsd")
    .lean();
  return rows.map(row => ({
    id: String(row._id),
    endedAt: new Date(row.createdAt).getTime(),
    durationMs: row.durationMs,
    costUsd: row.costUsd ?? 0,
  }));
}

/** Save the matches, marked as matched afterwards. */
export async function saveMatches(
  matches: Array<{ call: RecordedCall; step: StepWindow }>,
): Promise<number> {
  if (matches.length === 0) return 0;
  const result = await LlmUsage.bulkWrite(
    matches.map(({ call, step }) => ({
      updateOne: {
        filter: {
          _id: new Types.ObjectId(call.id),
          workflowRun: { $exists: false },
        },
        update: {
          $set: {
            workflowRun: {
              workflowId: step.workflowId,
              runId: step.runId,
              step: step.step,
              backfilled: true,
            },
          },
        },
      },
    })),
  );
  return result.modifiedCount;
}
