/**
 * dbt command validation.
 *
 * Job/run commands are stored as plain strings ("build --select staging").
 * Before anything reaches the subprocess they are tokenized and validated
 * against an allowlist of subcommands and flags, so a stored job can never
 * smuggle --profiles-dir / --project-dir / arbitrary CLI surface into the
 * runner.
 */

const ALLOWED_SUBCOMMANDS = new Set([
  "run",
  "build",
  "test",
  "seed",
  "snapshot",
  "compile",
  "parse",
  "source",
  "docs",
  "deps",
  "retry",
  "show",
]);

/** Flags that take a value (the next token is consumed as the value). */
const VALUE_FLAGS = new Set([
  "--select",
  "-s",
  "--exclude",
  "--selector",
  "--threads",
  "--vars",
  "--limit",
  "--output",
  "--indirect-selection",
]);

/**
 * Value flags whose value must be one of a fixed set. dbt requires a value
 * for `--indirect-selection`; the bare flag used to pass validation here and
 * then fail inside dbt.
 */
const ENUM_VALUE_FLAGS = new Map<string, readonly string[]>([
  ["--indirect-selection", ["eager", "cautious", "buildable", "empty"]],
]);

/**
 * Value flags that take one OR MORE values, as dbt's own CLI does
 * (`--select a b c` is the union of a, b and c). Every following token up to
 * the next flag is a value. Without this, a job file written the way dbt's
 * docs write it was rejected as "Unexpected token", and a job merged on
 * GitHub that way never got a scheduler row.
 */
const MULTI_VALUE_FLAGS = new Set(["--select", "-s", "--exclude"]);

/** Boolean flags. */
const BOOLEAN_FLAGS = new Set([
  "--full-refresh",
  "--fail-fast",
  "--store-failures",
  "--empty",
  "--favor-state",
]);

export interface ParsedDbtCommand {
  /** argv tokens, e.g. ["run", "--select", "stg_orders"] */
  argv: string[];
  /** The dbt subcommand ("run", "build", ...). */
  subcommand: string;
}

/**
 * Subcommands that write into the warehouse target schema. `test` is
 * read-only unless `--store-failures` persists audit tables; `retry` resumes
 * whatever (possibly writing) command originally failed.
 */
const WAREHOUSE_WRITE_SUBCOMMANDS = new Set([
  "run",
  "build",
  "seed",
  "snapshot",
  "retry",
]);

/** Whether a validated command writes to the warehouse target schema. */
export function isWarehouseWriteCommand(parsed: ParsedDbtCommand): boolean {
  if (WAREHOUSE_WRITE_SUBCOMMANDS.has(parsed.subcommand)) return true;
  return (
    parsed.subcommand === "test" && parsed.argv.includes("--store-failures")
  );
}

export class DbtCommandValidationError extends Error {}

const WHITESPACE = /\s/;

/**
 * Split a stored command into argv tokens.
 *
 * Tokens are separated by whitespace. A token that STARTS with `'` or `"` is
 * a quoted token: it runs to the matching quote, keeps its spaces, and loses
 * the quotes, so `--vars '{"a": 1}'` is one value. Inside double quotes `\"`
 * and `\\` are escapes; single quotes are literal throughout.
 *
 * A quote in the middle of a token stays a literal character. That keeps
 * every command that parsed before parsing the same way: `--vars {"a":1}`
 * (the only form that worked with the old whitespace split) still reaches dbt
 * with its JSON quotes intact.
 */
export function tokenizeDbtCommand(command: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < command.length) {
    if (WHITESPACE.test(command[i])) {
      i++;
      continue;
    }
    const quote = command[i];
    if (quote !== "'" && quote !== '"') {
      const start = i;
      while (i < command.length && !WHITESPACE.test(command[i])) i++;
      tokens.push(command.slice(start, i));
      continue;
    }
    let value = "";
    let closed = false;
    i++;
    while (i < command.length) {
      const char = command[i];
      if (char === quote) {
        closed = true;
        i++;
        break;
      }
      const next = command[i + 1];
      if (quote === '"' && char === "\\" && (next === '"' || next === "\\")) {
        value += next;
        i += 2;
        continue;
      }
      value += char;
      i++;
    }
    if (!closed) {
      throw new DbtCommandValidationError(
        `Unterminated ${quote} quote in dbt command`,
      );
    }
    if (i < command.length && !WHITESPACE.test(command[i])) {
      throw new DbtCommandValidationError(
        `A closing ${quote} quote must be followed by a space in dbt commands`,
      );
    }
    if (value.length === 0) {
      throw new DbtCommandValidationError("Empty quoted value in dbt command");
    }
    tokens.push(value);
  }
  return tokens;
}

/**
 * Validate one stored command string. Throws DbtCommandValidationError with a
 * human-readable message when the command is not allowed.
 */
export function parseDbtCommand(command: string): ParsedDbtCommand {
  const tokens = tokenizeDbtCommand(command);
  if (tokens.length === 0) {
    throw new DbtCommandValidationError("Empty dbt command");
  }

  const subcommand = tokens[0];
  if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new DbtCommandValidationError(
      `dbt subcommand "${subcommand}" is not allowed. Allowed: ${[...ALLOWED_SUBCOMMANDS].join(", ")}`,
    );
  }

  let rest = tokens.slice(1);
  if (subcommand === "source") {
    if (rest[0] !== "freshness") {
      throw new DbtCommandValidationError(
        'Only "source freshness" is supported',
      );
    }
    rest = rest.slice(1);
  }
  if (subcommand === "docs") {
    if (rest[0] !== "generate") {
      throw new DbtCommandValidationError('Only "docs generate" is supported');
    }
    rest = rest.slice(1);
  }

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith("-")) {
      if (VALUE_FLAGS.has(token)) {
        const value = rest[i + 1];
        if (value === undefined || value.startsWith("-")) {
          throw new DbtCommandValidationError(`Flag ${token} requires a value`);
        }
        const allowedValues = ENUM_VALUE_FLAGS.get(token);
        if (allowedValues && !allowedValues.includes(value)) {
          throw new DbtCommandValidationError(
            `Flag ${token} must be one of: ${allowedValues.join(", ")} (got "${value}")`,
          );
        }
        i++;
        if (MULTI_VALUE_FLAGS.has(token)) {
          while (i + 1 < rest.length && !rest[i + 1].startsWith("-")) i++;
        }
        continue;
      }
      if (BOOLEAN_FLAGS.has(token)) continue;
      throw new DbtCommandValidationError(
        `Flag "${token}" is not allowed in dbt commands`,
      );
    }
    // Bare selector token (e.g. "dbt run my_model" style, or a second value
    // after a single-value flag) — reject so all selections go through
    // --select explicitly.
    throw new DbtCommandValidationError(
      `Unexpected token "${token}" — use --select for node selection`,
    );
  }

  const argv =
    subcommand === "source"
      ? ["source", "freshness", ...rest]
      : subcommand === "docs"
        ? ["docs", "generate", ...rest]
        : [subcommand, ...rest];

  return { argv, subcommand };
}

/** Validate a job's command list; returns parsed commands or throws. */
export function parseDbtCommands(commands: string[]): ParsedDbtCommand[] {
  if (commands.length === 0) {
    throw new DbtCommandValidationError("At least one dbt command is required");
  }
  return commands.map(parseDbtCommand);
}
