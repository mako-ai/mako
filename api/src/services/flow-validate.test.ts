/**
 * The validator exists so a bad file produces a REASON, not silence.
 *
 * The sync path is right to answer an invalid file with "keep the current row":
 * a bad edit is likelier than an instruction to change a running stream. But
 * that leaves the author with nothing, and an agent with nothing cannot
 * self-correct — a silent no-op is indistinguishable from success.
 *
 * These assertions are about the structural half, which needs no database. The
 * referential half (do the ids resolve, is the slug free) is exercised where a
 * Mongo fixture is available.
 */
import assert from "node:assert/strict";

import { parseFlowFile, parseFlowFileResult } from "./flow-config-files";

const VALID = `name: stripe → bigquery
type: webhook
source:
  type: connector
  connector_id: 6a2bd881b6f8c41ea17e9bc7
destination:
  connection_id: 69c2719490eb18199aafa882
sync:
  engine: cdc
`;

// The wrapper and the detailed parser must never disagree: the validator would
// otherwise certify files the sync path rejects, which is worse than having no
// validator at all.
for (const [label, contents] of [
  ["valid", VALID],
  ["bad yaml", "name: [unclosed"],
  ["empty", ""],
  ["no name", VALID.replace("name: stripe → bigquery", "name: ''")],
  ["bad type", VALID.replace("type: webhook", "type: streaming")],
] as const) {
  const detailed = parseFlowFileResult(contents);
  const plain = parseFlowFile(contents);
  assert.equal(
    detailed.ok,
    plain !== null,
    `${label}: parseFlowFile and parseFlowFileResult disagree`,
  );
}

// Every rejection carries something the author can act on.
const reasons: Record<string, string> = {};
for (const [label, contents] of [
  ["bad yaml", "name: [unclosed"],
  ["empty", ""],
  ["not a mapping", "- just\n- a list\n"],
  ["no name", VALID.replace("name: stripe → bigquery", "name: ''")],
  ["bad type", VALID.replace("type: webhook", "type: streaming")],
  ["missing type", VALID.replace("type: webhook\n", "")],
] as const) {
  const result = parseFlowFileResult(contents);
  assert.equal(result.ok, false, `${label} must be rejected`);
  if (result.ok) continue;
  assert.ok(
    result.reason.length > 10,
    `${label}: reason must say something useful, got "${result.reason}"`,
  );
  reasons[label] = result.reason;
}

// The reason must name the field, or it is no better than null.
assert.match(reasons["no name"], /name/i);
assert.match(reasons["bad type"], /type/i);
assert.match(reasons["missing type"], /type/i);
// And a wrong value should say what was found, so the author sees the typo.
assert.match(reasons["bad type"], /streaming/);
assert.match(reasons["bad yaml"], /YAML/i);

// A valid file still parses to the same thing through both entry points.
const ok = parseFlowFileResult(VALID);
assert.ok(ok.ok);
assert.equal(ok.file.name, "stripe → bigquery");
assert.equal(ok.file.type, "webhook");
assert.deepEqual(ok.file, parseFlowFile(VALID));

console.log("flow-validate: all assertions passed");
