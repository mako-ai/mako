import { describe, expect, it } from "vitest";
import {
  DbtCommandValidationError,
  isWarehouseWriteCommand,
  parseDbtCommand,
  parseDbtCommands,
  tokenizeDbtCommand,
} from "./commands";

/** The tokenizer before quotes were supported: a plain whitespace split. */
function legacyTokenize(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter(token => token.length > 0);
}

/**
 * Every command string the suites accepted before quote support, plus the
 * forms the docs show. None has a token that starts with a quote.
 */
const EXISTING_VALID_COMMANDS = [
  "run",
  "build",
  "deps",
  "retry",
  "parse",
  "seed",
  "snapshot",
  "source freshness",
  "docs generate",
  "build --select tag:nightly",
  "run --select +my_model+",
  "run --select stg_orders --exclude stg_users",
  "show --select stg_orders --limit 5",
  "show --select stg_orders --limit 500 --output json",
  "build --full-refresh --fail-fast",
  "run --select stg_reviews stg_teams stg_transactions --full-refresh",
  "build -s a b --exclude c d --threads 4",
  "run --select stg_orders",
  "build --select stg_orders+ --full-refresh",
  "compile --select stg_orders",
  "test --select stg_orders",
  "test --select stg_orders --store-failures",
  "build --select state:modified+ --favor-state",
  "run --selector nightly --empty",
  "  build   --select\tstaging  ",
  "run --select config.materialized:incremental,tag:daily",
  "run --select path:models/staging/*",
  // The one --vars form that worked before: unquoted JSON without spaces.
  'run --vars {"a":1}',
  'build --select a --vars {"start_date":"2026-01-01","flag":true}',
  "run --vars {a:1}",
  "run --select it's_fine",
];

describe("parseDbtCommand", () => {
  it("accepts plain subcommands", () => {
    expect(parseDbtCommand("run").argv).toEqual(["run"]);
    expect(parseDbtCommand("build").subcommand).toBe("build");
    expect(parseDbtCommand("deps").argv).toEqual(["deps"]);
    expect(parseDbtCommand("retry").argv).toEqual(["retry"]);
  });

  it("accepts selector flags including tag and graph operators", () => {
    expect(parseDbtCommand("build --select tag:nightly").argv).toEqual([
      "build",
      "--select",
      "tag:nightly",
    ]);
    expect(parseDbtCommand("run --select +my_model+").argv).toEqual([
      "run",
      "--select",
      "+my_model+",
    ]);
    expect(
      parseDbtCommand("run --select stg_orders --exclude stg_users").argv,
    ).toEqual(["run", "--select", "stg_orders", "--exclude", "stg_users"]);
  });

  it("accepts `show` with --select and --limit (preview tool)", () => {
    expect(parseDbtCommand("show --select stg_orders --limit 5").argv).toEqual([
      "show",
      "--select",
      "stg_orders",
      "--limit",
      "5",
    ]);
  });

  it("accepts allowed boolean flags", () => {
    expect(parseDbtCommand("build --full-refresh --fail-fast").argv).toEqual([
      "build",
      "--full-refresh",
      "--fail-fast",
    ]);
  });

  it("gates `source` to freshness and `docs` to generate", () => {
    expect(parseDbtCommand("source freshness").argv).toEqual([
      "source",
      "freshness",
    ]);
    expect(parseDbtCommand("docs generate").argv).toEqual(["docs", "generate"]);
    expect(() => parseDbtCommand("source")).toThrow(DbtCommandValidationError);
    expect(() => parseDbtCommand("docs serve")).toThrow(
      DbtCommandValidationError,
    );
  });

  it("rejects unknown subcommands", () => {
    expect(() => parseDbtCommand("run-operation foo")).toThrow(
      DbtCommandValidationError,
    );
    expect(() => parseDbtCommand("clean")).toThrow(DbtCommandValidationError);
  });

  it("rejects attempts to override profile/project dirs", () => {
    expect(() => parseDbtCommand("run --profiles-dir /etc")).toThrow(
      DbtCommandValidationError,
    );
    expect(() => parseDbtCommand("run --project-dir /tmp")).toThrow(
      DbtCommandValidationError,
    );
  });

  it("rejects bare node tokens (selection must use --select)", () => {
    expect(() => parseDbtCommand("run my_model")).toThrow(
      DbtCommandValidationError,
    );
  });

  it("accepts several space-separated selectors, as dbt does", () => {
    // A job written the way dbt's docs write it: it was refused and so
    // never got a scheduler row.
    expect(
      parseDbtCommand(
        "run --select stg_reviews stg_teams stg_transactions --full-refresh",
      ).argv,
    ).toEqual([
      "run",
      "--select",
      "stg_reviews",
      "stg_teams",
      "stg_transactions",
      "--full-refresh",
    ]);
    expect(
      parseDbtCommand("build -s a b --exclude c d --threads 4").argv,
    ).toEqual([
      "build",
      "-s",
      "a",
      "b",
      "--exclude",
      "c",
      "d",
      "--threads",
      "4",
    ]);
  });

  it("keeps single-value flags single and still screens trailing flags", () => {
    expect(() => parseDbtCommand("run --threads 4 my_model")).toThrow(
      DbtCommandValidationError,
    );
    expect(() => parseDbtCommand("run --selector a b")).toThrow(
      DbtCommandValidationError,
    );
    expect(() =>
      parseDbtCommand("run --select a b --profiles-dir /etc"),
    ).toThrow(DbtCommandValidationError);
  });

  it("rejects value flags missing their value", () => {
    expect(() => parseDbtCommand("run --select")).toThrow(
      DbtCommandValidationError,
    );
    expect(() => parseDbtCommand("run --select --full-refresh")).toThrow(
      DbtCommandValidationError,
    );
  });

  it("rejects empty commands", () => {
    expect(() => parseDbtCommand("")).toThrow(DbtCommandValidationError);
    expect(() => parseDbtCommands([])).toThrow(DbtCommandValidationError);
  });
});

describe("tokenizeDbtCommand", () => {
  it("tokenizes every previously valid command exactly as before", () => {
    for (const command of EXISTING_VALID_COMMANDS) {
      expect(tokenizeDbtCommand(command), command).toEqual(
        legacyTokenize(command),
      );
      // And the validator still accepts each one.
      expect(() => parseDbtCommand(command), command).not.toThrow();
    }
  });

  it("keeps a quote in the middle of a token literal", () => {
    expect(parseDbtCommand('run --vars {"a":1}').argv).toEqual([
      "run",
      "--vars",
      '{"a":1}',
    ]);
  });

  it("reads a single-quoted token as one value and drops the quotes", () => {
    expect(parseDbtCommand(`run --vars '{"a": 1}'`).argv).toEqual([
      "run",
      "--vars",
      '{"a": 1}',
    ]);
    expect(
      parseDbtCommand(
        `build --select staging --vars '{"start_date": "2026-01-01", "days": [1, 2]}' --full-refresh`,
      ).argv,
    ).toEqual([
      "build",
      "--select",
      "staging",
      "--vars",
      '{"start_date": "2026-01-01", "days": [1, 2]}',
      "--full-refresh",
    ]);
  });

  it("reads a double-quoted token with escaped quotes and backslashes", () => {
    expect(parseDbtCommand('run --vars "{\\"a\\": 1}"').argv).toEqual([
      "run",
      "--vars",
      '{"a": 1}',
    ]);
    expect(tokenizeDbtCommand('"a\\\\b"')).toEqual(["a\\b"]);
    // Any other backslash is literal, in and out of quotes.
    expect(tokenizeDbtCommand('"a\\nb" c\\d')).toEqual(["a\\nb", "c\\d"]);
  });

  it("keeps the other quote character and a backslash literal in single quotes", () => {
    expect(tokenizeDbtCommand(`'say "hi" \\ there'`)).toEqual([
      'say "hi" \\ there',
    ]);
    expect(tokenizeDbtCommand(`"it's"`)).toEqual(["it's"]);
  });

  it("accepts a quoted YAML --vars value and quoted selectors", () => {
    expect(parseDbtCommand("run --vars 'key: value'").argv).toEqual([
      "run",
      "--vars",
      "key: value",
    ]);
    expect(
      parseDbtCommand(`run --select "tag:nightly" 'stg_orders+'`).argv,
    ).toEqual(["run", "--select", "tag:nightly", "stg_orders+"]);
  });

  it("rejects an unterminated quote", () => {
    expect(() => parseDbtCommand(`run --vars '{"a": 1}`)).toThrow(
      /Unterminated ' quote/,
    );
    expect(() => parseDbtCommand('run --select "stg_orders')).toThrow(
      /Unterminated " quote/,
    );
  });

  it("rejects text glued to a closing quote and empty quoted values", () => {
    expect(() => parseDbtCommand("run --select 'a'b")).toThrow(
      /must be followed by a space/,
    );
    expect(() => parseDbtCommand("run --select ''")).toThrow(
      /Empty quoted value/,
    );
  });

  it("cannot smuggle a flag or a second value through quotes", () => {
    expect(() => parseDbtCommand("run --select '--profiles-dir'")).toThrow(
      DbtCommandValidationError,
    );
    expect(() => parseDbtCommand(`run "--profiles-dir" /etc`)).toThrow(
      DbtCommandValidationError,
    );
    expect(() => parseDbtCommand("run --vars '{}' extra")).toThrow(
      DbtCommandValidationError,
    );
    // One quoted token stays one argv entry, flags inside it included.
    expect(
      parseDbtCommand("run --select 'a --profiles-dir /etc'").argv,
    ).toEqual(["run", "--select", "a --profiles-dir /etc"]);
    expect(() => parseDbtCommand("'run-operation' foo")).toThrow(
      DbtCommandValidationError,
    );
  });
});

describe("--indirect-selection", () => {
  it("accepts each of dbt's four values", () => {
    for (const value of ["eager", "cautious", "buildable", "empty"]) {
      expect(
        parseDbtCommand(`build --select a --indirect-selection ${value}`).argv,
      ).toEqual(["build", "--select", "a", "--indirect-selection", value]);
    }
    expect(parseDbtCommand("test --indirect-selection cautious").argv).toEqual([
      "test",
      "--indirect-selection",
      "cautious",
    ]);
  });

  it("rejects the bare flag, which dbt rejects too", () => {
    expect(() => parseDbtCommand("build --indirect-selection")).toThrow(
      /--indirect-selection requires a value/,
    );
    expect(() =>
      parseDbtCommand("build --indirect-selection --full-refresh"),
    ).toThrow(/--indirect-selection requires a value/);
  });

  it("rejects a value outside the four, and a second value", () => {
    expect(() => parseDbtCommand("build --indirect-selection greedy")).toThrow(
      /must be one of: eager, cautious, buildable, empty/,
    );
    expect(() => parseDbtCommand("build --indirect-selection EAGER")).toThrow(
      DbtCommandValidationError,
    );
    expect(() =>
      parseDbtCommand("build --indirect-selection eager cautious"),
    ).toThrow(DbtCommandValidationError);
  });
});

describe("subcommand allowlist", () => {
  it("keeps run-operation rejected", () => {
    expect(() => parseDbtCommand("run-operation my_macro")).toThrow(
      /"run-operation" is not allowed/,
    );
    expect(() =>
      parseDbtCommand(`run-operation my_macro --args '{"a": 1}'`),
    ).toThrow(DbtCommandValidationError);
  });
});

describe("isWarehouseWriteCommand", () => {
  it("classifies run/build/seed/snapshot/retry as warehouse writes", () => {
    for (const command of [
      "run --select stg_orders",
      "build --select stg_orders+ --full-refresh",
      "seed",
      "snapshot",
      "retry",
    ]) {
      expect(isWarehouseWriteCommand(parseDbtCommand(command))).toBe(true);
    }
  });

  it("classifies parse/compile/show/docs/deps/source freshness as read-only", () => {
    for (const command of [
      "parse",
      "compile --select stg_orders",
      "show --select stg_orders --limit 5",
      "docs generate",
      "deps",
      "source freshness",
    ]) {
      expect(isWarehouseWriteCommand(parseDbtCommand(command))).toBe(false);
    }
  });

  it("treats test as read-only unless --store-failures persists tables", () => {
    expect(
      isWarehouseWriteCommand(parseDbtCommand("test --select stg_orders")),
    ).toBe(false);
    expect(
      isWarehouseWriteCommand(
        parseDbtCommand("test --select stg_orders --store-failures"),
      ),
    ).toBe(true);
  });
});
