import { describe, expect, it } from "vitest";
import {
  DBT_COMMAND_HISTORY_LIMIT,
  appendInvocation,
  countDbtSteps,
  settleInvocation,
  stepCountBucket,
  type DbtCommandInvocation,
} from "./dbt-command-history";
import type { DbtStepResult } from "../store/dbtStore";

const step = (status: string): DbtStepResult => ({
  uniqueId: `model.p.${status}`,
  name: status,
  resourceType: "model",
  status,
  executionTimeMs: 1,
});

const invocation = (id: string): DbtCommandInvocation => ({
  id,
  command: `run --select ${id}`,
  environment: "dev",
  startedAt: 0,
  status: "running",
  logs: [],
  stepResults: [],
});

describe("stepCountBucket", () => {
  it("folds model, test and skip statuses into dbt Cloud's buckets", () => {
    expect(stepCountBucket("success")).toBe("pass");
    expect(stepCountBucket("pass")).toBe("pass");
    expect(stepCountBucket("partial success")).toBe("pass");
    expect(stepCountBucket("warn")).toBe("warn");
    expect(stepCountBucket("error")).toBe("error");
    expect(stepCountBucket("fail")).toBe("error");
    expect(stepCountBucket("runtime error")).toBe("error");
    expect(stepCountBucket("skipped")).toBe("skip");
  });

  it("is case-insensitive and ignores statuses it doesn't know", () => {
    expect(stepCountBucket("SUCCESS")).toBe("pass");
    expect(stepCountBucket("something-new")).toBeNull();
  });
});

describe("countDbtSteps", () => {
  it("counts every node under `all` even when its status is unrecognised", () => {
    const counts = countDbtSteps([
      step("success"),
      step("pass"),
      step("warn"),
      step("fail"),
      step("skipped"),
      step("mystery"),
    ]);
    expect(counts).toEqual({
      all: 6,
      pass: 2,
      warn: 1,
      error: 1,
      skip: 1,
      running: 0,
    });
  });

  it("zeroes out for an empty run", () => {
    expect(countDbtSteps([])).toEqual({
      all: 0,
      pass: 0,
      warn: 0,
      error: 0,
      skip: 0,
      running: 0,
    });
  });
});

describe("appendInvocation", () => {
  it("puts the newest command first", () => {
    const history = appendInvocation([invocation("a")], invocation("b"));
    expect(history.map(e => e.id)).toEqual(["b", "a"]);
  });

  it("caps the rail so a long session doesn't grow unbounded", () => {
    let history: DbtCommandInvocation[] = [];
    for (let i = 0; i < DBT_COMMAND_HISTORY_LIMIT + 5; i++) {
      history = appendInvocation(history, invocation(`c${i}`));
    }
    expect(history).toHaveLength(DBT_COMMAND_HISTORY_LIMIT);
    expect(history[0].id).toBe(`c${DBT_COMMAND_HISTORY_LIMIT + 4}`);
  });
});

describe("settleInvocation", () => {
  it("patches only the matching entry", () => {
    const history = [invocation("a"), invocation("b")];
    const settled = settleInvocation(history, "b", {
      status: "success",
      durationMs: 1200,
    });
    expect(settled[0]).toEqual(history[0]);
    expect(settled[1].status).toBe("success");
    expect(settled[1].durationMs).toBe(1200);
  });

  it("is a no-op when the id is gone (evicted by the cap)", () => {
    const history = [invocation("a")];
    expect(settleInvocation(history, "zz", { status: "error" })).toEqual(
      history,
    );
  });
});
