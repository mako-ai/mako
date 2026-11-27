/**
 * What workflows cost in AI: the model calls (and agent() turns) a deployed
 * run's steps made, as Mako recorded them (LlmUsage, with the run and step
 * the worker sent; routes/workflows.ts). Queries and compute are not
 * counted. Runs from before costs were recorded have none.
 */
import { usageStatsRepo } from "../repositories/usage-stats";

export interface StepCost {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface RunCost extends StepCost {
  /** Some calls were matched to the run afterwards, by time. */
  backfilled?: boolean;
  steps: Record<string, StepCost>;
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** The AI cost of each of these runs that has any, by run id. */
export async function readRunCosts(
  workspaceId: string,
  runIds: string[],
): Promise<Record<string, RunCost>> {
  if (runIds.length === 0) return {};
  const rows = await usageStatsRepo.readWorkflowRunCosts(workspaceId, runIds);
  const costs: Record<string, RunCost> = {};
  for (const row of rows) {
    const run = (costs[row.runId] ??= {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      steps: {},
    });
    run.costUsd = round(run.costUsd + row.costUsd);
    run.inputTokens += row.inputTokens;
    run.outputTokens += row.outputTokens;
    run.calls += row.calls;
    if (row.backfilled) run.backfilled = true;
    run.steps[row.step ?? ""] = {
      costUsd: round(row.costUsd),
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      calls: row.calls,
    };
  }
  return costs;
}

/** A workflow's AI cost over the last `days` days, in total and by day (UTC). */
export async function readWorkflowCost(
  workspaceId: string,
  workflowId: string,
  days: number,
) {
  const since = new Date(Date.now() - days * 864e5);
  const rows = await usageStatsRepo.readWorkflowDailyCosts(
    workspaceId,
    workflowId,
    since,
  );
  const byDay = rows.map(row => ({
    day: row.day,
    costUsd: round(row.costUsd),
    runs: row.runIds.length,
  }));
  const costUsd = round(byDay.reduce((sum, day) => sum + day.costUsd, 0));
  const runs = new Set(rows.flatMap(row => row.runIds)).size;
  return { workflowId, days, costUsd, runs, byDay };
}
