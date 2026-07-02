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
    webhookConfig: { enabled: true, endpoint: "https://x/api/webhooks/abc" },
  };
  const triggers = deriveTriggerSet(flow);
  assert.deepEqual(triggers, {
    schedule: false,
    webhook: true,
    reconcile: false,
  });
  assert.equal(deriveFlowType(flow), "webhook");
}

function testScheduledFlowWithMongooseWebhookDefault() {
  // Mirror case: Mongoose also materializes `webhookConfig.enabled: true`
  // (nested default) on EVERY flow, including plain scheduled flows. Without
  // a provisioned endpoint that must NOT count as a webhook trigger —
  // otherwise a scheduled flow with its schedule toggled off would be
  // misclassified as webhook-only and refuse manual runs.
  const flow = {
    type: "scheduled" as const,
    schedule: { enabled: false, cron: "0 * * * *", timezone: "UTC" },
    webhookConfig: { enabled: true, totalReceived: 0 } as {
      enabled: boolean;
      endpoint?: string;
    },
  };
  const triggers = deriveTriggerSet(flow);
  assert.deepEqual(triggers, {
    schedule: false,
    webhook: false,
    reconcile: false,
  });
  assert.equal(deriveFlowType(flow), "scheduled");
  // Whitespace-only endpoint is also not a webhook trigger.
  assert.equal(
    deriveTriggerSet({ webhookConfig: { enabled: true, endpoint: "  " } })
      .webhook,
    false,
  );
}

function testHybridFlowIsScheduledForBackCompat() {
  const flow = {
    schedule: { enabled: true, cron: "*/15 * * * *" },
    webhookConfig: { enabled: true, endpoint: "https://x/api/webhooks/abc" },
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
  const unified = buildScheduledFlowSelection(true) as Record<string, any>;
  assert.equal(unified["schedule.enabled"], true);
  const cronCond = unified["schedule.cron"];
  assert.equal(cronCond.$exists, true);
  assert.equal(cronCond.$type, "string");
  // Whitespace-only crons must be excluded.
  assert.equal(cronCond.$not.test("   "), true);
  assert.equal(cronCond.$not.test("*/5 * * * *"), false);
}

function main() {
  testFlagDefaultsOff();
  testScheduledFlowTriggerSet();
  testWebhookFlowWithMongooseScheduleDefault();
  testScheduledFlowWithMongooseWebhookDefault();
  testHybridFlowIsScheduledForBackCompat();
  testNoTriggers();
  testDefaultSyncEngineLegacyMode();
  testDefaultSyncEngineUnifiedMode();
  testScheduledFlowSelection();
  // eslint-disable-next-line no-console
  console.log("flow-triggers.service tests passed");
}

main();
