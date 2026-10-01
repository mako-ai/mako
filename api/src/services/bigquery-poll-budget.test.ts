import { describe, expect, it } from "vitest";
import {
  BIGQUERY_RESULTS_WAIT_CAP_MS,
  createBigQueryPollBudget,
} from "./bigquery-poll-budget";

function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createBigQueryPollBudget", () => {
  it("expires on wall clock, counting the time BigQuery holds each poll open", () => {
    const c = clock();
    const budget = createBigQueryPollBudget(5 * 60 * 1000, c.now);
    let polls = 0;
    while (!budget.expired()) {
      c.advance(budget.sleepMs(1000));
      if (budget.expired()) break;
      // BigQuery answers only when the requested wait elapses (job still running).
      c.advance(budget.requestTimeoutMs());
      polls++;
    }
    // The old loop counted only the 1s sleeps: 300 polls x 11s = 55 minutes.
    expect(c.now()).toBe(5 * 60 * 1000);
    expect(polls).toBeLessThan(30);
  });

  it("never asks BigQuery to wait past the deadline or above the cap", () => {
    const c = clock();
    const budget = createBigQueryPollBudget(15_000, c.now);
    expect(budget.requestTimeoutMs()).toBe(BIGQUERY_RESULTS_WAIT_CAP_MS);
    c.advance(12_000);
    expect(budget.requestTimeoutMs()).toBe(3_000);
    expect(budget.sleepMs(5_000)).toBe(3_000);
    c.advance(3_000);
    expect(budget.expired()).toBe(true);
    expect(budget.sleepMs(1_000)).toBe(0);
  });
});
