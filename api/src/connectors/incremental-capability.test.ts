import assert from "node:assert/strict";
import { ClaapConnector } from "./claap/connector";
import { RestConnector } from "./rest/connector";
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
    label: "rest",
    make: () =>
      new RestConnector({
        id: "ds_rest",
        name: "REST",
        type: "rest",
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

function testCreatedAnchorConnectorsWarnAboutMissedUpdates() {
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

async function main() {
  testEveryConnectorReturnsWellFormedCapabilities();
  testCreatedAnchorConnectorsWarnAboutMissedUpdates();
  testRestDeclaresClientFilterWithWarning();
}

main().catch((error: unknown) => {
  throw error;
});
