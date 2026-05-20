import assert from "node:assert/strict";
import { ClaapConnector } from "./connector";

function createConnector(config: Record<string, unknown> = {}) {
  return new ClaapConnector({
    id: "ds_claap",
    name: "Claap",
    type: "claap",
    config: {
      api_key: "cla_test_key",
      api_base_url: "https://api.claap.io",
      ...config,
    },
  } as any);
}

function testConfigValidationRequiresApiKey() {
  const connector = createConnector({ api_key: "" });
  const result = connector.validateConfig();
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes("API key")));
}

function testRecordingWebhookEventsAreSupported() {
  const connector = createConnector();
  assert.deepEqual(connector.getWebhookEventsForEntities(["recordings"]), [
    "recording_added",
    "recording_updated",
  ]);
}

function testRecordingWebhookEventsAreMapped() {
  const connector = createConnector();
  assert.deepEqual(connector.getWebhookEventMapping("recording_added"), {
    entity: "recordings",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("recording_updated"), {
    entity: "recordings",
    operation: "upsert",
  });
}

function testWebhookVerificationAcceptsMatchingSecret() {
  const connector = createConnector();
  const payload = JSON.stringify({
    eventId: "evt_123",
    event: {
      type: "recording_added",
      recording: {
        id: "rec_1",
        title: "Demo",
        createdAt: "2026-05-20T07:00:00.000Z",
      },
    },
  });

  return connector
    .verifyWebhook({
      payload,
      headers: { "x-claap-webhook-secret": "whsec_test" },
      secret: "whsec_test",
    })
    .then(result => {
      assert.equal(result.valid, true);
      assert.equal(result.event?.type, "recording_added");
      assert.equal(result.event?.id, "evt_123");
    });
}

function testWebhookVerificationRejectsInvalidSecret() {
  const connector = createConnector();
  return connector
    .verifyWebhook({
      payload: "{}",
      headers: { "x-claap-webhook-secret": "wrong" },
      secret: "whsec_test",
    })
    .then(result => {
      assert.equal(result.valid, false);
      assert.match(result.error || "", /Invalid webhook secret/);
    });
}

function testWebhookPayloadIsExtractedForProcessing() {
  const connector = createConnector();
  assert.deepEqual(
    connector.extractWebhookData({
      eventId: "evt_123",
      event: {
        type: "recording_added",
        recording: {
          id: "rec_1",
          title: "Demo call",
          createdAt: "2026-05-20T07:00:00.000Z",
        },
      },
    }),
    {
      id: "rec_1",
      data: {
        id: "rec_1",
        title: "Demo call",
        createdAt: "2026-05-20T07:00:00.000Z",
      },
    },
  );
}

function testWebhookCdcRecordUsesRecordingsEntity() {
  const connector = createConnector();
  const records = connector.extractWebhookCdcRecords(
    {
      eventId: "evt_123",
      event: {
        type: "recording_updated",
        recording: {
          id: "rec_1",
          title: "Updated",
          createdAt: "2026-05-20T07:00:00.000Z",
        },
      },
    },
    "recording_updated",
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].entity, "recordings");
  assert.equal(records[0].recordId, "rec_1");
  assert.equal(records[0].operation, "upsert");
  assert.equal(records[0].payload?.title, "Updated");
  assert.ok(records[0].sourceTs instanceof Date);
}

function testResolveSchemaForRecordings() {
  const connector = createConnector();
  return connector.resolveSchema("recordings").then(schema => {
    assert.ok(schema);
    assert.equal(schema?.entity, "recordings");
    assert.equal(schema?.unknownFieldPolicy, "string");
    assert.ok(schema?.fields.id);
    assert.ok(schema?.fields.createdAt);
  });
}

function testSupportsResumableFetching() {
  const connector = createConnector();
  assert.equal(connector.supportsResumableFetching(), true);
  assert.equal(connector.supportsWebhooks(), true);
  assert.equal(connector.supportsWebhookProvisioning(), true);
}

function testEntityMetadataIncludesLayoutSuggestion() {
  const connector = createConnector();
  const metadata = connector.getEntityMetadata();
  const recordings = metadata.find(entry => entry.name === "recordings");
  assert.ok(recordings?.layoutSuggestion?.partitionField);
  assert.equal(recordings?.layoutSuggestion?.partitionField, "createdAt");
}

async function main() {
  testConfigValidationRequiresApiKey();
  testRecordingWebhookEventsAreSupported();
  testRecordingWebhookEventsAreMapped();
  await testWebhookVerificationAcceptsMatchingSecret();
  await testWebhookVerificationRejectsInvalidSecret();
  testWebhookPayloadIsExtractedForProcessing();
  testWebhookCdcRecordUsesRecordingsEntity();
  await testResolveSchemaForRecordings();
  testSupportsResumableFetching();
  testEntityMetadataIncludesLayoutSuggestion();
}

main().catch((error: unknown) => {
  throw error;
});
