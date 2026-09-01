/**
 * A flow mutation must not report success when its definition never reached
 * the repo.
 *
 * `commitFlowFile` is tolerant by design — a failed mirror must not fail a
 * user's save — and that was correct while `flows/<slug>.yml` was a projection
 * of the row. RFC #904 block 3 made the file AUTHORITATIVE, and the same
 * tolerance then produces a divergence nothing can detect: the row moves, the
 * file does not, and `sourceBlobSha` still matches the OLD file — so the next
 * sync computes the file's sha, finds it equal, reports "unchanged" and skips.
 * Row and file disagree permanently while the system believes they agree.
 *
 * This is a source-level invariant rather than a live-route test for the same
 * reason `repo-backed-resources.test.ts` is: what matters is that EVERY write
 * path honours the result, and a check that enumerates finds the one nobody
 * was looking at. Two of seven repo gates were missed exactly that way today.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const routes = fs.readFileSync(path.join(__dirname, "flows.ts"), "utf8");

// Every write-through goes through the checked helper, never the raw call.
// The helper's own call to `commitFlowFile` is the one legitimate one, so
// exclude its body before counting.
const helperStart = routes.indexOf("async function commitFlowFileOrFail");
const helperEnd = routes.indexOf("async function assertFlowRepo");
const outsideHelper = routes.slice(0, helperStart) + routes.slice(helperEnd);
const rawCalls = outsideHelper.match(/await commitFlowFile\(/g) ?? [];
assert.equal(
  rawCalls.length,
  0,
  "flow routes must call commitFlowFileOrFail, not commitFlowFile directly: the raw call returns {ok:false} on failure and discarding it is the silent divergence this guards",
);

const checked = routes.match(/commitFlowFileOrFail\(/g) ?? [];
assert.ok(
  checked.length >= 7,
  `expected every mirroring route plus the helper definition to reference commitFlowFileOrFail, found ${checked.length} — a route that stopped mirroring is as much a regression as one that stopped checking`,
);

// The helper must actually refuse, not log and continue.
const helper = routes.slice(
  routes.indexOf("async function commitFlowFileOrFail"),
  routes.indexOf("async function assertFlowRepo"),
);
assert.ok(
  helper.includes("if (result.ok) return null"),
  "the helper must branch on the returned result",
);
assert.ok(
  /502/.test(helper),
  "a definition that did not reach its authoritative home is an upstream failure, not a 200",
);
assert.ok(
  helper.includes("definition_not_committed"),
  "the failure needs a stable code the client can branch on",
);

// And every call site must RETURN on failure rather than fall through.
const sites = routes.split("commitFlowFileOrFail(").slice(2); // skip def + its own name
for (const [i, site] of sites.entries()) {
  assert.ok(
    site.slice(0, 200).includes("if (failed) return failed"),
    `call site ${i + 1} must return the refusal rather than continue to a 200`,
  );
}

console.log("flow write-through honesty: all assertions passed");
