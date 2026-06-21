import { describe, expect, it } from "vitest";
import { buildExtraDbtArgs } from "./runner.service";

describe("buildExtraDbtArgs — --defer/--state", () => {
  it("adds --defer --state for state-aware subcommands when a stateDir exists", () => {
    for (const sub of ["run", "build", "test", "compile", "seed", "snapshot"]) {
      expect(
        buildExtraDbtArgs({ subcommand: sub, argv: [sub], stateDir: "/s" }),
      ).toEqual(["--defer", "--state", "/s"]);
    }
  });

  it("omits defer args without a stateDir", () => {
    expect(
      buildExtraDbtArgs({ subcommand: "run", argv: ["run"], stateDir: null }),
    ).toEqual([]);
    expect(buildExtraDbtArgs({ subcommand: "run", argv: ["run"] })).toEqual([]);
  });

  it("omits defer args for non-state-aware subcommands (e.g. ls, parse)", () => {
    expect(
      buildExtraDbtArgs({ subcommand: "ls", argv: ["ls"], stateDir: "/s" }),
    ).toEqual([]);
  });
});

describe("buildExtraDbtArgs — environment --vars", () => {
  it("injects --vars as compact JSON when the env defines vars", () => {
    const out = buildExtraDbtArgs({
      subcommand: "run",
      argv: ["run"],
      vars: { start_date: "2024-01-01", is_test: true },
    });
    expect(out).toEqual([
      "--vars",
      JSON.stringify({ start_date: "2024-01-01", is_test: true }),
    ]);
  });

  it("skips --vars for empty/undefined var maps", () => {
    expect(
      buildExtraDbtArgs({ subcommand: "run", argv: ["run"], vars: {} }),
    ).toEqual([]);
    expect(buildExtraDbtArgs({ subcommand: "run", argv: ["run"] })).toEqual([]);
  });

  it("never injects --vars on retry (it replays prior argv)", () => {
    expect(
      buildExtraDbtArgs({
        subcommand: "retry",
        argv: ["retry"],
        vars: { a: 1 },
      }),
    ).toEqual([]);
  });

  it("does not double-inject when the command already supplies --vars", () => {
    expect(
      buildExtraDbtArgs({
        subcommand: "run",
        argv: ["run", "--vars", '{"a":1}'],
        vars: { b: 2 },
      }),
    ).toEqual([]);
  });

  it("combines defer + vars in that order", () => {
    expect(
      buildExtraDbtArgs({
        subcommand: "build",
        argv: ["build"],
        stateDir: "/s",
        vars: { a: 1 },
      }),
    ).toEqual(["--defer", "--state", "/s", "--vars", JSON.stringify({ a: 1 })]);
  });
});
