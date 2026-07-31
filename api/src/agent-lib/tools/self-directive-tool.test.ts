/**
 * Unit tests for the self-directive (persistent workspace memory) update
 * engine.
 *
 * Regression coverage for the recurring "Self-directive would exceed the
 * 10000 character limit" failure loop: once the directive filled up, every
 * session's first update failed and burned a turn on recovery. The engine now
 * reports remaining capacity on reads/writes, warns before the cap is hit,
 * and rejects overflows with one-step recovery instructions.
 *
 * Run: tsx src/agent-lib/tools/self-directive-tool.test.ts
 */
import assert from "node:assert/strict";
import {
  MAX_SELF_DIRECTIVE_LENGTH,
  applySelfDirectiveOperation,
  selfDirectiveCompactionWarning,
  selfDirectiveUsage,
} from "./self-directive-tool";

const CURRENT = [
  "# Rules",
  "- Always filter by workspace_id",
  "- Amounts are in cents",
].join("\n");

// --- set overwrites --------------------------------------------------------
{
  const r = applySelfDirectiveOperation(CURRENT, {
    operation: "set",
    content: "fresh",
  });
  assert.deepEqual(r, { ok: true, value: "fresh" });
}

// --- append / prepend join with newline, and skip it when empty ------------
{
  const r = applySelfDirectiveOperation(CURRENT, {
    operation: "append",
    content: "- New rule",
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, CURRENT + "\n- New rule");

  const empty = applySelfDirectiveOperation("", {
    operation: "append",
    content: "- Only rule",
  });
  assert.deepEqual(empty, { ok: true, value: "- Only rule" });

  const pre = applySelfDirectiveOperation(CURRENT, {
    operation: "prepend",
    content: "# Priority",
  });
  assert.equal(pre.ok, true);
  if (pre.ok) assert.equal(pre.value, "# Priority\n" + CURRENT);
}

// --- find_and_replace: first occurrence only, literal (no regex) -----------
{
  const r = applySelfDirectiveOperation("a.c a.c", {
    operation: "find_and_replace",
    find: "a.c",
    replace: "X",
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, "X a.c");

  const miss = applySelfDirectiveOperation(CURRENT, {
    operation: "find_and_replace",
    find: "not present",
    replace: "X",
  });
  assert.equal(miss.ok, false);
  if (!miss.ok) assert.match(miss.error, /Text not found/);
}

// --- insert_after ----------------------------------------------------------
{
  const r = applySelfDirectiveOperation(CURRENT, {
    operation: "insert_after",
    after: "# Rules",
    content: "- Inserted",
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.value, /# Rules\n- Inserted\n- Always filter/);

  const miss = applySelfDirectiveOperation(CURRENT, {
    operation: "insert_after",
    after: "missing anchor",
    content: "x",
  });
  assert.equal(miss.ok, false);
  if (!miss.ok) assert.match(miss.error, /Anchor text not found/);
}

// --- delete_section removes text and collapses blank runs ------------------
{
  const r = applySelfDirectiveOperation("a\n\nremove me\n\nb", {
    operation: "delete_section",
    find: "remove me",
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, "a\n\nb");
}

// --- missing required fields fail without touching content -----------------
{
  for (const [operation, expected] of [
    ["set", "content"],
    ["append", "content"],
    ["prepend", "content"],
    ["find_and_replace", "find"],
    ["insert_after", "after"],
    ["delete_section", "find"],
  ] as const) {
    const r = applySelfDirectiveOperation(CURRENT, { operation });
    assert.equal(r.ok, false, operation);
    if (!r.ok) assert.match(r.error, new RegExp(`'${expected}' is required`));
  }
}

// --- overflow: rejected with one-step recovery guidance --------------------
{
  const nearlyFull = "x".repeat(MAX_SELF_DIRECTIVE_LENGTH - 10);
  const r = applySelfDirectiveOperation(nearlyFull, {
    operation: "append",
    content: "y".repeat(100),
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    // Actionable numbers: overage, current size, free space.
    assert.match(r.error, /91 over the 10000 limit/);
    assert.match(r.error, /current: 9990 chars/);
    assert.match(r.error, /10 free/);
    // And explicit recovery instructions (no blind retry).
    assert.match(r.error, /Do NOT retry the same content/);
    assert.match(r.error, /'set' with a compacted/);
  }

  // Exactly at the limit still succeeds.
  const exact = applySelfDirectiveOperation("", {
    operation: "set",
    content: "x".repeat(MAX_SELF_DIRECTIVE_LENGTH),
  });
  assert.equal(exact.ok, true);
}

// --- usage stats -----------------------------------------------------------
{
  assert.deepEqual(selfDirectiveUsage(9990), {
    length: 9990,
    limit: MAX_SELF_DIRECTIVE_LENGTH,
    remaining: 10,
  });
  // Legacy over-limit content never reports negative remaining space.
  assert.equal(selfDirectiveUsage(MAX_SELF_DIRECTIVE_LENGTH + 5).remaining, 0);
}

// --- compaction warning fires at 80%, not below ----------------------------
{
  assert.equal(selfDirectiveCompactionWarning(7999), undefined);
  const warning = selfDirectiveCompactionWarning(8000);
  assert.ok(warning);
  assert.match(warning, /80% full/);
  assert.match(warning, /Compact it now with 'set'/);

  const nearCap = selfDirectiveCompactionWarning(9990);
  assert.ok(nearCap);
  assert.match(nearCap, /9990\/10000/);
}

console.log("self-directive-tool.test.ts passed");
