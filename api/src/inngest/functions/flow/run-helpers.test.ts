import assert from "node:assert/strict";
import { selectEntitiesToSync } from "./connector-source";
import { isCancellationError } from "./failure";
import {
  normalizeBackfillEntities,
  resolveRunTriggerType,
} from "./run-context";

// Trigger type: explicit wins, else noJitter means a manual run.
assert.equal(
  resolveRunTriggerType({ triggerType: "schedule", noJitter: true }),
  "schedule",
);
assert.equal(resolveRunTriggerType({ triggerType: "manual" }), "manual");
assert.equal(resolveRunTriggerType({ noJitter: true }), "manual");
assert.equal(resolveRunTriggerType({}), "schedule");

assert.deepEqual(
  normalizeBackfillEntities([" charges ", "charges", "", 3, "customers"]),
  ["charges", "customers"],
);
assert.deepEqual(normalizeBackfillEntities("charges"), []);

const available = ["charges", "customers", "invoices"];

// No explicit selection: everything, or the backfill scope.
assert.deepEqual(
  selectEntitiesToSync({
    availableEntities: available,
    configuredEntities: [],
    hasExplicitSelection: false,
    backfill: false,
    scopedBackfillEntities: ["charges"],
  }),
  available,
  "a scope only applies to a backfill",
);
assert.deepEqual(
  selectEntitiesToSync({
    availableEntities: available,
    configuredEntities: [],
    hasExplicitSelection: false,
    backfill: true,
    scopedBackfillEntities: ["charges"],
  }),
  ["charges"],
);
assert.throws(
  () =>
    selectEntitiesToSync({
      availableEntities: available,
      configuredEntities: [],
      hasExplicitSelection: false,
      backfill: true,
      scopedBackfillEntities: ["refunds"],
    }),
  /Invalid backfill scope entities: refunds\. Available entities/,
);

// Explicit selection: validated against the connector, scope within it.
assert.deepEqual(
  selectEntitiesToSync({
    availableEntities: available,
    configuredEntities: ["charges", "invoices"],
    hasExplicitSelection: true,
    backfill: false,
    scopedBackfillEntities: [],
  }),
  ["charges", "invoices"],
);
assert.throws(
  () =>
    selectEntitiesToSync({
      availableEntities: available,
      configuredEntities: ["charges", "payouts"],
      hasExplicitSelection: true,
      backfill: false,
      scopedBackfillEntities: [],
    }),
  /Invalid entities: payouts\./,
);
assert.throws(
  () =>
    selectEntitiesToSync({
      availableEntities: available,
      configuredEntities: ["charges"],
      hasExplicitSelection: true,
      backfill: true,
      scopedBackfillEntities: ["customers"],
    }),
  /Configured entities: charges/,
);

// Cancellation, under every name Inngest uses.
const err = (name: string, message = "x", code?: string) =>
  Object.assign(new Error(message), { name, code });
assert.ok(isCancellationError(err("InngestFunctionCancelledError")));
assert.ok(isCancellationError(err("Error", "x", "FUNCTION_CANCELLED")));
assert.ok(
  isCancellationError(err("Error", "Flow execution cancelled by user")),
);
assert.ok(isCancellationError(err("Error", "request canceled")));
assert.ok(!isCancellationError(err("Error", "connection reset")));

console.log("flow run helpers: all assertions passed");
