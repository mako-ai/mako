import assert from "node:assert/strict";
import {
  buildReconcileFlowSelection,
  buildScheduledFlowSelection,
  deriveFlowType,
  deriveLegacyScheduleMirrors,
  deriveTriggerSet,
  hasAnyTrigger,
  normalizeFlowScheduleList,
  resolveDefaultSyncEngine,
  resolveFlowSchedules,
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
  // Legacy `schedule` flows and `schedules[]` flows are both selected.
  const legacyBranch = selection.$or[0];
  assert.equal(legacyBranch["schedule.enabled"], true);
  const cronCond = legacyBranch["schedule.cron"];
  assert.equal(cronCond.$exists, true);
  assert.equal(cronCond.$type, "string");
  // Whitespace-only crons must be excluded.
  assert.equal(cronCond.$not.test("   "), true);
  assert.equal(cronCond.$not.test("*/5 * * * *"), false);
  const listBranch = selection.$or[1];
  assert.deepEqual(listBranch.schedules.$elemMatch.enabled, { $ne: false });
  // No type partitioning — hybrids (webhook flows with a cron) are polled.
  assert.equal("type" in selection, false);

  // Reconcile selection is kind-scoped on the list side.
  const reconcile = buildReconcileFlowSelection() as Record<string, any>;
  assert.equal(reconcile.$or[0]["backfillSchedule.enabled"], true);
  assert.equal(reconcile.$or[1].schedules.$elemMatch.kind, "reconcile");
}

function testScheduleListWinsOverLegacyFields() {
  const flow = {
    // Stale legacy fields must be ignored once the list exists.
    schedule: { enabled: true, cron: "0 * * * *" },
    backfillSchedule: { enabled: true, cron: "0 3 * * *" },
    schedules: [
      { id: "a", cron: "*/15 * * * *", kind: "poll" as const },
      {
        id: "b",
        cron: "0 4 * * 0",
        kind: "reconcile" as const,
        entities: ["customers", " invoices ", ""],
      },
      // Disabled rows never produce a trigger.
      { id: "c", enabled: false, cron: "0 5 * * *", kind: "poll" as const },
    ],
  };

  const resolved = resolveFlowSchedules(flow);
  assert.equal(resolved.length, 2);
  assert.deepEqual(
    resolved.map(s => [s.id, s.kind, s.origin]),
    [
      ["a", "poll", "list"],
      ["b", "reconcile", "list"],
    ],
  );
  assert.deepEqual(resolved[0].entities, []);
  assert.deepEqual(resolved[1].entities, ["customers", "invoices"]);
  assert.deepEqual(deriveTriggerSet(flow), {
    schedule: true,
    webhook: false,
    reconcile: true,
  });
}

function testLegacyFieldsProjectIntoScheduleRows() {
  const resolved = resolveFlowSchedules({
    schedule: { enabled: true, cron: "0 * * * *", timezone: "Europe/Zurich" },
    backfillSchedule: {
      enabled: true,
      cron: "0 3 * * *",
      lastRunAt: "2026-01-02T03:00:00.000Z",
    },
  });
  assert.deepEqual(
    resolved.map(s => [s.kind, s.cron, s.origin]),
    [
      ["poll", "0 * * * *", "schedule"],
      ["reconcile", "0 3 * * *", "backfillSchedule"],
    ],
  );
  assert.equal(resolved[0].timezone, "Europe/Zurich");
  // Legacy reconcile bookkeeping is preserved; the poll row keeps using the
  // flow-level lastRunAt, so it resolves to null here.
  assert.equal(resolved[0].lastRunAt, null);
  assert.equal(
    resolved[1].lastRunAt?.toISOString(),
    "2026-01-02T03:00:00.000Z",
  );
}

function testNormalizeScheduleList() {
  const bad = normalizeFlowScheduleList([{ cron: "not a cron" }], {
    generateId: () => "generated",
  });
  assert.equal(bad.ok, false);

  let counter = 0;
  const result = normalizeFlowScheduleList(
    [
      { cron: " 0 * * * * ", entities: ["a", "a", " b "] },
      {
        id: "kept",
        cron: "0 3 * * *",
        kind: "reconcile",
        timezone: "UTC",
        // Client-supplied lastRunAt must be ignored...
        lastRunAt: "2030-01-01T00:00:00.000Z",
      },
    ],
    {
      // ...while the stored value for the same id is carried over.
      previous: [
        {
          id: "kept",
          cron: "0 3 * * *",
          lastRunAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      generateId: () => `gen-${++counter}`,
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.schedules[0].id, "gen-1");
  assert.equal(result.schedules[0].kind, "poll");
  assert.deepEqual(result.schedules[0].entities, ["a", "b"]);
  assert.equal(result.schedules[0].lastRunAt, undefined);
  assert.equal(
    result.schedules[1].lastRunAt?.toISOString(),
    "2026-01-01T00:00:00.000Z",
  );

  const mirrors = deriveLegacyScheduleMirrors(result.schedules);
  assert.deepEqual(mirrors.schedule, {
    enabled: true,
    cron: "0 * * * *",
    timezone: "UTC",
  });
  assert.deepEqual(mirrors.backfillSchedule, {
    enabled: true,
    cron: "0 3 * * *",
    timezone: "UTC",
  });
  assert.deepEqual(deriveLegacyScheduleMirrors([]), {
    schedule: { enabled: false },
    backfillSchedule: { enabled: false },
  });
}

function main() {
  testScheduledFlowTriggerSet();
  testWebhookFlowWithMongooseScheduleDefault();
  testScheduledFlowWithMongooseWebhookDefault();
  testHybridFlowIsScheduledForBackCompat();
  testNoTriggers();
  testDefaultSyncEngine();
  testScheduledFlowSelection();
  testScheduleListWinsOverLegacyFields();
  testLegacyFieldsProjectIntoScheduleRows();
  testNormalizeScheduleList();
  // eslint-disable-next-line no-console
  console.log("flow-triggers.service tests passed");
}

main();
