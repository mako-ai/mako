import { describe, expect, it } from "vitest";
import {
  extractFilePath,
  languageForDbtPath,
  logsToProblems,
  modelNameForPath,
  modelNamesFromPaths,
} from "./dbt-editor-logic";
import type { DbtRunLogLine } from "../store/dbtStore";

function log(level: string, line: string): DbtRunLogLine {
  return { ts: new Date().toISOString(), level, line };
}

describe("extractFilePath", () => {
  it("pulls a path from parentheses", () => {
    expect(
      extractFilePath("Compilation Error in model x (models/stg.sql)"),
    ).toBe("models/stg.sql");
  });
  it("pulls a path after `path:`", () => {
    expect(extractFilePath("error path: models/marts/fct.yml here")).toBe(
      "models/marts/fct.yml",
    );
  });
  it("returns undefined when no path-like token is present", () => {
    expect(extractFilePath("generic failure")).toBeUndefined();
  });
});

describe("logsToProblems", () => {
  it("keeps only error/warn lines, dedups, and attaches file paths", () => {
    const problems = logsToProblems([
      log("info", "Running with dbt=1.9"),
      log("error", "Compilation Error (models/a.sql)"),
      log("error", "Compilation Error (models/a.sql)"), // dup → dropped
      log("warn", "deprecated config in models/b.yml path: models/b.yml"),
      log("debug", "noise"),
    ]);
    expect(problems).toEqual([
      {
        severity: "error",
        message: "Compilation Error (models/a.sql)",
        filePath: "models/a.sql",
      },
      {
        severity: "warn",
        message: "deprecated config in models/b.yml path: models/b.yml",
        filePath: "models/b.yml",
      },
    ]);
  });

  it("ignores blank messages", () => {
    expect(logsToProblems([log("error", "   ")])).toEqual([]);
  });
});

describe("languageForDbtPath", () => {
  it("maps extensions to Monaco languages", () => {
    expect(languageForDbtPath("models/a.sql")).toBe("jinja-sql");
    expect(languageForDbtPath("models/schema.yml")).toBe("yaml");
    expect(languageForDbtPath("models/schema.yaml")).toBe("yaml");
    expect(languageForDbtPath("README.md")).toBe("markdown");
    expect(languageForDbtPath("Makefile")).toBe("plaintext");
  });
});

describe("modelNamesFromPaths", () => {
  it("returns basenames of models/*.sql only", () => {
    expect(
      modelNamesFromPaths([
        "models/staging/stg_orders.sql",
        "models/fct.sql",
        "macros/util.sql",
        "models/schema.yml",
      ]),
    ).toEqual(["stg_orders", "fct"]);
  });
});

describe("modelNameForPath", () => {
  it("derives the model name for a models/*.sql path", () => {
    expect(modelNameForPath("models/staging/stg_orders.sql")).toBe(
      "stg_orders",
    );
  });
  it("returns null for non-model files", () => {
    expect(modelNameForPath("macros/util.sql")).toBeNull();
    expect(modelNameForPath("models/schema.yml")).toBeNull();
  });
});
