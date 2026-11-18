import assert from "node:assert/strict";
import { RestConnector } from "./rest/connector";
import { GraphQLConnector } from "./graphql/connector";
import { BigQueryConnector } from "./bigquery/connector";
import { GcsConnector } from "./gcs/connector";
import {
  type IncrementalCapabilities,
  type IncrementalMode,
} from "./base/BaseConnector";
import { BUILTIN_TWIN_CATALOG } from "./twins/builtin-catalog";
import { BUILTIN_TWIN_TYPES } from "./twins/types";

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
  capabilities: () => IncrementalCapabilities;
}> = [
  // The deleted built-ins: what the registry still reports for their types
  // (twins/builtin-catalog.ts), frozen from the classes at deletion.
  ...BUILTIN_TWIN_TYPES.map(type => ({
    label: type as string,
    capabilities: () =>
      BUILTIN_TWIN_CATALOG[type].incremental as IncrementalCapabilities,
  })),
  {
    label: "rest",
    capabilities: () =>
      new RestConnector({
        id: "ds_rest",
        name: "REST",
        type: "rest",
        config: {},
      } as any).getIncrementalCapabilities(),
  },
  {
    label: "graphql",
    capabilities: () =>
      new GraphQLConnector({
        id: "ds_graphql",
        name: "GraphQL",
        type: "graphql",
        config: {},
      } as any).getIncrementalCapabilities(),
  },
  {
    label: "bigquery",
    capabilities: () =>
      new BigQueryConnector({
        id: "ds_bigquery",
        name: "BigQuery",
        type: "bigquery",
        config: {},
      } as any).getIncrementalCapabilities(),
  },
  {
    label: "gcs",
    capabilities: () =>
      new GcsConnector({
        id: "ds_gcs",
        name: "GCS",
        type: "gcs",
        config: { bucket: "test-bucket", service_account_json: "{}" },
      } as any).getIncrementalCapabilities(),
  },
];

function capabilitiesFor(label: string): IncrementalCapabilities {
  const entry = connectors.find(c => c.label === label);
  if (!entry) throw new Error(`No connector registered for label "${label}"`);
  return entry.capabilities();
}

function testEveryConnectorReturnsWellFormedCapabilities() {
  for (const { label, capabilities: read } of connectors) {
    const capabilities = read();
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
  assert.equal(posthog.perEntity?.surveys?.mode, "created-anchor");
  assert.equal(posthog.perEntity?.survey_responses?.mode, "native");
  assert.equal(posthog.perEntity?.feature_flags?.mode, "created-anchor");
  assert.equal(posthog.perEntity?.experiments?.mode, "created-anchor");
  assert.equal(posthog.perEntity?.annotations?.mode, "created-anchor");
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
  assert.equal(wise.perEntity?.activities?.mode, "native");
  assert.equal(wise.perEntity?.activities?.anchorField, "since");
  assert.ok(wise.warning && wise.warning.length > 0);
}

async function main() {
  testEveryConnectorReturnsWellFormedCapabilities();
  testConnectorsWithNoRealIncrementalDeclareNone();
  testGraphQLDeclaresClientFilterWithSinceInjection();
  testPosthogDeclaresNativeSincePlaceholder();
  testCreatedAnchorConnectorsWarnAboutMissedUpdates();
  testCloseSearchApiEntitiesDeclareNative();
  testPandadocDocumentsAreNativeContactsAreNot();
  testRestDeclaresClientFilterWithWarning();
  testWiseCreatedAnchorTransfersAndNoneFallback();
}

main().catch((error: unknown) => {
  throw error;
});
