import assert from "node:assert/strict";
import { StripeConnector } from "./connector";
import { resolveStripeEntitySchema } from "./schema";

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

function testEveryEntityHasSchemaAndLabel() {
  const connector = createConnector();
  const entities = connector.getAvailableEntities();
  const metadata = connector.getEntityMetadata();
  assert.equal(metadata.length, entities.length);
  for (const entity of entities) {
    assert.ok(
      resolveStripeEntitySchema(entity),
      `missing schema for Stripe entity ${entity}`,
    );
    const meta = metadata.find(entry => entry.name === entity);
    assert.ok(meta?.label, `missing label for Stripe entity ${entity}`);
  }
}

function testMoneyMovementEntitiesAvailable() {
  const entities = createConnector().getAvailableEntities();
  for (const entity of [
    "balance_transactions",
    "payouts",
    "payout_balance_transactions",
    "refunds",
    "credit_notes",
    "customer_balance_transactions",
    "invoice_items",
    "subscription_schedules",
    "coupons",
    "promotion_codes",
    "checkout_sessions",
    "setup_intents",
    "early_fraud_warnings",
  ]) {
    assert.ok(entities.includes(entity), `${entity} should be syncable`);
  }
}

async function testTopLevelMoneyEntitiesApplyCreatedAnchor() {
  const connector = createConnector();
  const calls: Array<{ resource: string; params: Record<string, unknown> }> =
    [];
  const lister = (resource: string) => ({
    list: async (params: Record<string, unknown>) => {
      calls.push({ resource, params });
      return { data: [{ id: `${resource}_1` }], has_more: false };
    },
  });
  (connector as any).stripe = {
    balanceTransactions: lister("balance_transactions"),
    payouts: lister("payouts"),
    refunds: lister("refunds"),
    creditNotes: lister("credit_notes"),
    checkout: { sessions: lister("checkout_sessions") },
    radar: { earlyFraudWarnings: lister("early_fraud_warnings") },
  };

  const since = new Date(CREATED_MS);
  for (const entity of [
    "balance_transactions",
    "payouts",
    "refunds",
    "credit_notes",
    "checkout_sessions",
    "early_fraud_warnings",
  ]) {
    const batches: unknown[][] = [];
    await connector.fetchEntity({
      entity,
      since,
      onBatch: async (records: unknown[]) => {
        batches.push(records);
      },
    } as any);
    assert.equal(batches.length, 1, `${entity} should emit one batch`);
  }

  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.deepEqual(
      call.params.created,
      { gte: CREATED_EPOCH },
      `${call.resource} should filter by created[gte]`,
    );
  }
}

function pagedChildren<T>(items: T[]) {
  return { autoPagingToArray: async () => items };
}

async function testPayoutBalanceTransactionsCarryPayoutId() {
  const connector = createConnector();
  const childCalls: Array<Record<string, unknown>> = [];
  (connector as any).stripe = {
    payouts: {
      list: async () => ({
        data: [{ id: "po_1" }, { id: "po_2" }],
        has_more: true,
      }),
    },
    balanceTransactions: {
      list: (params: Record<string, unknown>) => {
        childCalls.push(params);
        return pagedChildren([
          { id: `txn_${String(params.payout)}_a`, type: "charge" },
          { id: `txn_${String(params.payout)}_b`, type: "payout" },
        ]);
      },
    },
  };

  const records: Array<Record<string, unknown>> = [];
  const state = await connector.fetchEntityChunk({
    entity: "payout_balance_transactions",
    maxIterations: 1,
    onBatch: async (batch: Array<Record<string, unknown>>) => {
      records.push(...batch);
    },
  } as any);

  assert.deepEqual(
    childCalls.map(call => call.payout),
    ["po_1", "po_2"],
  );
  assert.equal(records.length, 4);
  assert.ok(records.every(record => typeof record.payout === "string"));
  assert.equal(
    records.find(record => record.id === "txn_po_2_a")?.payout,
    "po_2",
  );
  // The resumable cursor walks payouts, not the transactions inside them.
  assert.equal(state.cursor, "po_2");
  assert.equal(state.hasMore, true);
}

async function testCustomerBalanceTransactionsIgnoreSince() {
  const connector = createConnector();
  const customerParams: Array<Record<string, unknown>> = [];
  const listedFor: string[] = [];
  (connector as any).stripe = {
    customers: {
      list: async (params: Record<string, unknown>) => {
        customerParams.push(params);
        return { data: [{ id: "cus_1" }, { id: "cus_2" }], has_more: false };
      },
      listBalanceTransactions: (customerId: string) => {
        listedFor.push(customerId);
        return pagedChildren(
          customerId === "cus_1"
            ? [{ id: "cbtxn_1", customer: "cus_1", amount: -5000 }]
            : [],
        );
      },
    },
  };

  const records: Array<Record<string, unknown>> = [];
  await connector.fetchEntity({
    entity: "customer_balance_transactions",
    since: new Date(CREATED_MS),
    onBatch: async (batch: Array<Record<string, unknown>>) => {
      records.push(...batch);
    },
  } as any);

  // Old customers keep receiving credit: never bound the walk by creation.
  assert.equal(customerParams.length, 1);
  assert.equal(customerParams[0].created, undefined);
  assert.deepEqual(listedFor, ["cus_1", "cus_2"]);
  assert.deepEqual(
    records.map(record => record.id),
    ["cbtxn_1"],
  );

  const capabilities = connector.getIncrementalCapabilities();
  assert.equal(
    capabilities.perEntity?.customer_balance_transactions?.mode,
    "none",
  );
}

function testMoneyMovementWebhookEvents() {
  const connector = createConnector();
  assert.deepEqual(connector.getWebhookEventMapping("payout.paid"), {
    entity: "payouts",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("charge.refund.updated"), {
    entity: "refunds",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("credit_note.voided"), {
    entity: "credit_notes",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("invoiceitem.deleted"), {
    entity: "invoice_items",
    operation: "delete",
  });
  assert.deepEqual(connector.getWebhookEventMapping("coupon.deleted"), {
    entity: "coupons",
    operation: "delete",
  });

  assert.deepEqual(connector.getWebhookEventsForEntities(["payouts"]).sort(), [
    "payout.canceled",
    "payout.created",
    "payout.failed",
    "payout.paid",
    "payout.reconciliation_completed",
    "payout.updated",
  ]);
  // Polled-only entities subscribe to nothing.
  assert.deepEqual(
    connector.getWebhookEventsForEntities([
      "balance_transactions",
      "payout_balance_transactions",
      "customer_balance_transactions",
    ]),
    [],
  );

  // Every supported event maps to a syncable entity.
  const entities = new Set(connector.getAvailableEntities());
  for (const event of connector.getSupportedWebhookEvents()) {
    const mapping = connector.getWebhookEventMapping(event);
    assert.ok(mapping, `${event} has no entity mapping`);
    assert.ok(entities.has(mapping.entity), `${event} maps to unknown entity`);
  }
}

function stubWebhookEndpoints(
  connector: StripeConnector,
  endpoints: Array<{ id: string; url: string; status: string }>,
) {
  const updates: Array<{ id: string; params: Record<string, unknown> }> = [];
  (connector as any).stripe = {
    webhookEndpoints: {
      list: () => ({ autoPagingToArray: async () => endpoints }),
      update: async (id: string, params: Record<string, unknown>) => {
        updates.push({ id, params });
        return { id, url: endpoints.find(e => e.id === id)?.url };
      },
    },
  };
  return updates;
}

async function testUpdateWebhookSubscriptionRetargetsInPlace() {
  const connector = createConnector();
  assert.equal(connector.supportsWebhookSubscriptionUpdate(), true);

  const url = "https://mako.example/api/webhooks/ws/flow";
  const updates = stubWebhookEndpoints(connector, [
    {
      id: "we_other",
      url: "https://elsewhere.example/hook",
      status: "enabled",
    },
    { id: "we_flow", url, status: "enabled" },
  ]);

  const result = await connector.updateWebhookSubscription({
    endpointUrl: url,
    enabledEntities: ["payouts", "disputes"],
  });

  assert.deepEqual(result, { providerWebhookId: "we_flow", endpointUrl: url });
  assert.equal(updates.length, 1, "only the flow's endpoint is touched");
  assert.equal(updates[0].id, "we_flow");
  assert.equal(updates[0].params.disabled, false);
  const events = (updates[0].params.enabled_events as string[]).slice().sort();
  assert.ok(events.includes("payout.paid"));
  assert.ok(events.includes("charge.dispute.closed"));
  assert.ok(!events.includes("invoice.paid"), "unselected entity excluded");
  // Signing secrets are never re-issued by an update.
  assert.equal((result as any).signingSecret, undefined);
}

async function testUpdateWebhookSubscriptionHandlesDuplicates() {
  const connector = createConnector();
  const url = "https://mako.example/api/webhooks/ws/flow";
  const updates = stubWebhookEndpoints(connector, [
    { id: "we_stale", url, status: "disabled" },
    { id: "we_live", url, status: "enabled" },
  ]);

  const result = await connector.updateWebhookSubscription({
    endpointUrl: url,
    enabledEntities: ["invoices"],
  });

  // Without a stored id, the endpoint Stripe still delivers to wins.
  assert.equal(result?.providerWebhookId, "we_live");
  assert.deepEqual(updates.map(update => update.id).sort(), [
    "we_live",
    "we_stale",
  ]);
  assert.equal(
    updates.find(update => update.id === "we_stale")?.params.disabled,
    undefined,
    "a stale duplicate is not re-enabled",
  );

  // A stored id overrides the health heuristic.
  const pinned = stubWebhookEndpoints(connector, [
    { id: "we_stale", url, status: "disabled" },
    { id: "we_live", url, status: "enabled" },
  ]);
  const pinnedResult = await connector.updateWebhookSubscription({
    endpointUrl: url,
    enabledEntities: ["invoices"],
    providerWebhookId: "we_stale",
  });
  assert.equal(pinnedResult?.providerWebhookId, "we_stale");
  assert.equal(
    pinned.find(update => update.id === "we_stale")?.params.disabled,
    false,
  );
}

async function testUpdateWebhookSubscriptionReturnsNullWithoutMatch() {
  const connector = createConnector();
  const updates = stubWebhookEndpoints(connector, [
    {
      id: "we_other",
      url: "https://elsewhere.example/hook",
      status: "enabled",
    },
  ]);
  const result = await connector.updateWebhookSubscription({
    endpointUrl: "https://mako.example/api/webhooks/ws/flow",
    enabledEntities: ["invoices"],
  });
  assert.equal(result, null);
  assert.equal(updates.length, 0);
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
  testEveryEntityHasSchemaAndLabel();
  testMoneyMovementEntitiesAvailable();
  await testTopLevelMoneyEntitiesApplyCreatedAnchor();
  await testPayoutBalanceTransactionsCarryPayoutId();
  await testCustomerBalanceTransactionsIgnoreSince();
  testMoneyMovementWebhookEvents();
  await testUpdateWebhookSubscriptionRetargetsInPlace();
  await testUpdateWebhookSubscriptionHandlesDuplicates();
  await testUpdateWebhookSubscriptionReturnsNullWithoutMatch();
}

main().catch((error: unknown) => {
  throw error;
});
