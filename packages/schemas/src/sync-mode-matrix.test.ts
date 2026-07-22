import assert from "node:assert/strict";
import {
  allowedModes,
  connectorSupportsIncremental,
  effectiveIncrementalMode,
  needsReconcileSuggestion,
  validateSyncConfig,
  type IncrementalCapabilities,
} from "./sync-mode-matrix";

const STRIPE: IncrementalCapabilities = {
  supported: true,
  mode: "created-anchor",
  warning: "Stripe polls miss updates",
};

const CLOSE: IncrementalCapabilities = {
  supported: true,
  mode: "native",
  perEntity: {
    users: { mode: "native", anchorField: "date_updated__gte" },
  },
};

const POSTHOG: IncrementalCapabilities = {
  supported: false,
  mode: "none",
};

const WISE: IncrementalCapabilities = {
  supported: true,
  mode: "none",
  perEntity: {
    transfers: { mode: "created-anchor", anchorField: "createdDateStart" },
    activities: { mode: "client-filter", anchorField: "createdOn" },
  },
  warning: "Wise transfer polls miss status updates",
};

function testEffectiveMode() {
  assert.equal(effectiveIncrementalMode(STRIPE, "customers"), "created-anchor");
  assert.equal(effectiveIncrementalMode(WISE, "transfers"), "created-anchor");
  assert.equal(effectiveIncrementalMode(WISE, "balances"), "none");
  assert.equal(
    effectiveIncrementalMode(CLOSE, "activities:Call"),
    "native",
  );
  assert.equal(effectiveIncrementalMode(undefined, "x"), "none");
}

function testAllowedModesHidesIncrementalForNone() {
  const result = allowedModes({
    incrementalCap: POSTHOG,
    selectedEntities: ["events"],
    destinationType: "bigquery",
  });
  assert.equal(result.connectorSupportsIncremental, false);
  assert.ok(result.combos.every(c => c.syncMode === "full"));
}

function testAllowedModesShowsIncrementalForWiseTransfers() {
  const result = allowedModes({
    incrementalCap: WISE,
    selectedEntities: ["transfers"],
    destinationType: "postgresql",
  });
  assert.equal(result.connectorSupportsIncremental, true);
  assert.ok(result.combos.some(c => c.syncMode === "incremental"));
  assert.ok(result.needsReconcileSuggestion);
}

function testAllowedModesHidesIncrementalForWiseSnapshotEntities() {
  const result = allowedModes({
    incrementalCap: WISE,
    selectedEntities: ["balances", "recipients"],
    destinationType: "postgresql",
  });
  assert.equal(result.connectorSupportsIncremental, false);
  assert.ok(result.combos.every(c => c.syncMode === "full"));
}

function testOverwriteBlockedWithWebhook() {
  const result = allowedModes({
    incrementalCap: STRIPE,
    selectedEntities: ["customers"],
    destinationType: "bigquery",
    webhookEnabled: true,
  });
  assert.ok(!result.combos.some(c => c.writeMode === "overwrite"));
}

function testValidateSyncConfigRejectsIncrementalNone() {
  const result = validateSyncConfig({
    syncMode: "incremental",
    writeMode: "append_dedup",
    syncEngine: "cdc",
    destinationType: "postgresql",
    webhookEnabled: false,
    selectedEntities: ["balances"],
    incremental: WISE,
  });
  assert.ok(result.error);
  assert.match(result.error || "", /incremental/i);
}

function testValidateSyncConfigWarnsCreatedAnchor() {
  const result = validateSyncConfig({
    syncMode: "incremental",
    writeMode: "append_dedup",
    syncEngine: "cdc",
    destinationType: "postgresql",
    webhookEnabled: false,
    selectedEntities: ["transfers"],
    incremental: WISE,
  });
  assert.equal(result.error, null);
  assert.ok(result.warnings.length >= 1);
  assert.ok(result.warnings.some(w => /Wise|created|webhook|reconcile/i.test(w)));
}

function testValidateSyncConfigAllowsExistingWhenNotEnforced() {
  const result = validateSyncConfig({
    syncMode: "incremental",
    syncEngine: "cdc",
    destinationType: "postgresql",
    webhookEnabled: false,
    selectedEntities: ["balances"],
    incremental: WISE,
    enforceIncrementalCapability: false,
  });
  assert.equal(result.error, null);
}

function testNeedsReconcile() {
  assert.equal(
    needsReconcileSuggestion("incremental", WISE, ["transfers"]),
    true,
  );
  assert.equal(
    needsReconcileSuggestion("full", WISE, ["transfers"]),
    false,
  );
  assert.equal(
    connectorSupportsIncremental(WISE, ["activities"]),
    true,
  );
}

function main() {
  testEffectiveMode();
  testAllowedModesHidesIncrementalForNone();
  testAllowedModesShowsIncrementalForWiseTransfers();
  testAllowedModesHidesIncrementalForWiseSnapshotEntities();
  testOverwriteBlockedWithWebhook();
  testValidateSyncConfigRejectsIncrementalNone();
  testValidateSyncConfigWarnsCreatedAnchor();
  testValidateSyncConfigAllowsExistingWhenNotEnforced();
  testNeedsReconcile();
}

main();
