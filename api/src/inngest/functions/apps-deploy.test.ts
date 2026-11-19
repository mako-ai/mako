import { describe, expect, it } from "vitest";
import {
  RECONCILE_FAILED_DEPLOY_BACKOFF_MS,
  appsDeployFunction,
  isInfraDeployFailure,
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

describe("apps-deploy concurrency", () => {
  it("builds at most 2 apps per workspace at once; the rest queue", () => {
    // A wave of 42 deploys on 18 Nov 2026 ran 2 at a time, as designed. The
    // queue time never counts against a build: timeouts are per command.
    const opts = (
      appsDeployFunction as unknown as {
        opts: { concurrency?: unknown };
      }
    ).opts;
    expect(opts.concurrency).toEqual([
      { key: "event.data.workspaceId", limit: 2 },
    ]);
  });
});

describe("the 6 h back-off is for the app's own failures only", () => {
  const recent = failedAt(10 * 60 * 1000);
  const backsOff = (stage: string, message: string) =>
    shouldBackOffFromFailedDeploy({
      lastDeployError: { sha: "0c671ea9", at: recent, stage, message },
      appChangedSinceFailure: false,
      now,
    });

  it.each([
    // The 19 failures of 18 Nov 2026, verbatim from the e2b SDK.
    "[deadline_exceeded] the operation timed out: This error is likely due to exceeding 'timeoutMs'",
    // A build cut off by its own deadline (buildApp appends this).
    "vite v6 building for production...\nTimeoutError: build did not finish in 300 s",
    // A worker lost to a Cloud Run rollout, or a box that went away.
    "socket hang up",
    "Unable to reach SDK URL",
    "[unavailable] the connection to sandbox i2ti8 ended before the stream completed",
    "Sandbox il2dc was not found: The sandbox was killed or reached its timeout.",
    // The memory gate's own refusal.
    "The publish box has 61 MB of memory free; a build needs 600 MB. Retrying shortly.",
  ])("does not back off an infra failure: %s", message => {
    expect(isInfraDeployFailure({ stage: "build", message })).toBe(true);
    expect(backsOff("build", message)).toBe(false);
  });

  it("backs off a real build error", () => {
    const message =
      "src/App.tsx(12,7): error TS2322: Type 'string' is not assignable to type 'number'.";
    expect(isInfraDeployFailure({ stage: "build", message })).toBe(false);
    expect(backsOff("build", message)).toBe(true);
  });

  it("backs off a binding failure whatever its message (warehouse cost)", () => {
    // 2026-09-14: one timing-out binding query re-ran 25 times in a day.
    const message = "Query timed out: [deadline_exceeded] after 600 s";
    expect(isInfraDeployFailure({ stage: "bindings", message })).toBe(false);
    expect(backsOff("bindings", message)).toBe(true);
  });
});
