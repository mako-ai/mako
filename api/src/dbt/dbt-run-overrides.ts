/**
 * Per-run inputs of a manual job trigger: extra dbt vars and a full refresh.
 *
 * Both are validated here, against the commands the run will execute, and
 * live on the run only. Nothing in this file writes to a job definition.
 */
import type { IDbtRunOverrides } from "../database/workspace-schema";
import { DbtCommandValidationError, parseDbtCommand } from "./commands";

export type DbtRunOverrides = IDbtRunOverrides;

/** Extends the command error so existing 400 / tool-error handlers catch it. */
export class DbtRunOverridesError extends DbtCommandValidationError {}

export const MAX_RUN_VARS_KEYS = 50;
export const MAX_RUN_VARS_BYTES = 4096;
/** The vars object itself is level 1; `{ a: { b: 1 } }` is depth 2. */
export const MAX_RUN_VARS_DEPTH = 5;

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SUPPORTED_OVERRIDES = new Set(["vars", "fullRefresh"]);

/**
 * Subcommands where `--full-refresh` rebuilds something. dbt 1.9 also accepts
 * the flag on compile, show, retry and clone, where it rebuilds nothing, and
 * rejects it on snapshot and test.
 */
const FULL_REFRESH_SUBCOMMANDS = new Set(["run", "build", "seed"]);
const FULL_REFRESH_FLAG = "--full-refresh";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Throws unless `value` is JSON: no undefined, NaN, Date, class instance. */
function assertJsonValue(value: unknown, path: string, depth: number): void {
  if (value === null) return;
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new DbtRunOverridesError(`vars.${path} must be a finite number`);
  }
  if (Array.isArray(value) || isPlainObject(value)) {
    if (depth > MAX_RUN_VARS_DEPTH) {
      throw new DbtRunOverridesError(
        `vars.${path} is nested too deep (max ${MAX_RUN_VARS_DEPTH} levels)`,
      );
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        assertJsonValue(item, `${path}[${index}]`, depth + 1),
      );
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__") {
        throw new DbtRunOverridesError(`vars.${path} has a reserved key`);
      }
      assertJsonValue(item, `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw new DbtRunOverridesError(
    `vars.${path} must be JSON: a string, number, boolean, null, array or object`,
  );
}

function validateVars(raw: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) {
    throw new DbtRunOverridesError(
      'vars must be a JSON object, e.g. { "start_date": "2026-01-01" }',
    );
  }
  const keys = Object.keys(raw);
  if (keys.length === 0) return undefined;
  if (keys.length > MAX_RUN_VARS_KEYS) {
    throw new DbtRunOverridesError(
      `vars has ${keys.length} keys (max ${MAX_RUN_VARS_KEYS})`,
    );
  }
  for (const key of keys) {
    if (!VAR_NAME.test(key) || key === "__proto__") {
      throw new DbtRunOverridesError(
        `vars key "${key.slice(0, 64)}" is not a valid name: use letters, digits and _, starting with a letter or _`,
      );
    }
    // The vars object is level 1, so its values start at level 2.
    assertJsonValue(raw[key], key, 2);
  }
  const serialized = JSON.stringify(raw);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_RUN_VARS_BYTES) {
    throw new DbtRunOverridesError(
      `vars is ${bytes} bytes as JSON (max ${MAX_RUN_VARS_BYTES})`,
    );
  }
  // A detached copy: the caller's object never reaches the run document.
  return JSON.parse(serialized) as Record<string, unknown>;
}

/**
 * Validate untrusted trigger input against the job's commands. Returns the
 * normalized overrides, or undefined when the input overrides nothing
 * (`{}`, `{ vars: {} }`, `{ fullRefresh: false }`, null fields).
 *
 * Throws DbtRunOverridesError when:
 *  - an override other than `vars` / `fullRefresh` is given;
 *  - vars is not a plain JSON object, has over 50 keys, a key outside
 *    `[A-Za-z_][A-Za-z0-9_]*`, a non-JSON value, over 5 levels, or over
 *    4 KB serialized;
 *  - vars is given while a command already declares `--vars` (the runner
 *    keeps the command's own `--vars`, so the override would be dropped);
 *  - fullRefresh is not a boolean;
 *  - fullRefresh is true and no command is a run, build or seed.
 */
export function validateRunOverrides(
  input: { vars?: unknown; fullRefresh?: unknown } | undefined,
  commands: string[],
): DbtRunOverrides | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isPlainObject(input)) {
    throw new DbtRunOverridesError("Run overrides must be a JSON object");
  }
  for (const key of Object.keys(input)) {
    if (!SUPPORTED_OVERRIDES.has(key)) {
      throw new DbtRunOverridesError(
        `Unknown run override "${key.slice(0, 64)}". Supported: vars, fullRefresh`,
      );
    }
  }

  const vars =
    input.vars === undefined || input.vars === null
      ? undefined
      : validateVars(input.vars);

  const rawFullRefresh = input.fullRefresh ?? false;
  if (typeof rawFullRefresh !== "boolean") {
    throw new DbtRunOverridesError("fullRefresh must be true or false");
  }

  if (!vars && !rawFullRefresh) return undefined;

  const parsed = commands.map(parseDbtCommand);

  if (vars) {
    const declaring = commands.find((_command, index) =>
      parsed[index].argv.includes("--vars"),
    );
    if (declaring !== undefined) {
      throw new DbtRunOverridesError(
        `This job sets its own --vars in the command "${declaring}", so run vars would be ignored. ` +
          "Remove --vars from the job command (use the environment's vars for defaults) to pass vars per run.",
      );
    }
  }

  if (
    rawFullRefresh &&
    !parsed.some(command => FULL_REFRESH_SUBCOMMANDS.has(command.subcommand))
  ) {
    throw new DbtRunOverridesError(
      "fullRefresh applies to run, build and seed commands, and this job has none",
    );
  }

  const overrides: DbtRunOverrides = {};
  if (vars) overrides.vars = vars;
  if (rawFullRefresh) overrides.fullRefresh = true;
  return overrides;
}

/**
 * Append `--full-refresh` to run, build and seed commands that lack it.
 * Other commands are returned unchanged. The output passes
 * `parseDbtCommands`.
 */
export function applyFullRefresh(commands: string[]): string[] {
  return commands.map(command => {
    const parsed = parseDbtCommand(command);
    if (!FULL_REFRESH_SUBCOMMANDS.has(parsed.subcommand)) return command;
    if (parsed.argv.includes(FULL_REFRESH_FLAG)) return command;
    return `${command.trim()} ${FULL_REFRESH_FLAG}`;
  });
}
