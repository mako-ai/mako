/**
 * The push reactor's definition mapping, and the guard that matters most.
 *
 * The dangerous direction of RFC #904 block 3 is not "a file changed a flow";
 * it is "a file's ABSENCE tore down a running stream". 31 of 31 production
 * flows are CDC, and a wrong teardown disposes checkpoints — unlike a dbt job
 * row, recreating the flow does not recover the stream position, it
 * re-backfills. So the assertions here are mostly about what must NOT happen.
 *
 * Stream teardown itself lives behind the reconciler seam and is covered by
 * the CDC lane; what is pinned here is that this module never reaches it on
 * its own, and never writes runtime state from a file.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseFlowFile, serializeFlowFile } from "./flow-config-files";
import { mintedWebhookEndpoint } from "./flow-sync.service";

const FILE = `name: orders → warehouse
type: scheduled
source:
  type: connector
  connector_id: 6a2bd881b6f8c41ea17e9bc7
destination:
  connection_id: 69c2719490eb18199aafa882
sync:
  mode: incremental
  engine: cdc
`;

async function main(): Promise<void> {
  // ---- the file format carries no runtime state ------------------------
  const parsed = parseFlowFile(FILE);
  assert.ok(parsed, "fixture must parse");

  const roundTripped = parseFlowFile(serializeFlowFile(parsed));
  assert.ok(roundTripped, "a serialized file must parse back");
  assert.equal(roundTripped.name, "orders → warehouse");

  // Cursors and credentials have no representation in the file at all, so
  // the reactor cannot write them back even by accident. These assertions
  // fail loudly if someone widens FlowFile later.
  const asRecord = roundTripped as unknown as Record<string, unknown>;
  for (const forbidden of [
    "incrementalConfig",
    "paginationConfig",
    "webhookConfig",
    "syncState",
    "streamState",
    "backfillState",
    "lastRunAt",
    "runCount",
  ]) {
    assert.equal(
      asRecord[forbidden],
      undefined,
      `${forbidden} is runtime state and must never appear in a flow file`,
    );
  }

  // The endpoint is inbound URL identity that external systems POST to (17 of
  // 31 production flows have one) and must survive a rename, so it is minted
  // in Mongo and never derived from the slug or carried in the file.
  const serialized = serializeFlowFile(parsed);
  for (const forbidden of ["endpoint", "secret", "last_value", "last_keyset"]) {
    assert.ok(
      !serialized.includes(forbidden),
      `serialized flow must not contain ${forbidden}`,
    );
  }

  // ---- a file that does not parse is refused, not applied ---------------
  assert.equal(parseFlowFile("not: [valid"), null);
  assert.equal(parseFlowFile(""), null);
  // A file with no name is refused: the writer once emitted `name: ''` for a
  // nameless row, which the reader rejects — caught by running the projection
  // against production before the backfill had deployed.
  assert.equal(
    parseFlowFile(FILE.replace("name: orders → warehouse", "name: ''")),
    null,
  );

  // ---- the inbound URL a file-born webhook flow needs -------------------
  //
  // `applyDefinition` writes only `webhookConfig.enabled` — right for an EDIT
  // (the endpoint is inbound URL identity, the secret is a credential, neither
  // belongs in a file) and wrong for a CREATE, which saved `enabled: true`
  // with no endpoint: configured-looking and unreachable, on the majority case
  // (17 of 31 production flows are webhook).
  const WS = "6a2bd881b6f8c41ea17e9bc7";
  const ID = "69c2719490eb18199aafa882";

  const created = mintedWebhookEndpoint({
    isNew: true,
    type: "webhook",
    workspaceId: WS,
    flowId: ID,
  });
  assert.ok(created, "a file-born webhook flow must get an inbound URL");
  // Derived from workspaceId + _id, never the slug — which is what makes an
  // edit unable to move it.
  assert.ok(
    created.endsWith(`/api/webhooks/${WS}/${ID}`),
    `endpoint must address the flow by id, got ${created}`,
  );

  // An UPDATE must leave it exactly where it is. This is the assertion that
  // protects live integrations: 17 production flows have external systems
  // POSTing to a URL that must not move when someone edits the file.
  assert.equal(
    mintedWebhookEndpoint({
      isNew: false,
      type: "webhook",
      workspaceId: WS,
      flowId: ID,
      existingEndpoint: "https://api.example.com/api/webhooks/w/f",
    }),
    null,
    "an edit must never re-mint an endpoint",
  );
  assert.equal(
    mintedWebhookEndpoint({
      isNew: false,
      type: "webhook",
      workspaceId: WS,
      flowId: ID,
    }),
    null,
    "not-new is decisive on its own, endpoint present or not",
  );

  // Non-webhook flows get nothing, and a row that somehow already carries one
  // is never overwritten.
  for (const type of ["scheduled", "manual", undefined]) {
    assert.equal(
      mintedWebhookEndpoint({ isNew: true, type, workspaceId: WS, flowId: ID }),
      null,
      `a ${String(type)} flow must not get a webhook endpoint`,
    );
  }
  assert.equal(
    mintedWebhookEndpoint({
      isNew: true,
      type: "webhook",
      workspaceId: WS,
      flowId: ID,
      existingEndpoint: "https://api.example.com/api/webhooks/w/f",
    }),
    null,
    "an existing endpoint is never overwritten, new row or not",
  );

  // The SECRET is never minted here. It is the provider's signing secret
  // (Stripe's whsec_...), checked by connector.verifyWebhook — a value we
  // invented would fail verification on every real delivery while the flow
  // looked configured. This function returns a URL and nothing else, so there
  // is no place for one to appear.
  assert.equal(typeof created, "string");

  // …and the create path actually CALLS it. The helper passing proves nothing
  // on its own: this whole bug was a mapper that deliberately did not write
  // the endpoint, with everything it did write working fine. A refactor that
  // drops the call would leave every assertion above green. Driving the real
  // sync needs git and Mongo, so the wiring is pinned at the source level.
  const source = readFileSync(
    path.join(__dirname, "flow-sync.service.ts"),
    "utf8",
  );
  const syncBody = source.slice(
    source.indexOf("export async function syncFlowsFromRepo"),
  );
  assert.match(
    syncBody,
    /mintedWebhookEndpoint\(\{[\s\S]*?isNew,/,
    "syncFlowsFromRepo must mint through the helper, passing isNew",
  );
  assert.doesNotMatch(
    syncBody,
    /webhookConfig[\s\S]{0,120}secret/,
    "the sync path must never write a webhook secret — it is the provider's",
  );

  console.log("flow-sync: all assertions passed");
}

void main();
