import assert from "node:assert/strict";
import { CloseConnector } from "./connector";

function createConnector() {
  return new CloseConnector({
    id: "ds_close",
    name: "Close",
    type: "close",
    config: { api_key: "test-key" },
  } as any);
}

function testUserWebhookEventsAreSupported() {
  const connector = createConnector();

  assert.deepEqual(connector.getWebhookEventsForEntities(["users"]), [
    "user.created",
    "user.updated",
    "user.deleted",
  ]);
}

function testUserWebhookEventsAreMapped() {
  const connector = createConnector();

  assert.deepEqual(connector.getWebhookEventMapping("user.created"), {
    entity: "users",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("user.updated"), {
    entity: "users",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("user.deleted"), {
    entity: "users",
    operation: "delete",
  });
}

function testUserWebhookPayloadIsExtractedForProcessing() {
  const connector = createConnector();

  assert.deepEqual(
    connector.extractWebhookData({
      event: {
        object_type: "user",
        action: "updated",
        object_id: "user_123",
        data: {
          id: "user_123",
          email: "user@example.com",
          first_name: "Test",
          date_updated: "2026-05-20T07:00:00.000Z",
        },
      },
    }),
    {
      id: "user_123",
      data: {
        id: "user_123",
        email: "user@example.com",
        first_name: "Test",
        date_updated: "2026-05-20T07:00:00.000Z",
      },
    },
  );
}

function testUserWebhookCdcRecordUsesUsersEntity() {
  const connector = createConnector();

  const records = connector.extractWebhookCdcRecords(
    {
      id: "evt_123",
      event: {
        object_type: "user",
        action: "deleted",
        object_id: "user_123",
      },
    },
    "user.deleted",
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].entity, "users");
  assert.equal(records[0].recordId, "user_123");
  assert.equal(records[0].operation, "delete");
  assert.deepEqual(records[0].payload, { id: "user_123" });
}

// Regression: Close nests its unique event id at `event.event.id`. The CDC
// record's changeId must resolve to it so distinct updates get distinct
// idempotency keys (instead of collapsing onto `lead.updated:<recordId>`).
function testWebhookChangeIdUsesNestedEventId() {
  const connector = createConnector();

  const records = connector.extractWebhookCdcRecords(
    {
      event: {
        id: "ev_nested_123",
        object_type: "lead",
        action: "updated",
        object_id: "lead_abc",
        date_updated: "2026-06-21T17:19:39.000Z",
        data: {
          id: "lead_abc",
          display_name: "Acme",
          date_updated: "2026-06-21T17:19:39.000Z",
        },
      },
    },
    "lead.updated",
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].changeId, "ev_nested_123");
}

// When no vendor event id is present, the fallback changeId must include the
// source timestamp so two distinct updates of the same record never share a
// changeId (and therefore never collapse to one idempotency key).
function testWebhookChangeIdFallbackIncludesSourceTs() {
  const connector = createConnector();

  const records = connector.extractWebhookCdcRecords(
    {
      event: {
        object_type: "lead",
        action: "updated",
        object_id: "lead_xyz",
        date_updated: "2026-06-21T17:19:39.000Z",
        data: {
          id: "lead_xyz",
          display_name: "Beta",
          date_updated: "2026-06-21T17:19:39.000Z",
        },
      },
    },
    "lead.updated",
  );

  assert.equal(records.length, 1);
  assert.ok(
    records[0].changeId.endsWith(":2026-06-21T17:19:39.000Z"),
    `changeId should include sourceTs, got ${records[0].changeId}`,
  );
  assert.ok(records[0].changeId.includes("lead_xyz"));
}

function main() {
  testUserWebhookEventsAreSupported();
  testUserWebhookEventsAreMapped();
  testUserWebhookPayloadIsExtractedForProcessing();
  testUserWebhookCdcRecordUsesUsersEntity();
  testWebhookChangeIdUsesNestedEventId();
  testWebhookChangeIdFallbackIncludesSourceTs();
}

main();
