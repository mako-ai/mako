/**
 * Stripe webhook provisioning: the subscribed events and the endpoint create
 * and update calls, run in the API process.
 * Run: node --import tsx src/webhook-provisioning/stripe.test.ts
 */
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { stripeWebhookProvisioner } from "../connectors/workspace/webhook-provisioners";
import {
  STRIPE_API_VERSION,
  stripeSupportedWebhookEvents,
  stripeWebhookEventsForEntities,
} from "./stripe";

function testSubscribesAllNinetyFourEvents() {
  const events = stripeSupportedWebhookEvents();
  assert.equal(events.length, 94);
  assert.equal(new Set(events).size, 94);
  assert.equal(STRIPE_API_VERSION, "2023-10-16");
  // Stripe rejects deprecated event types and fails the whole endpoint
  // request with them, so they must never be subscribed.
  assert.ok(!events.includes("invoiceitem.updated"));
  assert.ok(events.includes("payment_method.attached"));
}

function testEventsForEntities() {
  assert.deepEqual(stripeWebhookEventsForEntities(["payouts"]).sort(), [
    "payout.canceled",
    "payout.created",
    "payout.failed",
    "payout.paid",
    "payout.reconciliation_completed",
    "payout.updated",
  ]);
  // Polled-only entities subscribe to nothing.
  assert.deepEqual(
    stripeWebhookEventsForEntities([
      "balance_transactions",
      "payout_balance_transactions",
      "customer_balance_transactions",
    ]),
    [],
  );
  // An empty selection is every supported event.
  assert.deepEqual(
    stripeWebhookEventsForEntities([]),
    stripeSupportedWebhookEvents(),
  );
  // Children ride on their parent's events.
  const children = stripeWebhookEventsForEntities([
    "invoice_line_items",
    "subscription_items",
  ]);
  assert.ok(children.includes("invoice.paid"));
  assert.ok(children.includes("customer.subscription.updated"));
}

async function testCreateWebhookSubscriptionPayload() {
  let capturedParams: any;
  const stripe = {
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
  } as unknown as Stripe;

  const result = await stripeWebhookProvisioner(stripe).create({
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
  const stripe = {
    webhookEndpoints: { create: async () => ({ id: "x", url: "y" }) },
  } as unknown as Stripe;

  await assert.rejects(
    async () =>
      stripeWebhookProvisioner(stripe).create({
        endpointUrl: "https://example.com/hook",
        events: ["not.a.real.event"],
      }),
    /No valid Stripe webhook events/,
  );
}

function stubWebhookEndpoints(
  endpoints: Array<{ id: string; url: string; status: string }>,
) {
  const updates: Array<{ id: string; params: Record<string, unknown> }> = [];
  const stripe = {
    webhookEndpoints: {
      list: () => ({ autoPagingToArray: async () => endpoints }),
      update: async (id: string, params: Record<string, unknown>) => {
        updates.push({ id, params });
        return { id, url: endpoints.find(e => e.id === id)?.url };
      },
    },
  } as unknown as Stripe;
  return { stripe, updates };
}

async function testUpdateWebhookSubscriptionRetargetsInPlace() {
  const url = "https://mako.example/api/webhooks/ws/flow";
  const { stripe, updates } = stubWebhookEndpoints([
    {
      id: "we_other",
      url: "https://elsewhere.example/hook",
      status: "enabled",
    },
    { id: "we_flow", url, status: "enabled" },
  ]);

  const result = await stripeWebhookProvisioner(stripe).update({
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
  const url = "https://mako.example/api/webhooks/ws/flow";
  const first = stubWebhookEndpoints([
    { id: "we_stale", url, status: "disabled" },
    { id: "we_live", url, status: "enabled" },
  ]);

  const result = await stripeWebhookProvisioner(first.stripe).update({
    endpointUrl: url,
    enabledEntities: ["invoices"],
  });

  // Without a stored id, the endpoint Stripe still delivers to wins.
  assert.equal(result?.providerWebhookId, "we_live");
  assert.deepEqual(first.updates.map(update => update.id).sort(), [
    "we_live",
    "we_stale",
  ]);
  assert.equal(
    first.updates.find(update => update.id === "we_stale")?.params.disabled,
    undefined,
    "a stale duplicate is not re-enabled",
  );

  // A stored id overrides the health heuristic.
  const pinned = stubWebhookEndpoints([
    { id: "we_stale", url, status: "disabled" },
    { id: "we_live", url, status: "enabled" },
  ]);
  const pinnedResult = await stripeWebhookProvisioner(pinned.stripe).update({
    endpointUrl: url,
    enabledEntities: ["invoices"],
    providerWebhookId: "we_stale",
  });
  assert.equal(pinnedResult?.providerWebhookId, "we_stale");
  assert.equal(
    pinned.updates.find(update => update.id === "we_stale")?.params.disabled,
    false,
  );
}

async function testUpdateWebhookSubscriptionReturnsNullWithoutMatch() {
  const { stripe, updates } = stubWebhookEndpoints([
    {
      id: "we_other",
      url: "https://elsewhere.example/hook",
      status: "enabled",
    },
  ]);
  const result = await stripeWebhookProvisioner(stripe).update({
    endpointUrl: "https://mako.example/api/webhooks/ws/flow",
    enabledEntities: ["invoices"],
  });
  assert.equal(result, null);
  assert.equal(updates.length, 0);
}

async function main() {
  testSubscribesAllNinetyFourEvents();
  testEventsForEntities();
  await testCreateWebhookSubscriptionPayload();
  await testCreateWebhookSubscriptionRejectsUnknownEvents();
  await testUpdateWebhookSubscriptionRetargetsInPlace();
  await testUpdateWebhookSubscriptionHandlesDuplicates();
  await testUpdateWebhookSubscriptionReturnsNullWithoutMatch();
}

main().catch((error: unknown) => {
  throw error;
});
