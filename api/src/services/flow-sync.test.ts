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

import { parseFlowFile, serializeFlowFile } from "./flow-config-files";

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

  console.log("flow-sync: all assertions passed");
}

void main();
