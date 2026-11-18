/**
 * Stripe webhook provisioning: the events per entity, endpoint create
 * pinned to the API version, and retarget of the endpoint(s) on the flow
 * URL. Moved from stripe/connector.test.ts with the code.
 *
 * Run: node --import tsx src/connectors/vendor-webhooks/stripe.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type Stripe from "stripe";
import { stripeWebhookProvisioner } from "../workspace/webhook-provisioners";
import {
  STRIPE_API_VERSION,
  stripeSupportedWebhookEvents,
  stripeWebhookEventsForEntities,
} from "./stripe";

const URL = "https://mako.example/api/webhooks/ws/flow";

void test("events per entity; no entities means every supported event", () => {
  assert.deepEqual(stripeWebhookEventsForEntities(["prices"]).sort(), [
    "price.created",
    "price.deleted",
    "price.updated",
  ]);
  assert.deepEqual(stripeWebhookEventsForEntities(["payment_intents"]).sort(), [
    "payment_intent.canceled",
    "payment_intent.created",
    "payment_intent.payment_failed",
    "payment_intent.succeeded",
  ]);
  assert.deepEqual(stripeWebhookEventsForEntities(["disputes"]).sort(), [
    "charge.dispute.closed",
    "charge.dispute.created",
    "charge.dispute.funds_reinstated",
    "charge.dispute.funds_withdrawn",
    "charge.dispute.updated",
  ]);
  assert.deepEqual(stripeWebhookEventsForEntities(["payouts"]).sort(), [
    "payout.canceled",
    "payout.created",
    "payout.failed",
    "payout.paid",
    "payout.reconciliation_completed",
    "payout.updated",
  ]);
  assert.deepEqual(
    stripeWebhookEventsForEntities([]),
    stripeSupportedWebhookEvents(),
  );
});

void test("deprecated and polled-only events are never subscribed", () => {
  // Stripe rejects deprecated event types and fails the whole endpoint
  // request with them.
  assert.ok(!stripeSupportedWebhookEvents().includes("invoiceitem.updated"));
  assert.deepEqual(
    stripeWebhookEventsForEntities([
      "balance_transactions",
      "payout_balance_transactions",
      "customer_balance_transactions",
    ]),
    [],
  );
});

void test("create pins the API version and subscribes the entity's events", async () => {
  let captured: any;
  const provisioner = stripeWebhookProvisioner({
    webhookEndpoints: {
      create: async (params: any) => {
        captured = params;
        return { id: "we_test_123", url: params.url, secret: "whsec_mock" };
      },
    },
  } as unknown as Stripe);

  const result = await provisioner.create({
    endpointUrl: URL,
    enabledEntities: ["prices"],
  });

  assert.equal(result.providerWebhookId, "we_test_123");
  assert.equal(result.endpointUrl, URL);
  assert.equal(result.signingSecret, "whsec_mock");
  assert.equal(captured.url, URL);
  assert.equal(captured.api_version, "2023-10-16");
  assert.equal(captured.api_version, STRIPE_API_VERSION);
  assert.deepEqual([...captured.enabled_events].sort(), [
    "price.created",
    "price.deleted",
    "price.updated",
  ]);
});

void test("create rejects unknown events", async () => {
  const provisioner = stripeWebhookProvisioner({
    webhookEndpoints: { create: async () => ({ id: "x", url: "y" }) },
  } as unknown as Stripe);
  // `create` throws synchronously here; callers await it in an async method.
  await assert.rejects(
    async () =>
      provisioner.create({
        endpointUrl: "https://example.com/hook",
        events: ["not.a.real.event"],
      }),
    /No valid Stripe webhook events/,
  );
});

function stubEndpoints(
  endpoints: Array<{ id: string; url: string; status: string }>,
) {
  const updates: Array<{ id: string; params: Record<string, unknown> }> = [];
  const provisioner = stripeWebhookProvisioner({
    webhookEndpoints: {
      list: () => ({ autoPagingToArray: async () => endpoints }),
      update: async (id: string, params: Record<string, unknown>) => {
        updates.push({ id, params });
        return { id, url: endpoints.find(e => e.id === id)?.url };
      },
    },
  } as unknown as Stripe);
  return { provisioner, updates };
}

void test("update retargets only the flow's endpoint, in place", async () => {
  const { provisioner, updates } = stubEndpoints([
    {
      id: "we_other",
      url: "https://elsewhere.example/hook",
      status: "enabled",
    },
    { id: "we_flow", url: URL, status: "enabled" },
  ]);
  const result = await provisioner.update({
    endpointUrl: URL,
    enabledEntities: ["payouts", "disputes"],
  });

  assert.deepEqual(result, { providerWebhookId: "we_flow", endpointUrl: URL });
  assert.equal(updates.length, 1, "only the flow's endpoint is touched");
  assert.equal(updates[0].id, "we_flow");
  assert.equal(updates[0].params.disabled, false);
  const events = (updates[0].params.enabled_events as string[]).slice().sort();
  assert.ok(events.includes("payout.paid"));
  assert.ok(events.includes("charge.dispute.closed"));
  assert.ok(!events.includes("invoice.paid"), "unselected entity excluded");
  // Signing secrets are never re-issued by an update.
  assert.equal((result as any).signingSecret, undefined);
});

void test("update handles duplicates: the healthy one wins unless an id is stored", async () => {
  const { provisioner, updates } = stubEndpoints([
    { id: "we_stale", url: URL, status: "disabled" },
    { id: "we_live", url: URL, status: "enabled" },
  ]);
  const result = await provisioner.update({
    endpointUrl: URL,
    enabledEntities: ["invoices"],
  });
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

  const pinned = stubEndpoints([
    { id: "we_stale", url: URL, status: "disabled" },
    { id: "we_live", url: URL, status: "enabled" },
  ]);
  const pinnedResult = await pinned.provisioner.update({
    endpointUrl: URL,
    enabledEntities: ["invoices"],
    providerWebhookId: "we_stale",
  });
  assert.equal(pinnedResult?.providerWebhookId, "we_stale");
  assert.equal(
    pinned.updates.find(update => update.id === "we_stale")?.params.disabled,
    false,
  );
});

void test("update resolves null when no endpoint is on the URL", async () => {
  const { provisioner, updates } = stubEndpoints([
    {
      id: "we_other",
      url: "https://elsewhere.example/hook",
      status: "enabled",
    },
  ]);
  const result = await provisioner.update({
    endpointUrl: URL,
    enabledEntities: ["invoices"],
  });
  assert.equal(result, null);
  assert.equal(updates.length, 0);
});
