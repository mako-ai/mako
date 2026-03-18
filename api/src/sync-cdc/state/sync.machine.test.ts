import { createActor } from "xstate";
import type { SyncState } from "../../database/workspace-schema";
import {
  createSyncMachine,
  passesTransitionGuard,
  resolveCdcTransition,
  type CdcSyncEventType,
} from "./sync.machine";

describe("resolveCdcTransition", () => {
  it.each<
    [fromState: SyncState, eventType: CdcSyncEventType, toState: SyncState]
  >([
    ["idle", "START_BACKFILL", "backfill"],
    ["backfill", "BACKFILL_COMPLETE", "catchup"],
    ["catchup", "LAG_CLEARED", "live"],
    ["live", "LAG_SPIKE", "catchup"],
    ["idle", "PAUSE", "paused"],
    ["backfill", "PAUSE", "paused"],
    ["catchup", "PAUSE", "paused"],
    ["live", "PAUSE", "paused"],
    ["paused", "RESUME", "catchup"],
    ["backfill", "FAIL", "degraded"],
    ["catchup", "FAIL", "degraded"],
    ["live", "FAIL", "degraded"],
    ["paused", "FAIL", "degraded"],
    ["degraded", "RECOVER", "catchup"],
  ])(
    "returns %s for event %s from %s",
    (fromState, eventType, expectedToState) => {
      expect(resolveCdcTransition(fromState, eventType)).toBe(expectedToState);
    },
  );

  it("returns null for illegal transitions", () => {
    expect(resolveCdcTransition("idle", "RECOVER")).toBeNull();
    expect(resolveCdcTransition("degraded", "PAUSE")).toBeNull();
    expect(resolveCdcTransition("paused", "LAG_CLEARED")).toBeNull();
  });
});

describe("passesTransitionGuard", () => {
  it("rejects START_BACKFILL when there is an active run lock", () => {
    expect(
      passesTransitionGuard(
        { type: "START_BACKFILL" },
        { hasActiveRunLock: true },
      ),
    ).toBe(false);
  });

  it("allows START_BACKFILL when there is no active run lock", () => {
    expect(
      passesTransitionGuard(
        { type: "START_BACKFILL" },
        { hasActiveRunLock: false },
      ),
    ).toBe(true);
  });

  it("requires exhausted cursor for BACKFILL_COMPLETE", () => {
    expect(
      passesTransitionGuard(
        { type: "BACKFILL_COMPLETE" },
        { backfillCursorExhausted: false },
      ),
    ).toBe(false);
    expect(
      passesTransitionGuard(
        { type: "BACKFILL_COMPLETE" },
        { backfillCursorExhausted: true },
      ),
    ).toBe(true);
  });

  it("allows LAG_CLEARED only when backlog is empty and lag is healthy", () => {
    expect(
      passesTransitionGuard(
        { type: "LAG_CLEARED" },
        { backlogCount: 0, lagSeconds: 30, lagThresholdSeconds: 60 },
      ),
    ).toBe(true);
    expect(
      passesTransitionGuard(
        { type: "LAG_CLEARED" },
        { backlogCount: 0, lagSeconds: null, lagThresholdSeconds: 60 },
      ),
    ).toBe(true);
    expect(
      passesTransitionGuard(
        { type: "LAG_CLEARED" },
        { backlogCount: 1, lagSeconds: 1, lagThresholdSeconds: 60 },
      ),
    ).toBe(false);
    expect(
      passesTransitionGuard(
        { type: "LAG_CLEARED" },
        { backlogCount: 0, lagSeconds: 61, lagThresholdSeconds: 60 },
      ),
    ).toBe(false);
  });
});

describe("createSyncMachine", () => {
  function startMachine(input?: Parameters<typeof createSyncMachine>[0]) {
    const actor = createActor(createSyncMachine(input)).start();
    return actor;
  }

  it("follows the happy path to live", () => {
    const actor = startMachine({
      hasActiveRunLock: false,
      backfillCursorExhausted: true,
      backlogCount: 0,
      lagSeconds: 5,
      lagThresholdSeconds: 60,
    });

    expect(actor.getSnapshot().value).toBe("idle");
    actor.send({ type: "START_BACKFILL", reason: "manual" });
    expect(actor.getSnapshot().value).toBe("backfill");
    actor.send({ type: "BACKFILL_COMPLETE", reason: "cursor-exhausted" });
    expect(actor.getSnapshot().value).toBe("catchup");
    actor.send({ type: "LAG_CLEARED", reason: "healthy" });
    expect(actor.getSnapshot().value).toBe("live");
  });

  it("does not leave idle when START_BACKFILL guard fails", () => {
    const actor = startMachine({ hasActiveRunLock: true });
    actor.send({ type: "START_BACKFILL", reason: "should-be-blocked" });

    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.lastEvent).toBeUndefined();
  });

  it("does not leave backfill when BACKFILL_COMPLETE guard fails", () => {
    const actor = startMachine({
      hasActiveRunLock: false,
      backfillCursorExhausted: false,
    });

    actor.send({ type: "START_BACKFILL", reason: "manual" });
    expect(actor.getSnapshot().value).toBe("backfill");
    actor.send({ type: "BACKFILL_COMPLETE", reason: "premature" });
    expect(actor.getSnapshot().value).toBe("backfill");
  });

  it("pauses and resumes through catchup", () => {
    const actor = startMachine({
      hasActiveRunLock: false,
      backfillCursorExhausted: true,
      backlogCount: 0,
      lagSeconds: 10,
      lagThresholdSeconds: 60,
    });

    actor.send({ type: "START_BACKFILL" });
    actor.send({ type: "BACKFILL_COMPLETE" });
    actor.send({ type: "LAG_CLEARED" });
    expect(actor.getSnapshot().value).toBe("live");

    actor.send({ type: "PAUSE", reason: "operator" });
    expect(actor.getSnapshot().value).toBe("paused");
    actor.send({ type: "RESUME", reason: "operator" });
    expect(actor.getSnapshot().value).toBe("catchup");
  });

  it("stores fail metadata and supports recover", () => {
    const actor = startMachine({
      hasActiveRunLock: false,
      backfillCursorExhausted: true,
      backlogCount: 0,
      lagSeconds: 0,
      lagThresholdSeconds: 60,
    });

    actor.send({ type: "START_BACKFILL" });
    actor.send({ type: "BACKFILL_COMPLETE" });
    actor.send({ type: "LAG_CLEARED" });
    expect(actor.getSnapshot().value).toBe("live");

    actor.send({
      type: "FAIL",
      reason: "materializer failed",
      errorCode: "BQ_TIMEOUT",
      errorMessage: "merge operation timed out",
    });
    expect(actor.getSnapshot().value).toBe("degraded");
    expect(actor.getSnapshot().context.lastEvent).toBe("FAIL");
    expect(actor.getSnapshot().context.lastReason).toBe("materializer failed");
    expect(actor.getSnapshot().context.lastErrorCode).toBe("BQ_TIMEOUT");
    expect(actor.getSnapshot().context.lastErrorMessage).toBe(
      "merge operation timed out",
    );

    actor.send({ type: "RECOVER", reason: "retry ok" });
    expect(actor.getSnapshot().value).toBe("catchup");
  });
});
