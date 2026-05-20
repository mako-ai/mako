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

function main() {
  testUserWebhookEventsAreSupported();
  testUserWebhookEventsAreMapped();
  testUserWebhookPayloadIsExtractedForProcessing();
  testUserWebhookCdcRecordUsesUsersEntity();
}

main();
