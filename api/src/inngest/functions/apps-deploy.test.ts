import { describe, expect, it } from "vitest";
import {
  RECONCILE_FAILED_DEPLOY_BACKOFF_MS,
  shouldBackOffFromFailedDeploy,
} from "./apps-deploy";

const now = new Date("2026-09-15T20:17:00Z");
const failedAt = (msAgo: number) => new Date(now.getTime() - msAgo);

describe("shouldBackOffFromFailedDeploy (hourly reconcile)", () => {
  it("does not back off an app that never failed", () => {
    expect(
      shouldBackOffFromFailedDeploy({
        lastDeployError: null,
        appChangedSinceFailure: false,
        now,
      }),
    ).toBe(false);
  });

  it("backs off a recent failure of the same app content — the hourly re-enqueue that piled up 25 deploys", () => {
    expect(
      shouldBackOffFromFailedDeploy({
        lastDeployError: { sha: "95cd1e71", at: failedAt(60 * 60 * 1000) },
        appChangedSinceFailure: false,
        now,
      }),
    ).toBe(true);
  });

  it("retries once the app changed since the failed commit", () => {
    expect(
      shouldBackOffFromFailedDeploy({
        lastDeployError: { sha: "95cd1e71", at: failedAt(60 * 1000) },
        appChangedSinceFailure: true,
        now,
      }),
    ).toBe(false);
  });

  it("retries unchanged content after the backoff window (a transient failure recovers)", () => {
    expect(
      shouldBackOffFromFailedDeploy({
        lastDeployError: {
          sha: "95cd1e71",
          at: failedAt(RECONCILE_FAILED_DEPLOY_BACKOFF_MS + 1),
        },
        appChangedSinceFailure: false,
        now,
      }),
    ).toBe(false);
  });

  it("accepts the ISO string a step.run round-trip turns the date into", () => {
    expect(
      shouldBackOffFromFailedDeploy({
        lastDeployError: {
          sha: "95cd1e71",
          at: failedAt(5 * 60 * 1000).toISOString(),
        },
        appChangedSinceFailure: false,
        now,
      }),
    ).toBe(true);
  });
});
