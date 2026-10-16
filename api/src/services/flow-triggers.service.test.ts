import assert from "node:assert/strict";
import {
  isWebhookFlow,
  buildScheduledFlowSelection,
  connectorFlowCdcError,
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
  // CDC is the only engine for connector flows.
  assert.equal(resolveDefaultSyncEngine({ sourceType: "connector" }), "cdc");
  // Database (SQL query) sources keep their own write path and label.
  assert.equal(resolveDefaultSyncEngine({ sourceType: "database" }), "legacy");
}

function testConnectorFlowCdcError() {
  // A connector flow CDC can run: no error.
  assert.equal(
    connectorFlowCdcError({
      sourceType: "connector",
      hasTableDestination: true,
      destinationSupportsCdc: true,
    }),
    null,
  );
  // No table destination (the old Mongo-collection legacy path): refused.
  assert.match(
    connectorFlowCdcError({
      sourceType: "connector",
      hasTableDestination: false,
      destinationSupportsCdc: true,
    }) ?? "",
    /legacy sync engine has been removed/,
  );
  // Destination without a CDC adapter: refused.
  assert.match(
    connectorFlowCdcError({
      sourceType: "connector",
      hasTableDestination: true,
      destinationSupportsCdc: false,
    }) ?? "",
    /no CDC adapter/,
  );
  // Database sources are not engine flows.
  assert.equal(
    connectorFlowCdcError({
      sourceType: "database",
      hasTableDestination: false,
      destinationSupportsCdc: false,
    }),
    null,
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

function testIsWebhookFlow() {
  // Every flow created as a webhook flow keeps taking deliveries exactly as
  // before — even one whose endpoint was never stored.
  assert.equal(
    isWebhookFlow({ type: "webhook", webhookConfig: { enabled: true } }),
    true,
  );
  // A scheduled flow with only the Mongoose default is not one…
  assert.equal(
    isWebhookFlow({ type: "scheduled", webhookConfig: { enabled: true } }),
    false,
  );
  // …until webhooks are switched on (endpoint minted + enabled), whatever
  // its type: it keeps polling and takes deliveries on top.
  assert.equal(
    isWebhookFlow({
      type: "scheduled",
      schedule: { enabled: true, cron: "0 * * * *" },
      webhookConfig: { enabled: true, endpoint: "https://x/api/webhooks/w/f" },
    }),
    true,
  );
  assert.equal(
    isWebhookFlow({
      type: "scheduled",
      webhookConfig: { enabled: false, endpoint: "https://x/api/webhooks/w/f" },
    }),
    false,
    "switched off again: no deliveries",
  );
}

function main() {
  testIsWebhookFlow();
  testScheduledFlowTriggerSet();
  testWebhookFlowWithMongooseScheduleDefault();
  testScheduledFlowWithMongooseWebhookDefault();
  testHybridFlowIsScheduledForBackCompat();
  testNoTriggers();
  testDefaultSyncEngine();
  testConnectorFlowCdcError();
  testScheduledFlowSelection();
  // eslint-disable-next-line no-console
  console.log("flow-triggers.service tests passed");
}

main();
