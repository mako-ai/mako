import { describe, expect, it } from "vitest";

import {
  FULL_STEPS_THRESHOLD,
  FULL_TREE_THRESHOLD,
  SUMMARY_STEP_LIMIT,
  shapeStepResults,
  shapeTreeFiles,
  summarizeRunLogs,
} from "./dbt-tool-output";
import type { DbtLogLine } from "../../dbt/runner.service";

const step = (name: string, status: string, message?: string) => ({
  name,
  resourceType: "model",
  status,
  executionTimeMs: 10,
  message,
});

/** 1,583 steps, the size of the run that returned ~200k characters. */
function bigRun() {
  const steps = Array.from({ length: 1_580 }, (_, i) =>
    step(`m_${i}`, i % 2 ? "success" : "pass"),
  );
  steps.splice(100, 0, step("t_warned", "warn", "Got 3 results"));
  steps.splice(700, 0, step("m_broken", "error", "Syntax error"));
  steps.splice(900, 0, step("t_failed", "fail", "Got 12 results"));
  return steps;
}

describe("shapeStepResults", () => {
  it("lists every step on a small run, as before", () => {
    const steps = [step("a", "success"), step("b", "error", "boom")];
    const shaped = shapeStepResults(steps);
    expect(shaped.stepResults).toHaveLength(2);
    expect(shaped.stepsTotal).toBe(2);
    expect("stepResultsTruncated" in shaped).toBe(false);
  });

  it("summarizes a large run: exact counts, failing steps worst first", () => {
    const shaped = shapeStepResults(bigRun());
    expect(shaped.stepsTotal).toBe(1_583);
    expect(shaped.stepCounts).toEqual({
      pass: 790,
      success: 790,
      warn: 1,
      error: 1,
      fail: 1,
    });
    expect(shaped.stepResults.map(s => s.name)).toEqual([
      "m_broken",
      "t_failed",
      "t_warned",
    ]);
    expect(JSON.stringify(shaped).length).toBeLessThan(2_000);
  });

  it("caps the attention list", () => {
    const steps = Array.from({ length: 200 }, (_, i) => step(`e${i}`, "error"));
    const shaped = shapeStepResults(steps);
    expect(shaped.stepResults).toHaveLength(SUMMARY_STEP_LIMIT);
    expect(shaped.stepResultsTruncated?.attentionTotal).toBe(200);
  });

  it("pages every step in run order", () => {
    const steps = bigRun();
    const first = shapeStepResults(steps, { stepOffset: 0, stepLimit: 100 });
    expect(first.stepResults).toHaveLength(100);
    expect(first.stepPage).toEqual({ offset: 0, limit: 100, nextOffset: 100 });
    const last = shapeStepResults(steps, { stepOffset: 1_500, stepLimit: 100 });
    expect(last.stepResults).toHaveLength(83);
    expect(last.stepPage).toEqual({ offset: 1_500, limit: 100 });
  });

  it("returns everything with detail full", () => {
    const shaped = shapeStepResults(bigRun(), { detail: "full" });
    expect(shaped.stepResults).toHaveLength(1_583);
  });

  it("keeps the full listing at the threshold", () => {
    const steps = Array.from({ length: FULL_STEPS_THRESHOLD }, (_, i) =>
      step(`m${i}`, "success"),
    );
    expect(shapeStepResults(steps).stepResults).toHaveLength(
      FULL_STEPS_THRESHOLD,
    );
  });
});

describe("summarizeRunLogs", () => {
  const log = (level: string, line: string): DbtLogLine => ({
    ts: new Date(),
    level,
    line,
  });

  it("collapses a repeated warning into one line with a count", () => {
    const warning =
      "/opt/dbt/lib/python3.11/site-packages/google/api_core/_python_version_support.py:266: FutureWarning: You are using a Python version (3.11.2) which Google will stop supporting";
    const logs = [
      ...Array.from({ length: 16 }, () => log("warn", warning)),
      log("error", "Database Error in model m_broken"),
      ...Array.from({ length: 40 }, (_, i) => log("info", `line ${i}`)),
    ];
    const lines = summarizeRunLogs(logs, { tail: 3 });
    expect(lines).toEqual([
      "[error] Database Error in model m_broken",
      `[warn] ${warning} (x16)`,
      "[info] line 37",
      "[info] line 38",
      "[info] line 39",
    ]);
  });
});

describe("shapeTreeFiles", () => {
  const bigTree = [
    "dbt_project.yml",
    "packages.yml",
    ...Array.from({ length: 318 }, (_, i) => `models/staging/crm/stg_${i}.sql`),
    ...Array.from({ length: 353 }, (_, i) => `models/marts/fct_${i}.sql`),
    ...Array.from({ length: 16 }, (_, i) => `macros/m_${i}.sql`),
  ];

  it("lists every path on a small project, as before", () => {
    const shaped = shapeTreeFiles(["dbt_project.yml", "models/a.sql"]);
    expect(shaped.files).toEqual(["dbt_project.yml", "models/a.sql"]);
    expect("directories" in shaped).toBe(false);
  });

  it("summarizes a large project by directory", () => {
    expect(bigTree.length).toBeGreaterThan(FULL_TREE_THRESHOLD);
    const shaped = shapeTreeFiles(bigTree);
    expect(shaped.filesTotal).toBe(689);
    expect(shaped.files).toEqual(["dbt_project.yml", "packages.yml"]);
    expect("directories" in shaped && shaped.directories).toEqual([
      { path: "macros", files: 16 },
      { path: "models/marts", files: 353 },
      { path: "models/staging", files: 318 },
    ]);
  });

  it("lists one directory with pathPrefix", () => {
    const shaped = shapeTreeFiles(bigTree, { pathPrefix: "macros/" });
    expect(shaped.files).toHaveLength(16);
    expect(shaped.files[0]).toBe("macros/m_0.sql");
  });

  it("returns every path with detail full", () => {
    expect(shapeTreeFiles(bigTree, { detail: "full" }).files).toHaveLength(689);
  });
});
