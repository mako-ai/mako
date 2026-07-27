/**
 * Session-scoped history for the dbt editor's Commands tab.
 *
 * Every explicit invocation the user triggers from the editor (Preview,
 * Compile, Build/Run/Test, the command bar) is appended here so the panel can
 * show dbt Cloud's list-plus-detail layout: a rail of past commands on the
 * left, the selected one's status / logs / node results on the right. History
 * lives in component state only — warehouse-writing commands are separately
 * persisted to run history by the API, and replaying a compile from three tabs
 * ago is not a thing anyone wants.
 */

import type { DbtRunLogLine, DbtStepResult } from "../store/dbtStore";

export interface DbtCommandInvocation {
  id: string;
  /** Command without the `dbt` prefix, e.g. `run --select stg_orders`. */
  command: string;
  environment: string;
  startedAt: number;
  /** Absent while the command is still in flight. */
  durationMs?: number;
  status: "running" | "success" | "error";
  logs: DbtRunLogLine[];
  stepResults: DbtStepResult[];
}

/** Counters mirroring dbt Cloud's All / Pass / Warn / Error / Skip / Running. */
export interface DbtStepCounts {
  all: number;
  pass: number;
  warn: number;
  error: number;
  skip: number;
  running: number;
}

/**
 * dbt's per-node `status` strings vary by resource type: models report
 * success/error, tests report pass/fail/warn, anything unselected-but-required
 * reports skipped. Fold them into the six buckets the counter row shows.
 */
export function stepCountBucket(
  status: string,
): "pass" | "warn" | "error" | "skip" | "running" | null {
  switch (status.toLowerCase()) {
    case "success":
    case "pass":
    case "partial success":
      return "pass";
    case "warn":
      return "warn";
    case "error":
    case "fail":
    case "runtime error":
      return "error";
    case "skipped":
    case "skip":
      return "skip";
    case "running":
    case "started":
      return "running";
    default:
      return null;
  }
}

export function countDbtSteps(steps: DbtStepResult[]): DbtStepCounts {
  const counts: DbtStepCounts = {
    all: steps.length,
    pass: 0,
    warn: 0,
    error: 0,
    skip: 0,
    running: 0,
  };
  for (const step of steps) {
    const bucket = stepCountBucket(step.status);
    if (bucket) counts[bucket] += 1;
  }
  return counts;
}

/** Max invocations kept in the rail; older ones drop off. */
export const DBT_COMMAND_HISTORY_LIMIT = 30;

/** Newest-first append, capped at DBT_COMMAND_HISTORY_LIMIT. */
export function appendInvocation(
  history: DbtCommandInvocation[],
  entry: DbtCommandInvocation,
): DbtCommandInvocation[] {
  return [entry, ...history].slice(0, DBT_COMMAND_HISTORY_LIMIT);
}

/** Replace one invocation in place (used to settle a `running` entry). */
export function settleInvocation(
  history: DbtCommandInvocation[],
  id: string,
  patch: Partial<DbtCommandInvocation>,
): DbtCommandInvocation[] {
  return history.map(entry =>
    entry.id === id ? { ...entry, ...patch } : entry,
  );
}
