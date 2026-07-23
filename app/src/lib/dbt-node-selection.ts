/**
 * dbt node-selection helpers — build `--select` strings with graph operators
 * for the Build/Run/Test/Preview menu. Pure + unit-tested.
 *
 * Scope maps to dbt's `+` operators:
 *   ""     → node only          (model)
 *   "down" → node + children    (model+)
 *   "up"   → parents + node     (+model)
 *   "both" → parents+node+child (+model+)
 *
 * @see https://docs.getdbt.com/reference/node-selection/graph-operators
 */

export type DbtRunVerb = "build" | "run" | "test" | "show";
export type DbtSelectScope = "" | "down" | "up" | "both";

/** Default row cap for Preview (`dbt show --limit`). */
export const DBT_SHOW_DEFAULT_LIMIT = 100;

export function buildDbtSelectArg(
  modelName: string,
  scope: DbtSelectScope,
): string {
  const prefix = scope === "up" || scope === "both" ? "+" : "";
  const suffix = scope === "down" || scope === "both" ? "+" : "";
  return `${prefix}${modelName}${suffix}`;
}

/** Full dbt command body (no leading "dbt"), e.g. `build --select +foo+`. */
export function buildDbtNodeCommand(
  verb: DbtRunVerb,
  modelName: string,
  scope: DbtSelectScope,
  options?: { fullRefresh?: boolean; limit?: number },
): string {
  // Preview is always the single node — graph operators don't apply to show.
  if (verb === "show") {
    const limit = options?.limit ?? DBT_SHOW_DEFAULT_LIMIT;
    return `show --select ${modelName} --limit ${limit}`;
  }
  // --full-refresh only applies to commands that (re)build tables; `test`
  // rejects the flag.
  const fullRefresh =
    options?.fullRefresh && verb !== "test" ? " --full-refresh" : "";
  return `${verb} --select ${buildDbtSelectArg(modelName, scope)}${fullRefresh}`;
}
