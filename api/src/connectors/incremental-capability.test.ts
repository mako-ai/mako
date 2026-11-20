import assert from "node:assert/strict";
import { StripeConnector } from "./stripe/connector";
import { ClaapConnector } from "./claap/connector";
import { CalendlyConnector } from "./calendly/connector";
import { RestConnector } from "./rest/connector";
import { GraphQLConnector } from "./graphql/connector";
import {
  BaseConnector,
  type IncrementalCapabilities,
  type IncrementalMode,
} from "./base/BaseConnector";

/**
 * Contract test for the `getIncrementalCapabilities()` audit in
 * docs/sync-modes-hardening-plan.md (Phase 4). Every connector must return a
 * well-formed declaration, and the ones audited to have a real capability
 * gap must declare it honestly rather than defaulting to "supported".
 */

const VALID_MODES: IncrementalMode[] = [
  "native",
  "client-filter",
  "created-anchor",
  "none",
];

function assertWellFormed(
  label: string,
  capabilities: IncrementalCapabilities,
) {
  assert.ok(
    VALID_MODES.includes(capabilities.mode),
    `${label}: mode "${capabilities.mode}" is not a valid IncrementalMode`,
  );
  assert.equal(
    typeof capabilities.supported,
    "boolean",
    `${label}: supported must be a boolean`,
  );
  // supported=false must mean mode is "none" — otherwise the UI would gate
  // Incremental off while the connector claims a real (better) mode.
  if (!capabilities.supported) {
    assert.equal(
      capabilities.mode,
      "none",
      `${label}: supported=false but mode is "${capabilities.mode}", not "none"`,
    );
  }
  for (const [entity, override] of Object.entries(
    capabilities.perEntity || {},
  )) {
    assert.ok(
      VALID_MODES.includes(override.mode),
      `${label}.perEntity.${entity}: invalid mode "${override.mode}"`,
    );
  }
}

const connectors: Array<{
  label: string;
  make: () => BaseConnector;
}> = [
  {
    label: "stripe",
    make: () =>
      new StripeConnector({
        id: "ds_stripe",
        name: "Stripe",
        type: "stripe",
        config: { api_key: "sk_test_123" },
      } as any),
  },
  {
    label: "claap",
    make: () =>
      new ClaapConnector({
        id: "ds_claap",
        name: "Claap",
        type: "claap",
        config: {
          api_key: "cla_test_key",
          api_base_url: "https://api.claap.io",
        },
      } as any),
  },
  {
    label: "calendly",
    make: () =>
      new CalendlyConnector({
        id: "ds_calendly",
        name: "Calendly",
        type: "calendly",
        config: {
          access_token: "pat_test_token",
          api_base_url: "https://api.calendly.com",
        },
      } as any),
  },
  {
    label: "rest",
    make: () =>
      new RestConnector({
        id: "ds_rest",
        name: "REST",
        type: "rest",
        config: {},
      } as any),
  },
  {
    label: "graphql",
    make: () =>
      new GraphQLConnector({
        id: "ds_graphql",
        name: "GraphQL",
        type: "graphql",
        config: {},
      } as any),
  },
];

function capabilitiesFor(label: string): IncrementalCapabilities {
  const entry = connectors.find(c => c.label === label);
  if (!entry) throw new Error(`No connector registered for label "${label}"`);
  return entry.make().getIncrementalCapabilities();
}

function testEveryConnectorReturnsWellFormedCapabilities() {
  for (const { label, make } of connectors) {
    const capabilities = make().getIncrementalCapabilities();
    assertWellFormed(label, capabilities);
  }
}

function testGraphQLDeclaresClientFilterWithSinceInjection() {
  const graphql = capabilitiesFor("graphql");
  assert.equal(graphql.supported, true);
  assert.equal(graphql.mode, "client-filter");
  assert.ok(graphql.warning && graphql.warning.includes("$since"));
}

function testCreatedAnchorConnectorsWarnAboutMissedUpdates() {
  // Stripe filters every entity by `created[gte]` only — updates to
  // existing records are invisible to a poll.
  const stripe = capabilitiesFor("stripe");
  assert.equal(stripe.mode, "created-anchor");
  assert.equal(stripe.supported, true);
  assert.ok(stripe.warning && stripe.warning.length > 0);

  // Claap: recordings is created-anchor, workspace is none.
  const claap = capabilitiesFor("claap");
  assert.equal(claap.mode, "none"); // fallback (workspace)
  assert.equal(claap.perEntity?.recordings?.mode, "created-anchor");
}

function testRestDeclaresClientFilterWithWarning() {
  const rest = capabilitiesFor("rest");
  assert.equal(rest.mode, "client-filter");
  assert.ok(rest.warning && rest.warning.length > 0);
}

async function testStripeCreatedGteWhenSinceSet() {
  const connector = new StripeConnector({
    id: "ds_stripe",
    name: "Stripe",
    type: "stripe",
    config: { api_key: "sk_test_123" },
  } as any);

  let captured: any;
  (connector as any).stripe = {
    customers: {
      list: async (params: any) => {
        captured = params;
        return { data: [], has_more: false };
      },
    },
  };

  await connector.fetchEntityChunk({
    entity: "customers",
    since: new Date("2026-07-15T00:00:00.000Z"),
    onBatch: async () => {},
  } as any);

  assert.equal(typeof captured?.created?.gte, "number");
  assert.ok(captured.created.gte > 0);
}

async function main() {
  testEveryConnectorReturnsWellFormedCapabilities();
  testGraphQLDeclaresClientFilterWithSinceInjection();
  testCreatedAnchorConnectorsWarnAboutMissedUpdates();
  await testStripeCreatedGteWhenSinceSet();
  testRestDeclaresClientFilterWithWarning();
}

main().catch((error: unknown) => {
  throw error;
});
