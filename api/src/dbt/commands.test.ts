import { describe, expect, it } from "vitest";
import {
  DbtCommandValidationError,
  parseDbtCommand,
  parseDbtCommands,
} from "./commands";

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
