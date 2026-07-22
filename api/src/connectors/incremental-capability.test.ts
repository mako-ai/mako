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
  // Audit result: `since` is accepted but never applied anywhere in the
  // fetch path for these three — declaring anything but "none" would be a
  // lie the UI would surface as a working Incremental option.
  for (const label of ["graphql", "posthog", "bigquery"]) {
    const capabilities = capabilitiesFor(label);
    assert.equal(capabilities.supported, false, `${label}.supported`);
    assert.equal(capabilities.mode, "none", `${label}.mode`);
  }
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

function testCloseSearchApiEntitiesDeclareNone() {
  // leads/contacts/opportunities/activities:* go through fetchViaSearchApi,
  // which ignores `since` — only the offset-fallback entities (users,
  // custom_fields) get a real server-side date_updated__gte filter.
  const close = capabilitiesFor("close");
  assert.equal(close.mode, "none");
  assert.equal(close.perEntity?.users?.mode, "native");
  assert.equal(close.perEntity?.custom_fields?.mode, "native");
  // No override for "leads" — resolves to the "none" fallback.
  assert.equal(close.perEntity?.leads, undefined);
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

function main() {
  testEveryConnectorReturnsWellFormedCapabilities();
  testConnectorsWithNoRealIncrementalDeclareNone();
  testCreatedAnchorConnectorsWarnAboutMissedUpdates();
  testCloseSearchApiEntitiesDeclareNone();
  testPandadocDocumentsAreNativeContactsAreNot();
  testRestDeclaresClientFilterWithWarning();
  testWiseCreatedAnchorTransfersAndNoneFallback();
}

main();
