/**
 * Flow config file format (RFC #904 block 2).
 *
 * The headline test is the exclusion one: the Flow schema interleaves
 * runtime state INSIDE definition objects, so a naive projection would
 * commit a moving cursor, a webhook secret, or the inbound endpoint. Every
 * trap is populated with a recognisable value and then asserted absent from
 * the serialized file.
 *
 * Run: npx tsx src/services/flow-config-files.test.ts
 */
import assert from "node:assert/strict";
import { Types } from "mongoose";

import {
  FLOWS_DIR,
  flowFilePath,
  flowToFile,
  parseFlowFile,
  serializeFlowFile,
  slugFromFlowFilePath,
} from "./flow-config-files";
import type { IFlow } from "../database/workspace-schema";

const connectorId = new Types.ObjectId();
const destId = new Types.ObjectId();
const tableConnId = new Types.ObjectId();

/** A flow with EVERY runtime trap populated with a traceable value. */
function flowWithTraps(): IFlow {
  return {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(),
    type: "webhook",
    name: "Stripe → Warehouse",
    slug: "stripe-warehouse",
    sourceType: "connector",
    dataSourceId: connectorId,
    destinationDatabaseId: destId,
    destinationDatabaseName: "analytics",
    tableDestination: {
      connectionId: tableConnId,
      database: "warehouse",
      schema: "public",
      tableName: "stripe_charges",
      createIfNotExists: true,
      partitioning: { enabled: true, type: "time", field: "created_at" },
      clustering: { enabled: true, fields: ["customer_id"] },
    },
    schedule: { enabled: true, cron: "0 * * * *", timezone: "Europe/Zurich" },
    backfillSchedule: {
      enabled: true,
      cron: "0 3 * * *",
      timezone: "UTC",
      // TRAP: scheduler claim state
      lastRunAt: new Date("2026-08-30T03:00:00Z"),
    },
    webhookConfig: {
      enabled: true,
      // TRAPS: identity + credential + counters
      endpoint: "https://app.mako.ai/api/webhooks/TRAP-ENDPOINT-ID",
      secret: "whsec_TRAP_SECRET_VALUE",
      lastReceivedAt: new Date("2026-08-31T10:00:00Z"),
      totalReceived: 4321,
    },
    entityFilter: ["charges", "customers"],
    syncMode: "incremental",
    writeMode: "append_dedup",
    syncEngine: "cdc",
    deleteMode: "soft",
    batchSize: 5000,
    incrementalConfig: {
      trackingColumn: "updated_at",
      trackingType: "timestamp",
      // TRAP: a cursor that moves every sync
      lastValue: "TRAP-LAST-VALUE-2026-08-31",
    },
    conflictConfig: { keyColumns: ["id"], strategy: "update" },
    paginationConfig: {
      mode: "keyset",
      keysetColumn: "id",
      keysetDirection: "asc",
      // TRAP: same
      lastKeysetValue: "TRAP-LAST-KEYSET-99999",
    },
    // TRAPS: pure run state
    syncState: "live",
    streamState: "active",
    backfillState: { status: "running", runId: "TRAP-RUN-ID" },
    lastRunAt: new Date("2026-08-31T12:00:00Z"),
    lastSuccessAt: new Date("2026-08-31T12:00:00Z"),
    lastError: "TRAP-LAST-ERROR",
    runCount: 987,
    avgDurationMs: 1234,
    createdBy: "TRAP-CREATED-BY",
    sourceBlobSha: "TRAP-BLOB-SHA",
  } as unknown as IFlow;
}

// ── path helpers ──
assert.equal(flowFilePath("stripe-warehouse"), "flows/stripe-warehouse.yml");
assert.equal(FLOWS_DIR, "flows");
assert.equal(
  slugFromFlowFilePath("flows/stripe-warehouse.yml"),
  "stripe-warehouse",
);
assert.equal(slugFromFlowFilePath("flows/nested/x.yml"), null);
assert.equal(slugFromFlowFilePath("dbt/jobs/x.yml"), null);
assert.equal(slugFromFlowFilePath("flows/Bad_Slug.yml"), null);

// ── the exclusion test ──
{
  const yamlText = serializeFlowFile(flowToFile(flowWithTraps()));
  const forbidden = [
    "TRAP-ENDPOINT-ID",
    "whsec_TRAP_SECRET_VALUE",
    "TRAP-LAST-VALUE-2026-08-31",
    "TRAP-LAST-KEYSET-99999",
    "TRAP-RUN-ID",
    "TRAP-LAST-ERROR",
    "TRAP-CREATED-BY",
    "TRAP-BLOB-SHA",
    "4321", // webhookConfig.totalReceived
    "987", // runCount
    "1234", // avgDurationMs
    "2026-08-30", // backfillSchedule.lastRunAt
    "2026-08-31", // lastRunAt / lastSuccessAt / lastReceivedAt
    "last_value",
    "last_keyset_value",
    "last_run_at",
    "endpoint",
    "secret",
    "sync_state",
    "stream_state",
    "backfill_state",
  ];
  for (const needle of forbidden) {
    assert.ok(
      !yamlText.includes(needle),
      `serialized file must not contain ${needle}:\n${yamlText}`,
    );
  }

  // …while the definition halves of those same objects DO survive.
  for (const needle of [
    "name: Stripe → Warehouse",
    "tracking_column: updated_at",
    "keyset_column: id",
    "cron: 0 * * * *",
    "backfill_schedule",
    "cron: 0 3 * * *",
    "table_name: stripe_charges",
    "engine: cdc",
    "batch_size: 5000",
  ]) {
    assert.ok(yamlText.includes(needle), `expected ${needle} in:\n${yamlText}`);
  }
  // A webhook flow records only whether delivery is enabled.
  assert.match(yamlText, /webhook:\n\s+enabled: true/);
}

// ── round-trip ──
{
  const file = flowToFile(flowWithTraps());
  const parsed = parseFlowFile(serializeFlowFile(file));
  assert.ok(parsed, "round-trips");
  assert.equal(parsed.name, "Stripe → Warehouse");
  assert.equal(parsed.type, "webhook");
  assert.deepEqual(parsed.source, {
    type: "connector",
    connectionId: connectorId.toString(),
  });
  assert.equal(parsed.destination.connectionId, destId.toString());
  assert.equal(parsed.destination.table?.tableName, "stripe_charges");
  assert.deepEqual(parsed.schedule, {
    cron: "0 * * * *",
    timezone: "Europe/Zurich",
  });
  assert.deepEqual(parsed.backfillSchedule, {
    cron: "0 3 * * *",
    timezone: "UTC",
  });
  assert.equal(parsed.sync.engine, "cdc");
  assert.equal(parsed.sync.batchSize, 5000);
  assert.deepEqual(parsed.entityFilter, ["charges", "customers"]);
  assert.equal(parsed.incremental?.trackingColumn, "updated_at");
  assert.equal(parsed.pagination?.keysetDirection, "asc");
  assert.equal(parsed.webhookEnabled, true);
  // Pass-through blobs are snake_case in the file and camelCase back in
  // memory, so the file reads consistently and the row shape is preserved.
  assert.deepEqual(parsed.destination.table?.partitioning, {
    enabled: true,
    type: "time",
    field: "created_at",
  });
}

// ── partitioning/clustering keys are snake_case in the file ──
{
  const text = serializeFlowFile(flowToFile(flowWithTraps()));
  assert.ok(
    text.includes("require_partition_filter") ||
      !text.includes("requirePartitionFilter"),
    `no camelCase keys leak into the file:\n${text}`,
  );
  const withFlag = {
    ...flowWithTraps(),
    tableDestination: {
      tableName: "t",
      partitioning: { enabled: true, requirePartitionFilter: true },
    },
  } as unknown as IFlow;
  const out = serializeFlowFile(flowToFile(withFlag));
  assert.ok(out.includes("require_partition_filter: true"), out);
  assert.ok(!out.includes("requirePartitionFilter"), out);
  const back = parseFlowFile(out);
  assert.equal(
    (
      back?.destination.table?.partitioning as {
        requirePartitionFilter?: boolean;
      }
    )?.requirePartitionFilter,
    true,
    "and it round-trips back to the row's camelCase shape",
  );
}

// ── a database-source, schedule-less flow ──
{
  const dbFlow = {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(),
    type: "scheduled",
    name: "Query → orders",
    slug: "query-orders",
    sourceType: "database",
    databaseSource: {
      connectionId: tableConnId,
      database: "prod",
      query: "SELECT * FROM orders",
    },
    destinationDatabaseId: destId,
    // A disabled schedule is "no schedule" in the file, not an empty object.
    schedule: { enabled: false, cron: "0 0 * * *", timezone: "UTC" },
    syncMode: "full",
    createdBy: "u1",
  } as unknown as IFlow;
  const text = serializeFlowFile(flowToFile(dbFlow));
  assert.ok(
    !text.includes("schedule:"),
    `disabled schedule is omitted:\n${text}`,
  );
  assert.ok(
    !text.includes("webhook:"),
    "a scheduled flow has no webhook block",
  );
  const parsed = parseFlowFile(text);
  assert.ok(parsed);
  assert.equal(parsed.source.type, "database");
  assert.equal(
    parsed.source.type === "database" ? parsed.source.query : null,
    "SELECT * FROM orders",
  );
  assert.equal(parsed.schedule, null);
}

// ── serialize/parse symmetry: anything writable must be readable ──
// A row without a name serializes to `name: ''`, which parseFlowFile
// rejects. commitFlowFile therefore refuses to write one (it requires both
// a slug and a name); this asserts the asymmetry that guard exists for, so
// nobody "fixes" the guard away. Found by projecting production rows whose
// name backfill had not yet deployed.
{
  const nameless = {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(),
    type: "scheduled",
    sourceType: "connector",
    dataSourceId: connectorId,
    destinationDatabaseId: destId,
    createdBy: "u1",
  } as unknown as IFlow;
  const text = serializeFlowFile(flowToFile(nameless));
  assert.match(text, /name: ''/, "a nameless row serializes to an empty name");
  assert.equal(
    parseFlowFile(text),
    null,
    "…and that file is not readable, which is why commitFlowFile skips it",
  );
}

// ── malformed input is rejected, not half-parsed ──
assert.equal(parseFlowFile("this: [is: not: valid"), null);
assert.equal(parseFlowFile("just a string"), null);
assert.equal(parseFlowFile("name: no type here"), null);
assert.equal(parseFlowFile("type: scheduled"), null); // no name

console.log("flow-config-files tests passed");

// ---- vocabulary: a connector is code, a connection is a credential --------
// On disk the source of a connector-backed flow is `source.connection_id`.
// Files written before that key settled carry `connector_id`; they must keep
// parsing (a workspace repo is not rewritten by a rename), and a file that
// somehow carries both must prefer the current key.
{
  const legacy = parseFlowFile(
    "name: legacy\ntype: scheduled\nsource:\n  type: connector\n  connector_id: 6a2bd881b6f8c41ea17e9bc7\ndestination:\n  connection_id: 69c2719490eb18199aafa882\n",
  );
  assert.ok(legacy && "file" in legacy ? legacy.file : legacy);
  const legacyFile = (legacy as { file?: unknown }).file ?? legacy;
  assert.equal(
    (legacyFile as { source: { connectionId: string } }).source.connectionId,
    "6a2bd881b6f8c41ea17e9bc7",
  );

  const current = parseFlowFile(
    "name: current\ntype: scheduled\nsource:\n  type: connector\n  connection_id: 6a2bd881b6f8c41ea17e9bc7\n  connector_id: 000000000000000000000000\ndestination:\n  connection_id: 69c2719490eb18199aafa882\n",
  );
  const currentFile = (current as { file?: unknown }).file ?? current;
  assert.equal(
    (currentFile as { source: { connectionId: string } }).source.connectionId,
    "6a2bd881b6f8c41ea17e9bc7",
  );

  const emitted = serializeFlowFile(currentFile as never);
  assert.match(emitted, /connection_id: 6a2bd881b6f8c41ea17e9bc7/);
  assert.doesNotMatch(emitted, /connector_id/);
}
