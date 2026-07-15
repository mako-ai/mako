import assert from "node:assert/strict";
import { StripeConnector } from "./connector";

function createConnector(config: Record<string, unknown> = {}) {
  return new StripeConnector({
    id: "ds_stripe",
    name: "Stripe",
    type: "stripe",
    config: { api_key: "sk_test_123", ...config },
  } as any);
}

// 1700000000 seconds = 2023-11-14T22:13:20.000Z
const CREATED_EPOCH = 1700000000;
const CREATED_MS = CREATED_EPOCH * 1000;

function testConfigValidationRequiresApiKey() {
  const connector = createConnector({ api_key: "" });
  const result = connector.validateConfig();
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes("API key")));
}

function testAvailableEntitiesIncludeModernEntities() {
  const connector = createConnector();
  const entities = connector.getAvailableEntities();
  assert.ok(entities.includes("payment_intents"));
  assert.ok(entities.includes("prices"));
  assert.ok(entities.includes("plans"));
  assert.ok(entities.includes("disputes"));

  const metadata = connector.getEntityMetadata().map(entry => entry.name);
  assert.ok(metadata.includes("payment_intents"));
  assert.ok(metadata.includes("prices"));
  assert.ok(metadata.includes("disputes"));
}

function testResolveRecordTimestampUsesEpochCreated() {
  const connector = createConnector() as unknown as {
    resolveRecordTimestamp(payload: Record<string, unknown>): Date;
  };

  const date = connector.resolveRecordTimestamp({
    id: "ch_1",
    created: CREATED_EPOCH,
  });
  assert.ok(date instanceof Date);
  assert.equal(date.getTime(), CREATED_MS);
}

function testResolveRecordTimestampHandlesMillisGuard() {
  const connector = createConnector() as unknown as {
    resolveRecordTimestamp(payload: Record<string, unknown>): Date;
  };
  // Already-millis epoch (> 1e12) should not be multiplied again.
  const date = connector.resolveRecordTimestamp({ created: CREATED_MS });
  assert.equal(date.getTime(), CREATED_MS);
}

function testResolveRecordTimestampFallsBackToStringFields() {
  const connector = createConnector() as unknown as {
    resolveRecordTimestamp(payload: Record<string, unknown>): Date;
  };
  const iso = "2026-05-20T07:00:00.000Z";
  const date = connector.resolveRecordTimestamp({ updated_at: iso });
  assert.equal(date.toISOString(), iso);
}

async function testResolveSchema() {
  const connector = createConnector();
  for (const entity of [
    "customers",
    "subscriptions",
    "disputes",
    "charges",
    "invoices",
    "products",
    "plans",
    "prices",
    "payment_intents",
  ]) {
    const schema = await connector.resolveSchema(entity);
    assert.ok(schema, `expected schema for ${entity}`);
    assert.equal(schema?.entity, entity);
    assert.equal(schema?.unknownFieldPolicy, "string");
    assert.deepEqual(schema?.keyColumns, ["id"]);
    assert.equal(schema?.fields.id?.type, "string");
    assert.equal(schema?.fields.created?.type, "timestamp");
  }

  const charge = await connector.resolveSchema("charges");
  assert.equal(charge?.fields.amount?.type, "integer");
  assert.equal(charge?.fields.currency?.type, "string");
  assert.equal(charge?.fields.billing_details?.type, "json");

  const dispute = await connector.resolveSchema("disputes");
  assert.equal(dispute?.fields.status?.type, "string");
  assert.equal(dispute?.fields.amount?.type, "integer");
  assert.equal(dispute?.fields.charge?.type, "string");

  // Invoice fields that were previously absent (and therefore string-coerced
  // by the unknown-field policy) must now carry their real types.
  const invoice = await connector.resolveSchema("invoices");
  assert.equal(invoice?.fields.paid_out_of_band?.type, "boolean");
  assert.equal(invoice?.fields.automatic_tax?.type, "json");
  assert.equal(invoice?.fields.transfer_data?.type, "json");
  assert.equal(invoice?.fields.subtotal_excluding_tax?.type, "integer");
  assert.equal(invoice?.fields.total_excluding_tax?.type, "integer");
  assert.equal(invoice?.fields.ending_balance?.type, "integer");

  assert.equal(await connector.resolveSchema("not_real"), null);
}

async function testSubscriptionsBackfillRequestsAllStatuses() {
  const connector = createConnector();

  const capturedParams: Array<Record<string, unknown>> = [];
  (connector as any).stripe = {
    subscriptions: {
      list: async (params: Record<string, unknown>) => {
        capturedParams.push(params);
        return { data: [], has_more: false };
      },
    },
  };

  await connector.fetchEntity({
    entity: "subscriptions",
    onBatch: async () => {},
  } as any);

  assert.equal(capturedParams.length, 1);
  // Without status:"all" Stripe omits canceled/incomplete_expired subs.
  assert.equal(capturedParams[0].status, "all");
}

function testNoLegacySubscriptionWebhookEvents() {
  const connector = createConnector();
  // Stripe never emits bare `subscription.*` events (only
  // `customer.subscription.*`); ensure the dead entries are gone.
  assert.equal(connector.getWebhookEventMapping("subscription.created"), null);
  assert.equal(connector.getWebhookEventMapping("subscription.updated"), null);
  assert.equal(connector.getWebhookEventMapping("subscription.deleted"), null);

  const events = connector.getSupportedWebhookEvents();
  assert.ok(!events.includes("subscription.created"));
  assert.ok(!events.includes("subscription.updated"));
  assert.ok(!events.includes("subscription.deleted"));
  // The real, prefixed events remain supported.
  assert.ok(events.includes("customer.subscription.created"));
  assert.ok(events.includes("customer.subscription.deleted"));
}

function testNormalizeBackfillRecordTsParityWithWebhook() {
  const connector = createConnector();

  const object = {
    id: "pi_123",
    object: "payment_intent",
    created: CREATED_EPOCH,
    amount: 4200,
    currency: "usd",
    status: "succeeded",
  };

  const backfill = connector.normalizeBackfillRecord("payment_intents", object);
  assert.ok(backfill);
  assert.equal(backfill?.recordId, "pi_123");
  assert.equal(backfill?.source, "backfill");
  assert.equal(backfill?.sourceTs.getTime(), CREATED_MS);

  const webhookRecords = connector.extractWebhookCdcRecords(
    {
      id: "evt_1",
      type: "payment_intent.succeeded",
      data: { object },
    },
    "payment_intent.succeeded",
  );

  assert.equal(webhookRecords.length, 1);
  const webhook = webhookRecords[0];
  assert.equal(webhook.entity, "payment_intents");
  assert.equal(webhook.recordId, "pi_123");
  // Backfill and webhook records must agree on the source timestamp.
  assert.equal(backfill?.sourceTs.getTime(), webhook.sourceTs.getTime());
}

function testDisputeEventsMapToDisputesEntity() {
  const connector = createConnector();
  assert.deepEqual(connector.getWebhookEventMapping("charge.dispute.created"), {
    entity: "disputes",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("charge.dispute.closed"), {
    entity: "disputes",
    operation: "upsert",
  });

  const events = connector.getWebhookEventsForEntities(["disputes"]).sort();
  assert.deepEqual(events, [
    "charge.dispute.closed",
    "charge.dispute.created",
    "charge.dispute.funds_reinstated",
    "charge.dispute.funds_withdrawn",
    "charge.dispute.updated",
  ]);
}

function testPriceEventsMapToPricesEntity() {
  const connector = createConnector();
  assert.deepEqual(connector.getWebhookEventMapping("price.created"), {
    entity: "prices",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("price.updated"), {
    entity: "prices",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("price.deleted"), {
    entity: "prices",
    operation: "delete",
  });

  // Legacy plan events still map to the plans entity.
  assert.deepEqual(connector.getWebhookEventMapping("plan.created"), {
    entity: "plans",
    operation: "upsert",
  });

  assert.deepEqual(
    connector.getWebhookEventMapping("payment_intent.succeeded"),
    { entity: "payment_intents", operation: "upsert" },
  );
}

function testWebhookEventsForEntities() {
  const connector = createConnector();

  assert.deepEqual(connector.getWebhookEventsForEntities(["prices"]).sort(), [
    "price.created",
    "price.deleted",
    "price.updated",
  ]);

  const piEvents = connector
    .getWebhookEventsForEntities(["payment_intents"])
    .sort();
  assert.deepEqual(piEvents, [
    "payment_intent.canceled",
    "payment_intent.created",
    "payment_intent.payment_failed",
    "payment_intent.succeeded",
  ]);

  // Empty selection subscribes to everything.
  assert.deepEqual(
    connector.getWebhookEventsForEntities([]),
    connector.getSupportedWebhookEvents(),
  );
}

function testSupportsWebhookProvisioning() {
  const connector = createConnector();
  assert.equal(connector.supportsWebhooks(), true);
  assert.equal(connector.supportsWebhookProvisioning(), true);
}

async function testCreateWebhookSubscriptionPayload() {
  const connector = createConnector();

  let capturedParams: any;
  // Inject a mock Stripe client so no real API call is made.
  (connector as any).stripe = {
    webhookEndpoints: {
      create: async (params: any) => {
        capturedParams = params;
        return {
          id: "we_test_123",
          url: params.url,
          secret: "whsec_mock_secret",
        };
      },
    },
  };

  const result = await connector.createWebhookSubscription({
    endpointUrl: "https://example.com/api/webhooks/ws/flow",
    enabledEntities: ["prices"],
  });

  assert.equal(result.providerWebhookId, "we_test_123");
  assert.equal(result.endpointUrl, "https://example.com/api/webhooks/ws/flow");
  assert.equal(result.signingSecret, "whsec_mock_secret");

  assert.equal(capturedParams.url, "https://example.com/api/webhooks/ws/flow");
  assert.equal(capturedParams.api_version, "2023-10-16");
  assert.deepEqual([...capturedParams.enabled_events].sort(), [
    "price.created",
    "price.deleted",
    "price.updated",
  ]);
}

async function testCreateWebhookSubscriptionRejectsUnknownEvents() {
  const connector = createConnector();
  (connector as any).stripe = {
    webhookEndpoints: { create: async () => ({ id: "x", url: "y" }) },
  };

  await assert.rejects(
    () =>
      connector.createWebhookSubscription({
        endpointUrl: "https://example.com/hook",
        events: ["not.a.real.event"],
      }),
    /No valid Stripe webhook events/,
  );
}

function testHostConfigFromApiBaseUrl() {
  const connector = createConnector({
    api_base_url: "http://localhost:12111",
  }) as unknown as {
    resolveHostConfig(): Record<string, unknown>;
  };
  assert.deepEqual(connector.resolveHostConfig(), {
    host: "localhost",
    protocol: "http",
    port: 12111,
  });

  const defaultConnector = createConnector({
    api_base_url: "https://api.stripe.com",
  }) as unknown as { resolveHostConfig(): Record<string, unknown> };
  assert.deepEqual(defaultConnector.resolveHostConfig(), {});

  const noUrlConnector = createConnector() as unknown as {
    resolveHostConfig(): Record<string, unknown>;
  };
  assert.deepEqual(noUrlConnector.resolveHostConfig(), {});
}

async function main() {
  testConfigValidationRequiresApiKey();
  testAvailableEntitiesIncludeModernEntities();
  testResolveRecordTimestampUsesEpochCreated();
  testResolveRecordTimestampHandlesMillisGuard();
  testResolveRecordTimestampFallsBackToStringFields();
  await testResolveSchema();
  await testSubscriptionsBackfillRequestsAllStatuses();
  testNormalizeBackfillRecordTsParityWithWebhook();
  testDisputeEventsMapToDisputesEntity();
  testPriceEventsMapToPricesEntity();
  testNoLegacySubscriptionWebhookEvents();
  testWebhookEventsForEntities();
  testSupportsWebhookProvisioning();
  await testCreateWebhookSubscriptionPayload();
  await testCreateWebhookSubscriptionRejectsUnknownEvents();
  testHostConfigFromApiBaseUrl();
}

main().catch((error: unknown) => {
  throw error;
});
