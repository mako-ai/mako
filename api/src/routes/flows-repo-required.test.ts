import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every flow route that mirrors a definition into the repo must first refuse
 * to run without one (RFC #904 decision 1: no connected repo, no flows).
 *
 * #932 established the gate and applied it to create and update. Five other
 * routes also rewrite `flows/<slug>.yml` — toggle, sync-engine,
 * backfill-schedule, webhook/provision and delete — and were left ungated, so
 * a repo-less workspace could still change a flow's definition and silently
 * produce no file. That is the split-brain decision 1 exists to prevent,
 * reached through a side door rather than the front one.
 *
 * The pairing is the invariant, in BOTH directions. A route that mirrors but
 * does not gate is that split-brain. A route that gates but mirrors nothing
 * is a 412 with nothing behind it, which reads to a caller as a broken
 * deploy.
 *
 * Source-level on purpose: the failure being prevented is "someone adds an
 * eighth mutation route and forgets", and that is visible in the text without
 * a database, a repo fixture, or seven HTTP round trips. It is also how the
 * five missing gates were found — by asking the question of every route at
 * once instead of the two that were top of mind.
 */

const flows = readFileSync(join(__dirname, "flows.ts"), "utf8");

// Each route is one `flowRoutes.openapi(` block; the last runs to EOF.
const lines = flows.split("\n");
const starts = lines
  .map((line, i) => (line.startsWith("flowRoutes.openapi(") ? i : -1))
  .filter(i => i !== -1);
assert.ok(
  starts.length > 0,
  "no flow routes found — did the file's shape change?",
);
const blocks = starts.map((start, i) =>
  lines
    .slice(start, i + 1 < starts.length ? starts[i + 1] : lines.length)
    .join("\n"),
);

const describe = (block: string) => {
  const method = /method:\s*"(\w+)"/.exec(block)?.[1]?.toUpperCase() ?? "?";
  const path = /path:\s*"([^"]+)"/.exec(block)?.[1] ?? "?";
  return `${method} ${path}`;
};

let mirroring = 0;
for (const block of blocks) {
  // `commitFlowFileOrFail` is the checked wrapper around `commitFlowFile`
  // (see flows-writethrough.test.ts): routes call the wrapper so a failed
  // write-through cannot be reported as success. Both count as mirroring —
  // detecting only the raw name would read every wrapped route as "gates but
  // mirrors nothing" the moment the indirection was introduced.
  const mirrors =
    block.includes("commitFlowFile(") ||
    block.includes("commitFlowFileOrFail(") ||
    block.includes("deleteFlowFile(");
  const gates = block.includes("assertFlowRepo(");
  if (mirrors) mirroring++;

  assert.equal(
    gates,
    mirrors,
    mirrors
      ? `${describe(block)} mirrors a flow into the repo but never calls assertFlowRepo — it would change the row and leave the file behind`
      : `${describe(block)} calls assertFlowRepo but mirrors nothing — a 412 with nothing behind it`,
  );

  // A throw nobody maps is a 500. The gate is a precondition the caller can
  // act on, so every gating route must turn it into its 412.
  if (mirrors) {
    assert.ok(
      block.includes("RepoRequiredError") && block.includes("repoRequired(c"),
      `${describe(block)} gates on assertFlowRepo but does not map RepoRequiredError to 412 — the caller gets an opaque 500`,
    );
  }
}

// A guard that no route reaches is not a guard. If this drops to zero the
// assertions above all pass vacuously, which is the failure mode of every
// source-level check.
assert.ok(
  mirroring >= 7,
  `expected at least 7 mirroring flow routes, found ${mirroring} — if routes were removed, lower this deliberately`,
);

// The gate must stay env-gated like every other §17 gate, so a workspace that
// has not adopted a repo is unaffected until the flag is set for it.
assert.ok(
  /function assertFlowRepo[\s\S]*?appsRequireConnectedRepo\(\)/.test(flows),
  "assertFlowRepo must short-circuit on appsRequireConnectedRepo() — an unflagged workspace must not start failing flow writes",
);

console.log(
  `flows repo-required tests passed (${mirroring} mirroring routes, all gated and mapped)`,
);
