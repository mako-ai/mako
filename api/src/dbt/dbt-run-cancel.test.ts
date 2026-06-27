import { describe, expect, it } from "vitest";
import { isTerminalDbtRunStatus } from "./dbt-run.service";
import type { DbtRunStatus } from "../database/workspace-schema";

describe("isTerminalDbtRunStatus", () => {
  it("treats success/error/cancelled as terminal", () => {
    for (const status of ["success", "error", "cancelled"] as DbtRunStatus[]) {
      expect(isTerminalDbtRunStatus(status)).toBe(true);
    }
  });

  it("treats queued/running as non-terminal (cancellable)", () => {
    for (const status of ["queued", "running"] as DbtRunStatus[]) {
      expect(isTerminalDbtRunStatus(status)).toBe(false);
    }
  });
});
