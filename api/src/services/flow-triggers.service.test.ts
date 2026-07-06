import assert from "node:assert/strict";
import {
  buildScheduledFlowSelection,
  deriveFlowType,
  deriveTriggerSet,
  hasAnyTrigger,
  resolveDefaultSyncEngine,
} from "./flow-triggers.service";

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
  assert.equal(
    deriveFlowType({ schedule: { enabled: true, cron: "0 * * * *" } }),
    "scheduled",
  );
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

function testDefaultSyncEngine() {
  // Webhook flows are always CDC.
  assert.equal(
    resolveDefaultSyncEngine({
      flowType: "webhook",
      sourceType: "connector",
      hasTableDestination: true,
      destinationSupportsCdc: true,
    }),
    "cdc",
  );
  // Connector flows to CDC-capable table destinations default to CDC.
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
}

function testScheduledFlowSelection() {
  const selection = buildScheduledFlowSelection() as Record<string, any>;
  assert.equal(selection["schedule.enabled"], true);
  const cronCond = selection["schedule.cron"];
  assert.equal(cronCond.$exists, true);
  assert.equal(cronCond.$type, "string");
  // Whitespace-only crons must be excluded.
  assert.equal(cronCond.$not.test("   "), true);
  assert.equal(cronCond.$not.test("*/5 * * * *"), false);
  // No type partitioning — hybrids (webhook flows with a cron) are polled.
  assert.equal("type" in selection, false);
}

function main() {
  testScheduledFlowTriggerSet();
  testWebhookFlowWithMongooseScheduleDefault();
  testScheduledFlowWithMongooseWebhookDefault();
  testHybridFlowIsScheduledForBackCompat();
  testNoTriggers();
  testDefaultSyncEngine();
  testScheduledFlowSelection();
  // eslint-disable-next-line no-console
  console.log("flow-triggers.service tests passed");
}

main();
