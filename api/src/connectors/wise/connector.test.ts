import assert from "node:assert/strict";
import crypto from "node:crypto";
import { WiseConnector } from "./connector";

function createConnector(config: Record<string, unknown> = {}) {
  return new WiseConnector({
    id: "ds_wise",
    name: "Wise",
    type: "wise",
    config: {
      api_key: "test-token",
      ...config,
    },
  } as any);
}

function testConfigValidationRequiresApiKey() {
  const connector = createConnector({ api_key: "" });
  const result = connector.validateConfig();
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes("API token")));
}

function testConfigValidationRejectsNonNumericProfileId() {
  const connector = createConnector({ profile_id: "abc" });
  const result = connector.validateConfig();
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes("profile_id")));
}

function testAvailableEntities() {
  const connector = createConnector();
  const entities = connector.getAvailableEntities();
  for (const entity of [
    "profiles",
    "balances",
    "balance_updates",
    "transfers",
    "recipients",
    "activities",
  ]) {
    assert.ok(entities.includes(entity), `missing entity ${entity}`);
  }

  const metadata = connector.getEntityMetadata().map(entry => entry.name);
  assert.deepEqual(metadata.sort(), [...entities].sort());
}

async function testResolveSchema() {
  const connector = createConnector();
  for (const entity of connector.getAvailableEntities()) {
    const schema = await connector.resolveSchema(entity);
    assert.ok(schema, `expected schema for ${entity}`);
    assert.equal(schema?.entity, entity);
    assert.equal(schema?.unknownFieldPolicy, "string");
    assert.deepEqual(schema?.keyColumns, ["id"]);
    assert.equal(schema?.fields.id?.type, "string");
  }

  const transfers = await connector.resolveSchema("transfers");
  assert.equal(transfers?.fields.status?.type, "string");
  assert.equal(transfers?.fields.sourceValue?.type, "number");
  assert.equal(transfers?.fields.created?.type, "timestamp");

  const balanceUpdates = await connector.resolveSchema("balance_updates");
  assert.equal(balanceUpdates?.fields.step_id?.type, "integer");
  assert.equal(balanceUpdates?.fields.occurred_at?.type, "timestamp");

  assert.equal(await connector.resolveSchema("not_real"), null);
}

function testResolveRecordTimestampHandlesWiseTransferCreated() {
  const connector = createConnector() as unknown as {
    resolveRecordTimestamp(payload: Record<string, unknown>): Date;
  };

  const date = connector.resolveRecordTimestamp({
    id: "1",
    created: "2020-02-07 15:53:48",
  });
  assert.equal(date.toISOString(), "2020-02-07T15:53:48.000Z");

  const occurred = connector.resolveRecordTimestamp({
    occurred_at: "2023-03-08T14:55:38.123Z",
  });
  assert.equal(occurred.toISOString(), "2023-03-08T14:55:38.123Z");
}

function testWebhookEventMapping() {
  const connector = createConnector();
  assert.deepEqual(connector.getWebhookEventMapping("transfers#state-change"), {
    entity: "transfers",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("balances#update"), {
    entity: "balance_updates",
    operation: "upsert",
  });
  assert.deepEqual(
    connector.getWebhookEventMapping("balances#account-state-change"),
    { entity: "balances", operation: "upsert" },
  );
  assert.deepEqual(
    connector.getWebhookEventMapping("recipients#state-change"),
    { entity: "recipients", operation: "upsert" },
  );
  assert.equal(connector.getWebhookEventMapping("unknown#event"), null);
}

function testWebhookEventsForEntities() {
  const connector = createConnector();
  assert.deepEqual(
    connector.getWebhookEventsForEntities(["transfers"]).sort(),
    [
      "transfers#active-cases",
      "transfers#payout-failure",
      "transfers#refund",
      "transfers#state-change",
    ],
  );
  assert.deepEqual(connector.getWebhookEventsForEntities(["balance_updates"]), [
    "balances#update",
  ]);
  assert.deepEqual(
    connector.getWebhookEventsForEntities([]),
    connector.getSupportedWebhookEvents(),
  );
}

function testExtractTransferStateChange() {
  const connector = createConnector();
  const extracted = connector.extractWebhookData({
    event_type: "transfers#state-change",
    sent_at: "2020-01-01T12:34:56.123Z",
    data: {
      resource: {
        type: "transfer",
        id: 111,
        profile_id: 222,
        account_id: 333,
      },
      current_state: "processing",
      previous_state: "incoming_payment_waiting",
      occurred_at: "2020-01-01T12:34:56.789Z",
    },
  });

  assert.ok(extracted);
  assert.equal(extracted?.id, "111");
  assert.equal(extracted?.data.status, "processing");
  assert.equal(extracted?.data.current_state, "processing");
  assert.equal(extracted?.data.previous_state, "incoming_payment_waiting");
  assert.equal(extracted?.data.profile_id, 222);
}

function testExtractBalanceUpdate() {
  const connector = createConnector();
  const extracted = connector.extractWebhookData({
    event_type: "balances#update",
    subscription_id: "sub-1",
    schema_version: "4.0.0",
    sent_at: "2023-03-08T14:55:39.456Z",
    data: {
      resource: { type: "balance-account", id: 2, profile_id: 9 },
      amount: 70,
      balance_id: 111,
      channel_name: "TRANSFER",
      currency: "GBP",
      occurred_at: "2023-03-08T14:55:38.123Z",
      post_transaction_balance_amount: 88.93,
      step_id: 1234567,
      transaction_type: "credit",
      transfer_reference: "BNK-1234567",
    },
  });

  assert.ok(extracted);
  assert.equal(extracted?.id, "111:1234567");
  assert.equal(extracted?.data.transaction_type, "credit");
  assert.equal(extracted?.data.currency, "GBP");
  assert.equal(extracted?.data.step_id, 1234567);
}

function testExtractWebhookCdcRecordsParity() {
  const connector = createConnector();
  const event = {
    id: "delivery-1",
    event_type: "transfers#state-change",
    data: {
      resource: { type: "transfer", id: 42, profile_id: 1, account_id: 2 },
      current_state: "outgoing_payment_sent",
      previous_state: "processing",
      occurred_at: "2024-06-01T10:00:00.000Z",
    },
  };

  const records = connector.extractWebhookCdcRecords(
    event,
    "transfers#state-change",
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].entity, "transfers");
  assert.equal(records[0].recordId, "42");
  assert.equal(records[0].operation, "upsert");
  assert.equal(records[0].source, "webhook");
  assert.equal(records[0].sourceTs.toISOString(), "2024-06-01T10:00:00.000Z");
  assert.equal(records[0].changeId, "delivery-1");
}

function testNormalizeBackfillRecord() {
  const connector = createConnector();
  const record = connector.normalizeBackfillRecord("transfers", {
    id: 120064010,
    status: "cancelled",
    created: "2020-02-07 15:53:48",
    sourceCurrency: "CHF",
    sourceValue: 242,
  });

  assert.ok(record);
  assert.equal(record?.recordId, "120064010");
  assert.equal(record?.source, "backfill");
  assert.equal(record?.sourceTs.toISOString(), "2020-02-07T15:53:48.000Z");
}

function testWebhookCapabilitiesNoAutoProvision() {
  const connector = createConnector();
  assert.equal(connector.supportsWebhooks(), true);
  assert.equal(connector.supportsWebhookProvisioning(), false);
  const caps = connector.getWebhookCapabilities();
  assert.equal(caps.supported, true);
  assert.equal(caps.provisioning.supported, false);
  assert.ok(caps.secretHelpText?.toLowerCase().includes("rsa"));
}

function testIncrementalCapabilitiesHonest() {
  const connector = createConnector();
  const caps = connector.getIncrementalCapabilities();
  assert.equal(caps.supported, true);
  assert.equal(caps.mode, "none");
  assert.equal(caps.perEntity?.transfers?.mode, "created-anchor");
  assert.equal(caps.perEntity?.transfers?.anchorField, "createdDateStart");
  assert.equal(caps.perEntity?.activities?.mode, "native");
  assert.equal(caps.perEntity?.activities?.anchorField, "since");
  assert.equal(caps.perEntity?.profiles, undefined);
  assert.equal(caps.perEntity?.balances, undefined);
  assert.equal(caps.perEntity?.recipients, undefined);
  assert.ok(caps.warning && caps.warning.length > 0);
}

async function testVerifyWebhookMissingSignature() {
  const connector = createConnector();
  const result = await connector.verifyWebhook({
    payload: JSON.stringify({ event_type: "transfers#state-change" }),
    headers: {},
  });
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes("X-Signature-SHA256"));
}

async function testVerifyWebhookValidSignature() {
  const connector = createConnector();
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const publicPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();

  (connector as any).getWebhookPublicKeys = () => [publicPem];

  const body = JSON.stringify({
    data: {
      resource: { type: "transfer", id: 99, profile_id: 1, account_id: 2 },
      current_state: "processing",
      previous_state: null,
      occurred_at: "2024-01-01T00:00:00.000Z",
    },
    subscription_id: "01234567-89ab-cdef-0123-456789abcdef",
    event_type: "transfers#state-change",
    schema_version: "2.0.0",
    sent_at: "2024-01-01T00:00:01.000Z",
  });

  const signature = crypto
    .createSign("RSA-SHA256")
    .update(body)
    .end()
    .sign(privateKey, "base64");

  const result = await connector.verifyWebhook({
    payload: body,
    headers: {
      "X-Signature-SHA256": signature,
      "X-Delivery-Id": "delivery-abc",
    },
  });

  assert.equal(result.valid, true);
  assert.equal(result.event?.type, "transfers#state-change");
  assert.equal(result.event?.id, "delivery-abc");
}

async function testVerifyWebhookRejectsBadSignature() {
  const connector = createConnector();
  const result = await connector.verifyWebhook({
    payload: JSON.stringify({ event_type: "transfers#state-change" }),
    headers: {
      "X-Signature-SHA256": Buffer.from("not-a-real-signature").toString(
        "base64",
      ),
    },
  });
  assert.equal(result.valid, false);
  assert.ok(result.error?.toLowerCase().includes("invalid"));
}

async function testBalanceUpdatesBackfillIsNoop() {
  const connector = createConnector();
  const batches: unknown[] = [];
  const state = await connector.fetchEntityChunk({
    entity: "balance_updates",
    onBatch: async batch => {
      batches.push(...batch);
    },
  } as any);

  assert.equal(state.hasMore, false);
  assert.equal(state.totalProcessed, 0);
  assert.equal(batches.length, 0);
}

async function testTransfersChunkUsesOffsetAndProfile() {
  const connector = createConnector({ profile_id: "12636519" });
  const captured: Array<Record<string, unknown>> = [];

  (connector as any).wiseApi = {
    get: async (
      path: string,
      config?: { params?: Record<string, unknown> },
    ) => {
      captured.push({ path, ...(config?.params ?? {}) });
      if (path === "/v1/transfers") {
        return {
          data: [
            {
              id: 1,
              status: "outgoing_payment_sent",
              created: "2024-01-02 09:36:26",
              business: 12636519,
            },
          ],
        };
      }
      throw new Error(`Unexpected path ${path}`);
    },
  };

  const batches: Array<Record<string, unknown>> = [];
  const state = await connector.fetchEntityChunk({
    entity: "transfers",
    batchSize: 50,
    onBatch: async batch => {
      batches.push(...batch);
    },
  } as any);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].path, "/v1/transfers");
  assert.equal(captured[0].profile, "12636519");
  assert.equal(captured[0].limit, 50);
  assert.equal(captured[0].offset, 0);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].id, "1");
  assert.equal(state.hasMore, false);
  assert.equal(state.totalProcessed, 1);
}

async function testTransfersIncrementalPassesCreatedDateStart() {
  const connector = createConnector({ profile_id: "12636519" });
  const captured: Array<Record<string, unknown>> = [];

  (connector as any).wiseApi = {
    get: async (
      path: string,
      config?: { params?: Record<string, unknown> },
    ) => {
      captured.push({ path, ...(config?.params ?? {}) });
      return { data: [] };
    },
  };

  await connector.fetchEntityChunk({
    entity: "transfers",
    since: new Date("2026-07-15T12:34:56.000Z"),
    onBatch: async () => {},
  } as any);

  assert.equal(captured[0].createdDateStart, "2026-07-15");
  // No updated_* filter exists on Wise list transfers — created-anchor only.
  assert.equal(captured[0].updatedAfter, undefined);
}

async function testRecipientsChunkUsesSeekPosition() {
  const connector = createConnector({ profile_id: "12636519" });
  let calls = 0;

  (connector as any).wiseApi = {
    get: async (
      _path: string,
      config?: { params?: Record<string, unknown> },
    ) => {
      calls++;
      if (calls === 1) {
        assert.equal(config?.params?.seekPosition, undefined);
        return {
          data: {
            content: [{ id: 10 }, { id: 9 }],
            seekPositionForNext: 9,
            size: 2,
          },
        };
      }
      if (calls === 2) {
        assert.equal(config?.params?.seekPosition, 9);
        return {
          data: {
            content: [{ id: 8 }],
            seekPositionForNext: 8,
            size: 2,
          },
        };
      }
      assert.equal(config?.params?.seekPosition, 8);
      return {
        data: {
          content: [],
          seekPositionForNext: null,
          size: 2,
        },
      };
    },
  };

  // First chunk — maxIterations 1 so we resume
  const first = await connector.fetchEntityChunk({
    entity: "recipients",
    batchSize: 2,
    maxIterations: 1,
    rateLimitDelay: 0,
    onBatch: async () => {},
  } as any);
  assert.equal(first.hasMore, true);
  assert.equal(first.metadata?.seekPosition, 9);

  const second = await connector.fetchEntityChunk({
    entity: "recipients",
    batchSize: 2,
    maxIterations: 1,
    rateLimitDelay: 0,
    state: first,
    onBatch: async () => {},
  } as any);
  assert.equal(second.hasMore, true);
  assert.equal(second.metadata?.seekPosition, 8);

  const third = await connector.fetchEntityChunk({
    entity: "recipients",
    batchSize: 2,
    maxIterations: 1,
    rateLimitDelay: 0,
    state: second,
    onBatch: async () => {},
  } as any);
  // Null seekPositionForNext → profile complete
  assert.equal(third.hasMore, false);
  assert.equal(calls, 3);
}

async function testRecipientsContinuesWhenPageShorterThanRequestedSize() {
  // Wise often caps page size (e.g. 20) below our requested size (100). A
  // short page must NOT end the sync while seekPositionForNext is set.
  const connector = createConnector({ profile_id: "12636519" });
  let calls = 0;
  const batches: Array<Record<string, unknown>> = [];

  (connector as any).wiseApi = {
    get: async () => {
      calls++;
      if (calls === 1) {
        return {
          data: {
            content: Array.from({ length: 20 }, (_, i) => ({ id: 100 - i })),
            seekPositionForNext: 81,
            size: 20,
          },
        };
      }
      if (calls === 2) {
        return {
          data: {
            content: Array.from({ length: 7 }, (_, i) => ({ id: 80 - i })),
            seekPositionForNext: 74,
            size: 20,
          },
        };
      }
      return {
        data: {
          content: [],
          seekPositionForNext: null,
          size: 20,
        },
      };
    },
  };

  const state = await connector.fetchEntityChunk({
    entity: "recipients",
    batchSize: 100,
    maxIterations: 10,
    rateLimitDelay: 0,
    onBatch: async batch => {
      batches.push(...batch);
    },
  } as any);

  assert.equal(calls, 3);
  assert.equal(batches.length, 27);
  assert.equal(state.hasMore, false);
  assert.equal(state.totalProcessed, 27);
}

async function testActivitiesChunkUsesNextCursorQueryParam() {
  const connector = createConnector({ profile_id: "12636519" });
  const captured: Array<Record<string, unknown>> = [];
  let calls = 0;

  (connector as any).wiseApi = {
    get: async (
      path: string,
      config?: { params?: Record<string, unknown> },
    ) => {
      calls++;
      captured.push({ path, ...(config?.params ?? {}) });
      if (calls === 1) {
        return {
          data: {
            activities: [
              { id: "act-1", createdOn: "2026-07-01T00:00:00.000Z" },
              { id: "act-2", createdOn: "2026-06-01T00:00:00.000Z" },
            ],
            cursor: "cursor-page-2",
          },
        };
      }
      return {
        data: {
          activities: [{ id: "act-3", createdOn: "2026-05-01T00:00:00.000Z" }],
          cursor: null,
        },
      };
    },
  };

  const batches: Array<Record<string, unknown>> = [];
  const first = await connector.fetchEntityChunk({
    entity: "activities",
    batchSize: 50,
    maxIterations: 1,
    rateLimitDelay: 0,
    onBatch: async batch => {
      batches.push(...batch);
    },
  } as any);

  assert.equal(captured[0].path, "/v1/profiles/12636519/activities");
  assert.equal(captured[0].cursor, undefined);
  assert.equal(captured[0].nextCursor, undefined);
  assert.equal(first.hasMore, true);
  assert.equal(first.metadata?.cursor, "cursor-page-2");
  assert.equal(batches.length, 2);

  const second = await connector.fetchEntityChunk({
    entity: "activities",
    batchSize: 50,
    maxIterations: 1,
    rateLimitDelay: 0,
    state: first,
    onBatch: async batch => {
      batches.push(...batch);
    },
  } as any);

  assert.equal(captured[1].nextCursor, "cursor-page-2");
  // Must not send the wrong query key — that re-fetches page 1 forever.
  assert.equal(captured[1].cursor, undefined);
  assert.equal(second.hasMore, false);
  assert.equal(batches.length, 3);
  assert.equal(batches[2].id, "act-3");
  assert.equal(batches[2].profileId, "12636519");
}

async function testActivitiesStopsWhenCursorDoesNotAdvance() {
  const connector = createConnector({ profile_id: "12636519" });
  let calls = 0;

  (connector as any).wiseApi = {
    get: async () => {
      calls++;
      return {
        data: {
          activities: [{ id: `act-${calls}` }],
          cursor: "stuck-cursor",
        },
      };
    },
  };

  // First page establishes cursor; second echoes the same cursor → done.
  const first = await connector.fetchEntityChunk({
    entity: "activities",
    maxIterations: 1,
    rateLimitDelay: 0,
    onBatch: async () => {},
  } as any);
  assert.equal(first.hasMore, true);
  assert.equal(first.metadata?.cursor, "stuck-cursor");

  const second = await connector.fetchEntityChunk({
    entity: "activities",
    maxIterations: 1,
    rateLimitDelay: 0,
    state: first,
    onBatch: async () => {},
  } as any);
  assert.equal(second.hasMore, false);
  assert.equal(calls, 2);
}

async function testActivitiesIncrementalPassesNativeSince() {
  const connector = createConnector({ profile_id: "12636519" });
  let captured: Record<string, unknown> | undefined;

  (connector as any).wiseApi = {
    get: async (
      _path: string,
      config?: { params?: Record<string, unknown> },
    ) => {
      captured = config?.params;
      return { data: { activities: [], cursor: null } };
    },
  };

  await connector.fetchEntityChunk({
    entity: "activities",
    since: new Date("2026-07-15T12:34:56.000Z"),
    onBatch: async () => {},
  } as any);

  assert.equal(captured?.since, "2026-07-15T12:34:56.000Z");
}

async function testProfilesChunkFiltersConfiguredProfile() {
  const connector = createConnector({ profile_id: "2" });
  (connector as any).wiseApi = {
    get: async (path: string) => {
      assert.equal(path, "/v2/profiles");
      return {
        data: [
          { id: 1, type: "PERSONAL", email: "a@example.com" },
          { id: 2, type: "BUSINESS", email: "b@example.com" },
        ],
      };
    },
  };

  const batches: Array<Record<string, unknown>> = [];
  const state = await connector.fetchEntityChunk({
    entity: "profiles",
    onBatch: async batch => {
      batches.push(...batch);
    },
  } as any);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].id, "2");
  assert.equal(state.hasMore, false);
}

async function main() {
  testConfigValidationRequiresApiKey();
  testConfigValidationRejectsNonNumericProfileId();
  testAvailableEntities();
  await testResolveSchema();
  testResolveRecordTimestampHandlesWiseTransferCreated();
  testWebhookEventMapping();
  testWebhookEventsForEntities();
  testExtractTransferStateChange();
  testExtractBalanceUpdate();
  testExtractWebhookCdcRecordsParity();
  testNormalizeBackfillRecord();
  testWebhookCapabilitiesNoAutoProvision();
  testIncrementalCapabilitiesHonest();
  await testVerifyWebhookMissingSignature();
  await testVerifyWebhookValidSignature();
  await testVerifyWebhookRejectsBadSignature();
  await testBalanceUpdatesBackfillIsNoop();
  await testTransfersChunkUsesOffsetAndProfile();
  await testTransfersIncrementalPassesCreatedDateStart();
  await testRecipientsChunkUsesSeekPosition();
  await testRecipientsContinuesWhenPageShorterThanRequestedSize();
  await testActivitiesChunkUsesNextCursorQueryParam();
  await testActivitiesStopsWhenCursorDoesNotAdvance();
  await testActivitiesIncrementalPassesNativeSince();
  await testProfilesChunkFiltersConfiguredProfile();
}

main().catch((error: unknown) => {
  throw error;
});
