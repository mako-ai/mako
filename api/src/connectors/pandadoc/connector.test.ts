import crypto from "node:crypto";
import assert from "node:assert/strict";
import { PandaDocConnector } from "./connector";

function createConnector(config: Record<string, unknown> = {}) {
  return new PandaDocConnector({
    id: "ds_pandadoc",
    name: "PandaDoc",
    type: "pandadoc",
    config: {
      api_key: "test-api-key",
      api_base_url: "https://api.pandadoc.com",
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

function testSupportsResumableAndWebhooks() {
  const connector = createConnector();
  assert.equal(connector.supportsResumableFetching(), true);
  assert.equal(connector.supportsWebhooks(), true);
  assert.equal(connector.supportsWebhookProvisioning(), true);
}

function testAvailableEntities() {
  const connector = createConnector();
  assert.deepEqual(connector.getAvailableEntities(), [
    "documents",
    "templates",
    "contacts",
    "members",
  ]);
}

function testWebhookEventsForEntities() {
  const connector = createConnector();

  assert.deepEqual(connector.getWebhookEventsForEntities(["documents"]).sort(), [
    "document_completed_pdf_ready",
    "document_creation_failed",
    "document_deleted",
    "document_section_added",
    "document_state_changed",
    "document_updated",
    "quote_updated",
    "recipient_completed",
  ]);

  assert.deepEqual(connector.getWebhookEventsForEntities(["templates"]).sort(), [
    "template_created",
    "template_deleted",
    "template_updated",
  ]);

  assert.deepEqual(connector.getWebhookEventsForEntities(["contacts"]), []);

  // Empty selection falls back to all supported events.
  assert.equal(
    connector.getWebhookEventsForEntities([]).length,
    connector.getSupportedWebhookEvents().length,
  );
}

function testWebhookEventMapping() {
  const connector = createConnector();
  assert.deepEqual(connector.getWebhookEventMapping("document_state_changed"), {
    entity: "documents",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("recipient_completed"), {
    entity: "documents",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("document_deleted"), {
    entity: "documents",
    operation: "delete",
  });
  assert.deepEqual(connector.getWebhookEventMapping("template_updated"), {
    entity: "templates",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("template_deleted"), {
    entity: "templates",
    operation: "delete",
  });
  assert.equal(connector.getWebhookEventMapping("unknown_event"), null);
}

const DOCUMENT_WEBHOOK_PAYLOAD = [
  {
    event: "document_state_changed",
    data: {
      id: "eHCjisfdtzJnbqnBbv2T9V",
      name: "My document for webhooks testing",
      date_created: "2024-03-18T16:26:43.090372Z",
      date_modified: "2024-03-18T16:26:46.286951Z",
      status: "document.completed",
      recipients: [{ email: "john.doe@example.com", has_completed: true }],
    },
  },
];

function signQuery(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

async function testWebhookVerificationAcceptsQuerySignature() {
  const connector = createConnector();
  const secret = "shared_key_test";
  const body = JSON.stringify(DOCUMENT_WEBHOOK_PAYLOAD);
  const signature = signQuery(secret, body);

  const result = await connector.verifyWebhook({
    payload: body,
    headers: {},
    secret,
    query: { signature },
  });

  assert.equal(result.valid, true);
  assert.equal(result.event?.type, "document_state_changed");
  assert.ok(typeof result.event?.id === "string" && result.event.id.length > 0);
  assert.equal(result.event?.events?.length, 1);
}

async function testWebhookVerificationAcceptsHeaderSignature() {
  const connector = createConnector();
  const secret = "shared_key_test";
  const body = JSON.stringify(DOCUMENT_WEBHOOK_PAYLOAD);
  const signature = signQuery(secret, body);

  const result = await connector.verifyWebhook({
    payload: body,
    headers: { signature },
    secret,
  });

  assert.equal(result.valid, true);
}

async function testWebhookVerificationRejectsBadSignature() {
  const connector = createConnector();
  const result = await connector.verifyWebhook({
    payload: JSON.stringify(DOCUMENT_WEBHOOK_PAYLOAD),
    headers: {},
    secret: "shared_key_test",
    query: {
      signature:
        "deadbeef00000000000000000000000000000000000000000000000000000000",
    },
  });
  assert.equal(result.valid, false);
  assert.match(result.error || "", /Invalid signature/);
}

async function testWebhookVerificationRejectsMissingSignature() {
  const connector = createConnector();
  const result = await connector.verifyWebhook({
    payload: "[]",
    headers: {},
    secret: "shared_key_test",
  });
  assert.equal(result.valid, false);
  assert.match(result.error || "", /Missing PandaDoc signature/);
}

async function testWebhookVerificationRejectsMissingSecret() {
  const connector = createConnector();
  const result = await connector.verifyWebhook({
    payload: "[]",
    headers: {},
    query: { signature: "abcd" },
  });
  assert.equal(result.valid, false);
  assert.match(result.error || "", /Missing webhook shared key/);
}

function testExtractWebhookData() {
  const connector = createConnector();
  const extracted = connector.extractWebhookData(DOCUMENT_WEBHOOK_PAYLOAD);
  assert.ok(extracted);
  assert.equal(extracted?.id, "eHCjisfdtzJnbqnBbv2T9V");
  assert.equal(extracted?.data.status, "document.completed");
}

function testExtractWebhookCdcRecordsFromArray() {
  const connector = createConnector();
  const records = connector.extractWebhookCdcRecords(
    DOCUMENT_WEBHOOK_PAYLOAD,
    "document_state_changed",
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].entity, "documents");
  assert.equal(records[0].recordId, "eHCjisfdtzJnbqnBbv2T9V");
  assert.equal(records[0].operation, "upsert");
  assert.equal(records[0].source, "webhook");
  assert.ok(records[0].sourceTs instanceof Date);
  // sourceTs derives from date_modified.
  assert.equal(records[0].sourceTs.toISOString(), "2024-03-18T16:26:46.286Z");
}

function testExtractWebhookCdcRecordsFromWrappedShape() {
  const connector = createConnector();
  // verifyWebhook stores a wrapped { type, id, events } object as rawPayload.
  const wrapped = {
    type: "document_deleted",
    id: "abc",
    events: [
      { event: "document_deleted", data: { id: "doc_1" } },
      { event: "template_updated", data: { id: "tmpl_1" } },
    ],
  };
  const records = connector.extractWebhookCdcRecords(wrapped);

  assert.equal(records.length, 2);
  const doc = records.find(r => r.entity === "documents");
  const tmpl = records.find(r => r.entity === "templates");
  assert.equal(doc?.recordId, "doc_1");
  assert.equal(doc?.operation, "delete");
  assert.equal(tmpl?.recordId, "tmpl_1");
  assert.equal(tmpl?.operation, "upsert");
}

function testNormalizeBackfillRecordDerivesMemberId() {
  const connector = createConnector();
  const normalized = connector.normalizeBackfillRecord("members", {
    membership_id: "RyMNXBjBPRppw56TfYBrrr",
    email: "josh@example.com",
    date_modified: "2024-07-11T20:36:43.362526Z",
  });
  assert.ok(normalized);
  assert.equal(normalized?.recordId, "RyMNXBjBPRppw56TfYBrrr");
  assert.equal(normalized?.payload?.id, "RyMNXBjBPRppw56TfYBrrr");
}

function testNormalizeBackfillRecordDocument() {
  const connector = createConnector();
  const normalized = connector.normalizeBackfillRecord("documents", {
    id: "doc_99",
    name: "Sample",
    date_modified: "2024-03-18T16:26:46.286951Z",
  });
  assert.ok(normalized);
  assert.equal(normalized?.recordId, "doc_99");
  assert.equal(normalized?.operation, "upsert");
  assert.equal(normalized?.source, "backfill");
}

async function testResolveSchema() {
  const connector = createConnector();
  for (const entity of ["documents", "templates", "contacts", "members"]) {
    const schema = await connector.resolveSchema(entity);
    assert.ok(schema, `expected schema for ${entity}`);
    assert.equal(schema?.entity, entity);
    assert.equal(schema?.unknownFieldPolicy, "string");
    assert.deepEqual(schema?.keyColumns, ["id"]);
    assert.ok(schema?.fields.id);
  }
  assert.equal(await connector.resolveSchema("not_real"), null);
}

function testEntityMetadataIncludesLayoutSuggestion() {
  const connector = createConnector();
  const metadata = connector.getEntityMetadata();
  const documents = metadata.find(m => m.name === "documents");
  assert.equal(documents?.layoutSuggestion?.partitionField, "date_created");
  const contacts = metadata.find(m => m.name === "contacts");
  assert.equal(contacts?.layoutSuggestion?.partitionField, "_syncedAt");
}

function testConfigSchemaWiresAllFields() {
  const schema = PandaDocConnector.getConfigSchema();
  const names = schema.fields.map(f => f.name);
  assert.deepEqual(names, ["api_key", "api_base_url"]);
}

async function main() {
  testConfigValidationRequiresApiKey();
  testSupportsResumableAndWebhooks();
  testAvailableEntities();
  testWebhookEventsForEntities();
  testWebhookEventMapping();
  await testWebhookVerificationAcceptsQuerySignature();
  await testWebhookVerificationAcceptsHeaderSignature();
  await testWebhookVerificationRejectsBadSignature();
  await testWebhookVerificationRejectsMissingSignature();
  await testWebhookVerificationRejectsMissingSecret();
  testExtractWebhookData();
  testExtractWebhookCdcRecordsFromArray();
  testExtractWebhookCdcRecordsFromWrappedShape();
  testNormalizeBackfillRecordDerivesMemberId();
  testNormalizeBackfillRecordDocument();
  await testResolveSchema();
  testEntityMetadataIncludesLayoutSuggestion();
  testConfigSchemaWiresAllFields();
}

main().catch((error: unknown) => {
  throw error;
});
