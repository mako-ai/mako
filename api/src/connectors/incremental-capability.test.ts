import assert from "node:assert/strict";
import { StripeConnector } from "./stripe/connector";
import { CloseConnector } from "./close/connector";
import { PandaDocConnector } from "./pandadoc/connector";
import { ClaapConnector } from "./claap/connector";
import { CalendlyConnector } from "./calendly/connector";
import { RestConnector } from "./rest/connector";
import { GraphQLConnector } from "./graphql/connector";
import { PosthogConnector } from "./posthog/connector";
import { BigQueryConnector } from "./bigquery/connector";
import { WiseConnector } from "./wise/connector";
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
    label: "close",
    make: () =>
      new CloseConnector({
        id: "ds_close",
        name: "Close",
        type: "close",
        config: { api_key: "test-key" },
      } as any),
  },
  {
    label: "pandadoc",
    make: () =>
      new PandaDocConnector({
        id: "ds_pandadoc",
        name: "PandaDoc",
        type: "pandadoc",
        config: {
          api_key: "test-api-key",
          api_base_url: "https://api.pandadoc.com",
        },
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
  {
    label: "posthog",
    make: () =>
      new PosthogConnector({
        id: "ds_posthog",
        name: "PostHog",
        type: "posthog",
        config: {},
      } as any),
  },
  {
    label: "bigquery",
    make: () =>
      new BigQueryConnector({
        id: "ds_bigquery",
        name: "BigQuery",
        type: "bigquery",
        config: {},
      } as any),
  },
  {
    label: "wise",
    make: () =>
      new WiseConnector({
        id: "ds_wise",
        name: "Wise",
        type: "wise",
        config: { api_key: "test-token" },
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

function testConnectorsWithNoRealIncrementalDeclareNone() {
  // BigQuery still accepts `since` without applying it. GraphQL/PostHog now
  // declare real incremental modes (client-filter / $since substitution).
  const bigquery = capabilitiesFor("bigquery");
  assert.equal(bigquery.supported, false, "bigquery.supported");
  assert.equal(bigquery.mode, "none", "bigquery.mode");
}

function testGraphQLDeclaresClientFilterWithSinceInjection() {
  const graphql = capabilitiesFor("graphql");
  assert.equal(graphql.supported, true);
  assert.equal(graphql.mode, "client-filter");
  assert.ok(graphql.warning && graphql.warning.includes("$since"));
}

function testPosthogDeclaresNativeSincePlaceholder() {
  const posthog = capabilitiesFor("posthog");
  assert.equal(posthog.supported, true);
  assert.equal(posthog.mode, "native");
  assert.equal(posthog.anchorField, "$since");
  assert.ok(posthog.warning && posthog.warning.includes("$since"));
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

function testCloseSearchApiEntitiesDeclareNative() {
  const close = capabilitiesFor("close");
  assert.equal(close.mode, "native");
  assert.equal(close.perEntity?.leads?.mode, "native");
  assert.equal(close.perEntity?.leads?.anchorField, "date_updated");
  assert.equal(close.perEntity?.users?.mode, "native");
  assert.equal(close.perEntity?.groups?.mode, "none");
}

function testPandadocDocumentsAreNativeContactsAreNot() {
  const pandadoc = capabilitiesFor("pandadoc");
  assert.equal(pandadoc.perEntity?.documents?.mode, "native");
  assert.equal(pandadoc.perEntity?.documents?.anchorField, "modified_from");
  assert.equal(pandadoc.mode, "none"); // fallback covers "contacts"
}

function testRestDeclaresClientFilterWithWarning() {
  const rest = capabilitiesFor("rest");
  assert.equal(rest.mode, "client-filter");
  assert.ok(rest.warning && rest.warning.length > 0);
}

function testWiseCreatedAnchorTransfersAndNoneFallback() {
  const wise = capabilitiesFor("wise");
  assert.equal(wise.supported, true);
  assert.equal(wise.mode, "none");
  assert.equal(wise.perEntity?.transfers?.mode, "created-anchor");
  assert.equal(wise.perEntity?.transfers?.anchorField, "createdDateStart");
  assert.equal(wise.perEntity?.activities?.mode, "client-filter");
  assert.ok(wise.warning && wise.warning.length > 0);
}

async function testCloseSearchApiUsesDateUpdatedWhenSinceSet() {
  const connector = new CloseConnector({
    id: "ds_close",
    name: "Close",
    type: "close",
    config: { api_key: "test-key" },
  } as any);

  const bodies: any[] = [];
  (connector as any).closeApi = {
    post: async (_path: string, body: any) => {
      bodies.push(body);
      // Oldest/count probes and window pages
      if (body.include_counts) {
        return { data: { count: { total: 0 } } };
      }
      return {
        data: {
          data: [
            {
              id: "lead_1",
              date_created: "2026-07-01T00:00:00.000Z",
              date_updated: "2026-07-16T00:00:00.000Z",
            },
          ],
          cursor: null,
        },
      };
    },
    get: async () => ({ data: { data: [] } }),
  };

  await connector.fetchEntityChunk({
    entity: "leads",
    since: new Date("2026-07-15T00:00:00.000Z"),
    maxIterations: 1,
    onBatch: async () => {},
  } as any);

  const windowed = bodies.find(body =>
    body?.query?.queries?.some(
      (q: any) =>
        q?.type === "field_condition" &&
        q?.field?.field_name === "date_updated",
    ),
  );
  assert.ok(windowed, "expected Search body to filter on date_updated");
  assert.equal(windowed.sort?.[0]?.field?.field_name, "date_updated");
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

async function testWiseTransfersCreatedDateStartWhenSinceSet() {
  const connector = new WiseConnector({
    id: "ds_wise",
    name: "Wise",
    type: "wise",
    config: { api_key: "test", profile_id: "1" },
  } as any);

  let captured: any;
  (connector as any).wiseApi = {
    get: async (_path: string, config?: { params?: any }) => {
      captured = config?.params;
      return { data: [] };
    },
  };

  await connector.fetchEntityChunk({
    entity: "transfers",
    since: new Date("2026-07-15T12:00:00.000Z"),
    onBatch: async () => {},
  } as any);

  assert.equal(captured.createdDateStart, "2026-07-15");
}

async function main() {
  testEveryConnectorReturnsWellFormedCapabilities();
  testConnectorsWithNoRealIncrementalDeclareNone();
  testGraphQLDeclaresClientFilterWithSinceInjection();
  testPosthogDeclaresNativeSincePlaceholder();
  testCreatedAnchorConnectorsWarnAboutMissedUpdates();
  testCloseSearchApiEntitiesDeclareNative();
  await testCloseSearchApiUsesDateUpdatedWhenSinceSet();
  await testStripeCreatedGteWhenSinceSet();
  await testWiseTransfersCreatedDateStartWhenSinceSet();
  testPandadocDocumentsAreNativeContactsAreNot();
  testRestDeclaresClientFilterWithWarning();
  testWiseCreatedAnchorTransfersAndNoneFallback();
}

main().catch((error: unknown) => {
  throw error;
});
