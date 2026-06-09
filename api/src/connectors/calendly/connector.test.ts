import crypto from "node:crypto";
import assert from "node:assert/strict";
import { CalendlyConnector } from "./connector";

function createConnector(config: Record<string, unknown> = {}) {
  return new CalendlyConnector({
    id: "ds_calendly",
    name: "Calendly",
    type: "calendly",
    config: {
      access_token: "pat_test_token",
      api_base_url: "https://api.calendly.com",
      ...config,
    },
  } as any);
}

function testConfigValidationRequiresAccessToken() {
  const connector = createConnector({ access_token: "" });
  const result = connector.validateConfig();
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes("access token")));
}

function testSupportsResumableAndWebhooks() {
  const connector = createConnector();
  assert.equal(connector.supportsResumableFetching(), true);
  assert.equal(connector.supportsWebhooks(), true);
  assert.equal(connector.supportsWebhookProvisioning(), true);
}

function testWebhookEventsForEntities() {
  const connector = createConnector();
  const inviteeOnly = connector.getWebhookEventsForEntities(["invitees"]);
  assert.deepEqual(inviteeOnly.sort(), [
    "invitee.canceled",
    "invitee.created",
    "invitee_no_show.created",
  ]);

  const scheduledOnly = connector.getWebhookEventsForEntities([
    "scheduled_events",
  ]);
  assert.deepEqual(scheduledOnly.sort(), [
    "invitee.canceled",
    "invitee.created",
  ]);

  const eventTypesOnly = connector.getWebhookEventsForEntities(["event_types"]);
  assert.deepEqual(eventTypesOnly.sort(), [
    "event_type.created",
    "event_type.updated",
  ]);

  const groupsOnly = connector.getWebhookEventsForEntities(["groups"]);
  assert.deepEqual(groupsOnly, []);
}

function testWebhookEventMapping() {
  const connector = createConnector();
  assert.deepEqual(connector.getWebhookEventMapping("invitee.created"), {
    entity: "invitees",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("invitee.canceled"), {
    entity: "invitees",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("event_type.created"), {
    entity: "event_types",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("event_type.updated"), {
    entity: "event_types",
    operation: "upsert",
  });
  assert.equal(connector.getWebhookEventMapping("unknown.event"), null);
}

const INVITEE_CREATED_PAYLOAD = {
  created_at: "2026-06-08T14:05:23.804714Z",
  created_by:
    "https://api.calendly.com/users/5398fa61-a96d-4e57-a36a-0734d492353d",
  event: "invitee.created",
  payload: {
    cancel_url: "https://calendly.com/cancellations/2179fa77",
    created_at: "2026-06-08T14:03:55.131215Z",
    email: "francesca@example.com",
    event:
      "https://api.calendly.com/scheduled_events/0dfa74f2-88bd-4d2f-98a1-7c9cdd208f99",
    first_name: "Francesca",
    last_name: "Nascimbene",
    name: "Francesca Nascimbene",
    status: "active",
    timezone: "Europe/Berlin",
    updated_at: "2026-06-08T14:03:55.131215Z",
    uri: "https://api.calendly.com/scheduled_events/0dfa74f2-88bd-4d2f-98a1-7c9cdd208f99/invitees/2179fa77-62a5-4086-8c0e-9ca47cc0a707",
    scheduled_event: {
      created_at: "2026-06-08T14:03:55.114298Z",
      end_time: "2026-06-11T08:45:00.000000Z",
      event_memberships: [{ user_name: "Pierangela" }],
      name: "Vetrina Digitale",
      start_time: "2026-06-11T08:15:00.000000Z",
      status: "active",
      updated_at: "2026-06-08T14:04:01.727060Z",
      uri: "https://api.calendly.com/scheduled_events/0dfa74f2-88bd-4d2f-98a1-7c9cdd208f99",
    },
  },
};

function signedHeader(secret: string, body: string, tsSeconds: number): string {
  const t = String(tsSeconds);
  const v1 = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${body}`, "utf8")
    .digest("hex");
  return `t=${t},v1=${v1}`;
}

async function testWebhookVerificationAcceptsMatchingSignature() {
  const connector = createConnector();
  const secret = "whsec_test_secret";
  const body = JSON.stringify(INVITEE_CREATED_PAYLOAD);
  const header = signedHeader(secret, body, Math.floor(Date.now() / 1000));

  const result = await connector.verifyWebhook({
    payload: body,
    headers: { "calendly-webhook-signature": header },
    secret,
  });

  assert.equal(result.valid, true);
  assert.equal(result.event?.type, "invitee.created");
}

async function testWebhookVerificationRejectsStaleTimestamp() {
  const connector = createConnector();
  const secret = "whsec_test_secret";
  const body = JSON.stringify(INVITEE_CREATED_PAYLOAD);
  const staleTs = Math.floor(Date.now() / 1000) - 10 * 60;
  const header = signedHeader(secret, body, staleTs);

  const result = await connector.verifyWebhook({
    payload: body,
    headers: { "calendly-webhook-signature": header },
    secret,
  });

  assert.equal(result.valid, false);
  assert.match(result.error || "", /Stale webhook timestamp/);
}

async function testWebhookVerificationRejectsBadSignature() {
  const connector = createConnector();
  const ts = Math.floor(Date.now() / 1000);
  const result = await connector.verifyWebhook({
    payload: JSON.stringify(INVITEE_CREATED_PAYLOAD),
    headers: {
      "calendly-webhook-signature": `t=${ts},v1=deadbeef00000000000000000000000000000000000000000000000000000000`,
    },
    secret: "whsec_test_secret",
  });

  assert.equal(result.valid, false);
  assert.match(result.error || "", /Invalid signature/);
}

async function testWebhookVerificationRejectsMissingHeader() {
  const connector = createConnector();
  const result = await connector.verifyWebhook({
    payload: "{}",
    headers: {},
    secret: "whsec_test_secret",
  });
  assert.equal(result.valid, false);
  assert.match(result.error || "", /Missing Calendly-Webhook-Signature/);
}

function testExtractWebhookData() {
  const connector = createConnector();
  const extracted = connector.extractWebhookData(INVITEE_CREATED_PAYLOAD);
  assert.ok(extracted);
  assert.equal(extracted?.id, "2179fa77-62a5-4086-8c0e-9ca47cc0a707");
  assert.equal(extracted?.data.email, "francesca@example.com");
  assert.equal(extracted?.data.id, "2179fa77-62a5-4086-8c0e-9ca47cc0a707");
}

function testInviteeCreatedEmitsTwoCdcRecords() {
  const connector = createConnector();
  const records = connector.extractWebhookCdcRecords(
    INVITEE_CREATED_PAYLOAD,
    "invitee.created",
  );

  assert.equal(records.length, 2);

  const inviteeRec = records.find(r => r.entity === "invitees");
  const eventRec = records.find(r => r.entity === "scheduled_events");

  assert.ok(inviteeRec);
  assert.equal(inviteeRec?.recordId, "2179fa77-62a5-4086-8c0e-9ca47cc0a707");
  assert.equal(inviteeRec?.operation, "upsert");
  assert.equal(inviteeRec?.source, "webhook");
  assert.ok(inviteeRec?.sourceTs instanceof Date);

  assert.ok(eventRec);
  assert.equal(eventRec?.recordId, "0dfa74f2-88bd-4d2f-98a1-7c9cdd208f99");
  assert.equal(eventRec?.payload?.status, "active");
  assert.ok(eventRec?.sourceTs instanceof Date);
}

function testEventTypeUpdatedEmitsSingleRecord() {
  const connector = createConnector();
  const records = connector.extractWebhookCdcRecords(
    {
      created_at: "2026-06-08T14:05:25.362984Z",
      event: "event_type.updated",
      payload: {
        active: true,
        name: "30 Minute Meeting",
        slug: "30min",
        uri: "https://api.calendly.com/event_types/a53b6681-d41a-40c0-8eac-8b5ba069e194",
        updated_at: "2026-06-08T12:22:55.900411Z",
      },
    },
    "event_type.updated",
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].entity, "event_types");
  assert.equal(records[0].recordId, "a53b6681-d41a-40c0-8eac-8b5ba069e194");
}

function testInviteeCanceledIsUpsertNotDelete() {
  const connector = createConnector();
  const records = connector.extractWebhookCdcRecords(
    {
      created_at: "2026-06-08T14:05:24.507081Z",
      event: "invitee.canceled",
      payload: {
        uri: "https://api.calendly.com/scheduled_events/d91262dc/invitees/70cfa7fd",
        status: "canceled",
        updated_at: "2026-06-08T14:00:16.292278Z",
        scheduled_event: {
          uri: "https://api.calendly.com/scheduled_events/d91262dc",
          status: "canceled",
          updated_at: "2026-06-08T14:00:16.319303Z",
        },
      },
    },
    "invitee.canceled",
  );

  assert.equal(records.length, 2);
  for (const r of records) assert.equal(r.operation, "upsert");
}

async function testResolveSchema() {
  const connector = createConnector();
  for (const entity of [
    "organizations",
    "users",
    "groups",
    "event_types",
    "scheduled_events",
    "invitees",
    "contacts",
  ]) {
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
  const scheduled = metadata.find(m => m.name === "scheduled_events");
  assert.equal(scheduled?.layoutSuggestion?.partitionField, "start_time");
  const invitees = metadata.find(m => m.name === "invitees");
  assert.equal(invitees?.layoutSuggestion?.partitionField, "created_at");
}

function testToRelativePathRejectsForeignHost() {
  const connector = createConnector() as unknown as {
    toRelativePath(uri: string): string;
  };
  assert.equal(
    connector.toRelativePath("https://api.calendly.com/scheduled_events/abc"),
    "/scheduled_events/abc",
  );
  assert.throws(
    () => connector.toRelativePath("https://attacker.example.com/anything"),
    /Refusing to call non-Calendly URL/,
  );
  assert.throws(
    () =>
      connector.toRelativePath(
        "https://api.calendly.com.attacker.example.com/x",
      ),
    /Refusing to call non-Calendly URL/,
  );
}

function testNormalizeBackfillRecordDerivesIdFromUri() {
  const connector = createConnector();
  const normalized = connector.normalizeBackfillRecord("event_types", {
    uri: "https://api.calendly.com/event_types/abc-123",
    name: "Demo",
  });
  assert.ok(normalized);
  assert.equal(normalized?.recordId, "abc-123");
  assert.equal(normalized?.payload?.id, "abc-123");
}

async function main() {
  testConfigValidationRequiresAccessToken();
  testSupportsResumableAndWebhooks();
  testWebhookEventsForEntities();
  testWebhookEventMapping();
  await testWebhookVerificationAcceptsMatchingSignature();
  await testWebhookVerificationRejectsStaleTimestamp();
  await testWebhookVerificationRejectsBadSignature();
  await testWebhookVerificationRejectsMissingHeader();
  testToRelativePathRejectsForeignHost();
  testExtractWebhookData();
  testInviteeCreatedEmitsTwoCdcRecords();
  testEventTypeUpdatedEmitsSingleRecord();
  testInviteeCanceledIsUpsertNotDelete();
  await testResolveSchema();
  testEntityMetadataIncludesLayoutSuggestion();
  testNormalizeBackfillRecordDerivesIdFromUri();
}

main().catch((error: unknown) => {
  throw error;
});
