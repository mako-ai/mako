import { describe, expect, it } from "vitest";
import { DbtCommandValidationError, parseDbtCommands } from "./commands";
import {
  applyFullRefresh,
  DbtRunOverridesError,
  MAX_RUN_VARS_BYTES,
  MAX_RUN_VARS_DEPTH,
  MAX_RUN_VARS_KEYS,
  validateRunOverrides,
} from "./dbt-run-overrides";

const COMMANDS = ["build --select staging"];

function nested(levels: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < levels; i++) value = { k: value };
  return value;
}

describe("validateRunOverrides: empty input", () => {
  it("returns undefined when nothing is overridden", () => {
    expect(validateRunOverrides(undefined, COMMANDS)).toBeUndefined();
    expect(validateRunOverrides({}, COMMANDS)).toBeUndefined();
    expect(validateRunOverrides({ vars: {} }, COMMANDS)).toBeUndefined();
    expect(
      validateRunOverrides({ fullRefresh: false }, COMMANDS),
    ).toBeUndefined();
    expect(
      validateRunOverrides(
        { vars: undefined, fullRefresh: undefined },
        COMMANDS,
      ),
    ).toBeUndefined();
    expect(
      validateRunOverrides({ vars: null, fullRefresh: null }, COMMANDS),
    ).toBeUndefined();
  });

  it("does not look at the commands when nothing is overridden", () => {
    expect(
      validateRunOverrides({ vars: {} }, ['run --vars {"a":1}', "bogus"]),
    ).toBeUndefined();
  });
});

describe("validateRunOverrides: vars", () => {
  it("accepts a JSON object and returns a detached copy", () => {
    const vars = {
      start_date: "2026-01-01",
      _days: 7,
      is_test: true,
      nothing: null,
      regions: ["emea", "apac"],
      window: { from: 1, to: { unit: "day" } },
    };
    const result = validateRunOverrides({ vars }, COMMANDS);
    expect(result).toEqual({ vars });
    expect(result?.vars).not.toBe(vars);
    expect(result?.vars?.window).not.toBe(vars.window);
    expect(result).not.toHaveProperty("fullRefresh");
  });

  it("rejects anything that is not a plain object", () => {
    for (const vars of [
      "a=1",
      '{"a":1}',
      7,
      true,
      ["a"],
      new Date(),
      new Map([["a", 1]]),
      () => 1,
    ]) {
      expect(() => validateRunOverrides({ vars }, COMMANDS)).toThrow(
        /vars must be a JSON object/,
      );
    }
  });

  it("rejects keys outside [A-Za-z_][A-Za-z0-9_]*", () => {
    for (const key of [
      "1day",
      "start-date",
      "start date",
      "a.b",
      "",
      "é",
      "--target",
      "a;b",
      "__proto__",
    ]) {
      const vars = JSON.parse(`{${JSON.stringify(key)}: 1}`) as unknown;
      expect(() => validateRunOverrides({ vars }, COMMANDS), key).toThrow(
        /is not a valid name/,
      );
    }
  });

  it(`accepts ${MAX_RUN_VARS_KEYS} keys and rejects one more`, () => {
    const make = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_unused, i) => [`k${i}`, i]),
      );
    expect(
      Object.keys(
        validateRunOverrides({ vars: make(MAX_RUN_VARS_KEYS) }, COMMANDS)
          ?.vars ?? {},
      ),
    ).toHaveLength(MAX_RUN_VARS_KEYS);
    expect(() =>
      validateRunOverrides({ vars: make(MAX_RUN_VARS_KEYS + 1) }, COMMANDS),
    ).toThrow(/51 keys \(max 50\)/);
  });

  it(`accepts ${MAX_RUN_VARS_BYTES} serialized bytes and rejects one more`, () => {
    // {"a":"<fill>"} is 8 bytes of JSON around the fill.
    const atLimit = { a: "x".repeat(MAX_RUN_VARS_BYTES - 8) };
    expect(JSON.stringify(atLimit)).toHaveLength(MAX_RUN_VARS_BYTES);
    expect(validateRunOverrides({ vars: atLimit }, COMMANDS)).toEqual({
      vars: atLimit,
    });
    expect(() =>
      validateRunOverrides(
        { vars: { a: "x".repeat(MAX_RUN_VARS_BYTES - 7) } },
        COMMANDS,
      ),
    ).toThrow(/4097 bytes as JSON \(max 4096\)/);
  });

  it("measures size in UTF-8 bytes, not characters", () => {
    // 1,400 three-byte characters: 1,400 chars but 4,200 bytes.
    expect(() =>
      validateRunOverrides({ vars: { a: "あ".repeat(1400) } }, COMMANDS),
    ).toThrow(/bytes as JSON/);
  });

  it(`accepts ${MAX_RUN_VARS_DEPTH} levels and rejects deeper`, () => {
    // vars itself is level 1, so its value may add 4 more object levels.
    const ok = { a: nested(MAX_RUN_VARS_DEPTH - 1) };
    expect(validateRunOverrides({ vars: ok }, COMMANDS)).toEqual({ vars: ok });
    expect(() =>
      validateRunOverrides(
        { vars: { a: nested(MAX_RUN_VARS_DEPTH) } },
        COMMANDS,
      ),
    ).toThrow(/nested too deep \(max 5 levels\)/);
    expect(() =>
      validateRunOverrides({ vars: { a: [[[[[1]]]]] } }, COMMANDS),
    ).toThrow(/nested too deep/);
  });

  it("rejects values that are not JSON", () => {
    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(),
      () => 1,
      BigInt(1),
      Symbol("s"),
    ]) {
      expect(() =>
        validateRunOverrides({ vars: { a: value } }, COMMANDS),
      ).toThrow(DbtRunOverridesError);
      expect(() =>
        validateRunOverrides({ vars: { a: { b: [value] } } }, COMMANDS),
      ).toThrow(DbtRunOverridesError);
    }
  });

  it("rejects a nested __proto__ key", () => {
    const vars = JSON.parse(
      '{"a": {"__proto__": {"polluted": true}}}',
    ) as unknown;
    expect(() => validateRunOverrides({ vars }, COMMANDS)).toThrow(
      /reserved key/,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects vars when a job command already carries --vars, and says why", () => {
    const commands = [
      "seed",
      `run --select a --vars '{"start_date": "2025-01-01"}'`,
    ];
    expect(() => validateRunOverrides({ vars: { a: 1 } }, commands)).toThrow(
      /sets its own --vars in the command "run --select a --vars .*run vars would be ignored/,
    );
    expect(() =>
      validateRunOverrides({ vars: { a: 1 } }, ['build --vars {"a":1}']),
    ).toThrow(DbtRunOverridesError);
    // fullRefresh alone is fine on the same job.
    expect(validateRunOverrides({ fullRefresh: true }, commands)).toEqual({
      fullRefresh: true,
    });
  });

  it("does not mistake a selector named like the flag for --vars", () => {
    expect(
      validateRunOverrides({ vars: { a: 1 } }, ["run --select my--vars"]),
    ).toEqual({ vars: { a: 1 } });
  });
});

describe("validateRunOverrides: fullRefresh", () => {
  it("accepts true for jobs with a run, build or seed command", () => {
    for (const command of ["run", "build --select a", "seed"]) {
      expect(
        validateRunOverrides({ fullRefresh: true }, ["test", command]),
      ).toEqual({ fullRefresh: true });
    }
  });

  it("rejects non-booleans", () => {
    for (const fullRefresh of ["true", 1, 0, "", {}, []]) {
      expect(() => validateRunOverrides({ fullRefresh }, COMMANDS)).toThrow(
        /fullRefresh must be true or false/,
      );
    }
  });

  it("rejects true when no command accepts a full refresh", () => {
    expect(() =>
      validateRunOverrides({ fullRefresh: true }, [
        "test",
        "snapshot",
        "source freshness",
      ]),
    ).toThrow(/applies to run, build and seed commands, and this job has none/);
  });

  it("returns both overrides together", () => {
    expect(
      validateRunOverrides({ vars: { a: 1 }, fullRefresh: true }, COMMANDS),
    ).toEqual({ vars: { a: 1 }, fullRefresh: true });
    expect(
      validateRunOverrides({ vars: { a: 1 }, fullRefresh: false }, COMMANDS),
    ).toEqual({ vars: { a: 1 } });
  });
});

describe("validateRunOverrides: shape and errors", () => {
  it("rejects unknown overrides and non-object input", () => {
    expect(() =>
      validateRunOverrides(
        { select: "a" } as unknown as { vars?: unknown },
        COMMANDS,
      ),
    ).toThrow(/Unknown run override "select"/);
    expect(() =>
      validateRunOverrides(["vars"] as unknown as { vars?: unknown }, COMMANDS),
    ).toThrow(/must be a JSON object/);
  });

  it("throws DbtRunOverridesError, a DbtCommandValidationError", () => {
    try {
      validateRunOverrides({ vars: [] }, COMMANDS);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DbtRunOverridesError);
      expect(error).toBeInstanceOf(DbtCommandValidationError);
    }
  });

  it("never mutates the input or the commands", () => {
    const input = Object.freeze({
      vars: Object.freeze({ a: Object.freeze({ b: 1 }) }),
      fullRefresh: true,
    });
    const commands = Object.freeze(["build --select a"]) as string[];
    expect(validateRunOverrides(input, commands)).toEqual({
      vars: { a: { b: 1 } },
      fullRefresh: true,
    });
    expect(commands).toEqual(["build --select a"]);
  });
});

describe("applyFullRefresh", () => {
  it("appends --full-refresh to run, build and seed", () => {
    expect(
      applyFullRefresh(["run --select a", "build", "seed --select s"]),
    ).toEqual([
      "run --select a --full-refresh",
      "build --full-refresh",
      "seed --select s --full-refresh",
    ]);
  });

  it("leaves every other subcommand unchanged", () => {
    const commands = [
      "test --select a",
      "snapshot",
      "compile --select a",
      "parse",
      "source freshness",
      "docs generate",
      "deps",
      "retry",
      "show --select a --limit 5",
    ];
    expect(applyFullRefresh(commands)).toEqual(commands);
  });

  it("never duplicates the flag", () => {
    const commands = [
      "run --full-refresh --select a",
      "build --select a b --full-refresh",
    ];
    expect(applyFullRefresh(commands)).toEqual(commands);
    const once = applyFullRefresh(["run --select a"]);
    expect(applyFullRefresh(once)).toEqual(once);
  });

  it("ends a multi-value --select and keeps quoted values intact", () => {
    const out = applyFullRefresh([
      "run --select a b c",
      `  build --vars '{"a": 1}'  `,
    ]);
    expect(out).toEqual([
      "run --select a b c --full-refresh",
      `build --vars '{"a": 1}' --full-refresh`,
    ]);
    expect(parseDbtCommands(out).map(command => command.argv)).toEqual([
      ["run", "--select", "a", "b", "c", "--full-refresh"],
      ["build", "--vars", '{"a": 1}', "--full-refresh"],
    ]);
  });

  it("does not treat a selector that contains the flag text as the flag", () => {
    expect(applyFullRefresh(["run --select 'x --full-refresh'"])).toEqual([
      "run --select 'x --full-refresh' --full-refresh",
    ]);
  });

  it("returns a new array and output that passes parseDbtCommands", () => {
    const commands = ["seed", "run --select a", "test"];
    const out = applyFullRefresh(commands);
    expect(out).not.toBe(commands);
    expect(commands).toEqual(["seed", "run --select a", "test"]);
    expect(() => parseDbtCommands(out)).not.toThrow();
  });

  it("rejects an invalid command instead of rewriting it", () => {
    expect(() => applyFullRefresh(["run --profiles-dir /etc"])).toThrow(
      DbtCommandValidationError,
    );
  });
});
