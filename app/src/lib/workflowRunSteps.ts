/**
 * A run's steps as the run page reads them: their colours, the failure and
 * what it left unrun, and the order they can run in.
 */
import { type WorkflowRunStep } from "../store/workflowsStore";

export const STEP_COLOR: Record<string, string> = {
  COMPLETED: "success.main",
  FAILED: "error.main",
  RUNNING: "primary.main",
  QUEUED: "primary.main",
  CANCELLED: "text.disabled",
  WAITING: "text.disabled",
};

export const firstLine = (text?: string) => (text ?? "").split("\n")[0];

/** The failed steps, and the steps left unrun because one before them failed. */
export function failureOf(steps: WorkflowRunStep[]) {
  const failed = steps.filter(step => step.status === "FAILED");
  const byName = new Map(steps.map(step => [step.step, step]));
  // The failed step a step waited for, directly or further back.
  const blockedBy = (
    step: WorkflowRunStep,
    seen = new Set<string>(),
  ): string | undefined => {
    for (const parent of step.parents ?? []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      const p = byName.get(parent);
      if (!p) continue;
      if (p.status === "FAILED") return parent;
      const further = blockedBy(p, seen);
      if (further) return further;
    }
    return undefined;
  };
  return { failed, blockedBy };
}

/** Columns: a step sits one column after the last step it waits for. */
export function columnsOf(steps: WorkflowRunStep[]): WorkflowRunStep[][] {
  if (!steps.some(step => step.parents?.length)) return steps.map(s => [s]);
  const byName = new Map(steps.map(step => [step.step, step]));
  const depth = new Map<string | undefined, number>();
  const depthOf = (step: WorkflowRunStep, path = new Set<string>()): number => {
    if (depth.has(step.step)) return depth.get(step.step) as number;
    if (step.step) path.add(step.step);
    const parents = (step.parents ?? [])
      .filter(name => !path.has(name))
      .map(name => byName.get(name))
      .filter((p): p is WorkflowRunStep => Boolean(p));
    const d = parents.length
      ? 1 + Math.max(...parents.map(p => depthOf(p, path)))
      : 0;
    depth.set(step.step, d);
    return d;
  };
  const columns: WorkflowRunStep[][] = [];
  for (const step of steps) (columns[depthOf(step)] ??= []).push(step);
  return columns.filter(Boolean);
}
