import assert from "node:assert/strict";
import {
  buildScheduledFlowSelection,
  deriveFlowType,
  deriveTriggerSet,
  hasAnyTrigger,
  isUnifiedSyncFlowsEnabled,
  resolveDefaultSyncEngine,
} from "./flow-triggers.service";

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.UNIFIED_SYNC_FLOWS;
  if (value === undefined) {
    delete process.env.UNIFIED_SYNC_FLOWS;
  } else {
    process.env.UNIFIED_SYNC_FLOWS = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.UNIFIED_SYNC_FLOWS;
    } else {
      process.env.UNIFIED_SYNC_FLOWS = previous;
    }
  }
}

function testFlagDefaultsOff() {
  withFlag(undefined, () => {
    assert.equal(isUnifiedSyncFlowsEnabled(), false);
  });
  withFlag("false", () => {
    assert.equal(isUnifiedSyncFlowsEnabled(), false);
  });
  withFlag("true", () => {
    assert.equal(isUnifiedSyncFlowsEnabled(), true);
  });
}

function testScheduledFlowTriggerSet() {
  const triggers = deriveTriggerSet({
    type: "scheduled",
    schedule: { enabled: true, cron: "0 * * * *", timezone: "UTC" },
  });
  assert.deepEqual(triggers, {
    schedule: true,
    webhook: false,
    reconcile: false,
  });
  assert.equal(deriveFlowType({ schedule: { enabled: true, cron: "0 * * * *" } }), "scheduled");
}

function testWebhookFlowWithMongooseScheduleDefault() {
  // Mongoose materializes `schedule.enabled: true` (nested default) on webhook
  // flows even though they have no cron — that must NOT count as a poll
  // trigger.
  const flow = {
    type: "webhook" as const,
    schedule: { enabled: true, timezone: "UTC" },
    webhookConfig: { enabled: true },
  };
  const triggers = deriveTriggerSet(flow);
  assert.deepEqual(triggers, {
    schedule: false,
    webhook: true,
    reconcile: false,
  });
  assert.equal(deriveFlowType(flow), "webhook");
}

function testHybridFlowIsScheduledForBackCompat() {
  const flow = {
    schedule: { enabled: true, cron: "*/15 * * * *" },
    webhookConfig: { enabled: true },
    backfillSchedule: { enabled: true, cron: "0 3 * * *" },
  };
  const triggers = deriveTriggerSet(flow);
  assert.deepEqual(triggers, {
    schedule: true,
    webhook: true,
    reconcile: true,
  });
  assert.equal(deriveFlowType(flow), "scheduled");
  assert.equal(hasAnyTrigger(flow), true);
}

function testNoTriggers() {
  assert.equal(hasAnyTrigger({}), false);
  assert.equal(
    hasAnyTrigger({
      schedule: { enabled: false, cron: "0 * * * *" },
      webhookConfig: { enabled: false },
      backfillSchedule: { enabled: true, cron: "" },
    }),
    false,
  );
}

function testDefaultSyncEngineLegacyMode() {
  withFlag(undefined, () => {
    assert.equal(
      resolveDefaultSyncEngine({
        flowType: "webhook",
        sourceType: "connector",
        hasTableDestination: true,
        destinationSupportsCdc: true,
      }),
      "cdc",
    );
    // Scheduled flows stay legacy when the flag is off, even with a
    // CDC-capable destination.
    assert.equal(
      resolveDefaultSyncEngine({
        flowType: "scheduled",
        sourceType: "connector",
        hasTableDestination: true,
        destinationSupportsCdc: true,
      }),
      "legacy",
    );
  });
}

function testDefaultSyncEngineUnifiedMode() {
  withFlag("true", () => {
    assert.equal(
      resolveDefaultSyncEngine({
        flowType: "scheduled",
        sourceType: "connector",
        hasTableDestination: true,
        destinationSupportsCdc: true,
      }),
      "cdc",
    );
    // Non-CDC destination stays legacy.
    assert.equal(
      resolveDefaultSyncEngine({
        flowType: "scheduled",
        sourceType: "connector",
        hasTableDestination: true,
        destinationSupportsCdc: false,
      }),
      "legacy",
    );
    // Mongo collection destination (no tableDestination) stays legacy.
    assert.equal(
      resolveDefaultSyncEngine({
        flowType: "scheduled",
        sourceType: "connector",
        hasTableDestination: false,
        destinationSupportsCdc: true,
      }),
      "legacy",
    );
    // Database (SQL query) sources keep the legacy DB-sync path.
    assert.equal(
      resolveDefaultSyncEngine({
        flowType: "scheduled",
        sourceType: "database",
        hasTableDestination: true,
        destinationSupportsCdc: true,
      }),
      "legacy",
    );
  });
}

function testScheduledFlowSelection() {
  assert.deepEqual(buildScheduledFlowSelection(false), {
    type: "scheduled",
    "schedule.enabled": true,
  });
  assert.deepEqual(buildScheduledFlowSelection(true), {
    "schedule.enabled": true,
    "schedule.cron": { $exists: true, $nin: [null, ""] },
  });
}

function main() {
  testFlagDefaultsOff();
  testScheduledFlowTriggerSet();
  testWebhookFlowWithMongooseScheduleDefault();
  testHybridFlowIsScheduledForBackCompat();
  testNoTriggers();
  testDefaultSyncEngineLegacyMode();
  testDefaultSyncEngineUnifiedMode();
  testScheduledFlowSelection();
  // eslint-disable-next-line no-console
  console.log("flow-triggers.service tests passed");
}

main();
