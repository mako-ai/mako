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
]);

/** Boolean flags. */
const BOOLEAN_FLAGS = new Set([
  "--full-refresh",
  "--fail-fast",
  "--store-failures",
  "--empty",
  "--favor-state",
  "--indirect-selection",
]);

export interface ParsedDbtCommand {
  /** argv tokens, e.g. ["run", "--select", "stg_orders"] */
  argv: string[];
  /** The dbt subcommand ("run", "build", ...). */
  subcommand: string;
}

export class DbtCommandValidationError extends Error {}

function tokenize(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter(token => token.length > 0);
}

/**
 * Validate one stored command string. Throws DbtCommandValidationError with a
 * human-readable message when the command is not allowed.
 */
export function parseDbtCommand(command: string): ParsedDbtCommand {
  const tokens = tokenize(command);
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
        i++;
        continue;
      }
      if (BOOLEAN_FLAGS.has(token)) continue;
      throw new DbtCommandValidationError(
        `Flag "${token}" is not allowed in dbt commands`,
      );
    }
    // Bare selector token (e.g. "dbt run my_model" style) — reject so all
    // selections go through --select explicitly.
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
