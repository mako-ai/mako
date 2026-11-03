/**
 * Shapes for the dbt read tools' results (dbt_get_run, read_dbt_project_tree).
 *
 * Both tools serve the in-product agent and external MCP clients. A
 * production project made them unusable: one job run returned 1,583 step
 * results (~200k characters) and the project tree listed ~1,500 file paths
 * plus every job's commands (~107k characters). A small project keeps the
 * shape it always had. A large one gets a summary by default, with options to
 * page or ask for everything.
 */
import type { DbtLogLine } from "../../dbt/runner.service";

/** At or under this many steps, `stepResults` lists every step as before. */
export const FULL_STEPS_THRESHOLD = 50;
/** Max steps listed in a summary (the non-success ones, worst first). */
export const SUMMARY_STEP_LIMIT = 50;
/** At or under this many files, the tree lists every path as before. */
export const FULL_TREE_THRESHOLD = 200;
/** Max paths returned for a `pathPrefix` listing. */
export const PREFIX_FILE_LIMIT = 1_000;

export type RunDetail = "summary" | "full";

export interface StepLike {
  name: string;
  resourceType: string;
  status: string;
  executionTimeMs: number;
  rowsAffected?: number;
  message?: string;
}

function stepView(step: StepLike) {
  return {
    name: step.name,
    resourceType: step.resourceType,
    status: step.status,
    executionTimeMs: step.executionTimeMs,
    rowsAffected: step.rowsAffected,
    message: step.message,
  };
}

/** dbt statuses that mean "look at this step". Order = severity. */
const ATTENTION_ORDER = ["error", "fail", "runtime error", "warn", "skipped"];

function attentionRank(status: string): number {
  const idx = ATTENTION_ORDER.indexOf(status.toLowerCase());
  return idx === -1 ? Number.POSITIVE_INFINITY : idx;
}

export function countStepsByStatus(steps: StepLike[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const step of steps) {
    counts[step.status] = (counts[step.status] ?? 0) + 1;
  }
  return counts;
}

/**
 * The step part of a dbt_get_run result.
 *
 * - `stepOffset`/`stepLimit` page through every step in run order.
 * - `full`, or a run with at most FULL_STEPS_THRESHOLD steps: every step.
 * - Otherwise the steps that need attention (error, fail, warn, skipped),
 *   worst first, capped at SUMMARY_STEP_LIMIT.
 *
 * `stepsTotal` and `stepCounts` are always exact.
 */
export function shapeStepResults(
  steps: StepLike[],
  opts: { detail?: RunDetail; stepOffset?: number; stepLimit?: number } = {},
) {
  const stepsTotal = steps.length;
  const stepCounts = countStepsByStatus(steps);
  if (opts.stepOffset !== undefined || opts.stepLimit !== undefined) {
    const offset = opts.stepOffset ?? 0;
    const limit = opts.stepLimit ?? SUMMARY_STEP_LIMIT;
    const page = steps.slice(offset, offset + limit).map(stepView);
    return {
      stepsTotal,
      stepCounts,
      stepResults: page,
      stepPage: {
        offset,
        limit,
        ...(offset + page.length < stepsTotal
          ? { nextOffset: offset + page.length }
          : {}),
      },
    };
  }
  if (opts.detail === "full" || stepsTotal <= FULL_STEPS_THRESHOLD) {
    return { stepsTotal, stepCounts, stepResults: steps.map(stepView) };
  }
  const attention = steps
    .map((step, idx) => ({ step, idx, rank: attentionRank(step.status) }))
    .filter(entry => Number.isFinite(entry.rank))
    .sort((a, b) => a.rank - b.rank || a.idx - b.idx);
  return {
    stepsTotal,
    stepCounts,
    stepResults: attention
      .slice(0, SUMMARY_STEP_LIMIT)
      .map(entry => stepView(entry.step)),
    stepResultsTruncated: {
      shown: Math.min(attention.length, SUMMARY_STEP_LIMIT),
      attentionTotal: attention.length,
      note:
        "Summary: only steps that did not pass are listed. Pass " +
        'stepOffset/stepLimit to page through every step, or detail: "full".',
    },
  };
}

/**
 * Error and warning lines, deduplicated with a repeat count, then the last
 * `tail` lines of the log. A warning that a dozen packages print once each
 * (e.g. google-api-core's Python end-of-life FutureWarning) becomes one line.
 */
export function summarizeRunLogs(
  logs: DbtLogLine[],
  opts: { tail?: number; maxImportant?: number } = {},
): string[] {
  const tail = opts.tail ?? 10;
  const maxImportant = opts.maxImportant ?? 20;
  const important = new Map<string, number>();
  for (const log of logs) {
    if (log.level !== "error" && log.level !== "warn") continue;
    const key = `[${log.level}] ${log.line}`;
    important.set(key, (important.get(key) ?? 0) + 1);
  }
  // Errors before warnings; insertion order within each level.
  const ranked = [...important.entries()].sort(
    ([a], [b]) =>
      Number(b.startsWith("[error]")) - Number(a.startsWith("[error]")),
  );
  const lines = ranked
    .slice(0, maxImportant)
    .map(([line, count]) => (count > 1 ? `${line} (x${count})` : line));
  if (ranked.length > maxImportant) {
    lines.push(
      `[info] … ${ranked.length - maxImportant} more distinct error/warning lines`,
    );
  }
  if (tail > 0) {
    const rest = logs.filter(
      log => log.level !== "error" && log.level !== "warn",
    );
    for (const log of rest.slice(-tail)) {
      lines.push(`[${log.level}] ${log.line}`);
    }
  }
  return lines;
}

/**
 * The file part of a read_dbt_project_tree result.
 *
 * - `pathPrefix`: every path under it (capped at PREFIX_FILE_LIMIT).
 * - `full`, or a project with at most FULL_TREE_THRESHOLD files: every path.
 * - Otherwise the root-level files plus a per-directory file count, two
 *   levels deep (`models/staging: 318`).
 */
export function shapeTreeFiles(
  paths: string[],
  opts: { detail?: RunDetail; pathPrefix?: string } = {},
) {
  const filesTotal = paths.length;
  if (opts.pathPrefix) {
    const prefix = opts.pathPrefix.replace(/^\.?\/+/, "");
    const matching = paths.filter(p => p.startsWith(prefix));
    return {
      filesTotal,
      pathPrefix: prefix,
      files: matching.slice(0, PREFIX_FILE_LIMIT),
      ...(matching.length > PREFIX_FILE_LIMIT
        ? {
            filesTruncated: {
              shown: PREFIX_FILE_LIMIT,
              matching: matching.length,
              note: "Narrow pathPrefix to see the rest.",
            },
          }
        : {}),
    };
  }
  if (opts.detail === "full" || filesTotal <= FULL_TREE_THRESHOLD) {
    return { filesTotal, files: paths };
  }
  const directories = new Map<string, number>();
  const rootFiles: string[] = [];
  for (const p of paths) {
    const parts = p.split("/");
    if (parts.length === 1) {
      rootFiles.push(p);
      continue;
    }
    const dir = parts.slice(0, Math.min(2, parts.length - 1)).join("/");
    directories.set(dir, (directories.get(dir) ?? 0) + 1);
  }
  return {
    filesTotal,
    files: rootFiles,
    directories: [...directories.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, files]) => ({ path, files })),
    filesTruncated: {
      shown: rootFiles.length,
      note:
        "Summary: root files plus a file count per directory. Pass " +
        'pathPrefix (e.g. "models/staging/") to list a directory, or ' +
        'detail: "full" for every path.',
    },
  };
}
