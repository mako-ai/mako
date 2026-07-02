/**
 * Unit tests for the anchored string-replacement engine backing
 * `app_edit_file` / `edit_dbt_file` / `app_update_data_binding` edits.
 *
 * Run: tsx src/agent-lib/tools/str-replace.test.ts
 */
import assert from "node:assert/strict";
import { applyStrReplace, buildStrReplaceDiff } from "@mako/agent-tools";

const FILE = [
  "import React from 'react';",
  "",
  "export function App() {",
  "  const label = 'hello';",
  "  return <div>{label}</div>;",
  "}",
].join("\n");

// --- unique match replaces exactly once -----------------------------------
{
  const result = applyStrReplace(
    FILE,
    "const label = 'hello';",
    "const label = 'world';",
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.replacements, 1);
    assert.match(result.contents, /world/);
    assert.doesNotMatch(result.contents, /'hello'/);
    // Everything else untouched.
    assert.match(result.contents, /import React from 'react';/);
  }
}

// --- multiline anchors -----------------------------------------------------
{
  const result = applyStrReplace(
    FILE,
    "export function App() {\n  const label = 'hello';",
    "export function App() {\n  const label = 'hello';\n  const extra = 1;",
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.contents, /const extra = 1;/);
    assert.equal(
      result.contents.split("\n").length,
      FILE.split("\n").length + 1,
    );
  }
}

// --- deletion via empty newString -------------------------------------------
{
  const result = applyStrReplace(FILE, "  const label = 'hello';\n", "");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.doesNotMatch(result.contents, /label = 'hello'/);
    assert.equal(
      result.contents.split("\n").length,
      FILE.split("\n").length - 1,
    );
  }
}

// --- not found ---------------------------------------------------------------
{
  const result = applyStrReplace(FILE, "const missing = true;", "x");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "not_found");
    assert.match(result.error, /not found/i);
  }
}

// --- ambiguous match rejected without replaceAll ----------------------------
{
  const doubled = `${FILE}\n${FILE}`;
  const result = applyStrReplace(
    doubled,
    "const label = 'hello';",
    "const label = 'x';",
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "not_unique");
    assert.equal(result.occurrences, 2);
    assert.match(result.error, /replaceAll/);
  }
}

// --- replaceAll replaces every occurrence ------------------------------------
{
  const doubled = `${FILE}\n${FILE}`;
  const result = applyStrReplace(doubled, "label", "title", true);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.replacements, 4);
    assert.doesNotMatch(result.contents, /label/);
  }
}

// --- empty oldString rejected --------------------------------------------------
{
  const result = applyStrReplace(FILE, "", "new file contents");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "empty_old_string");
    assert.match(result.error, /write tool/i);
  }
}

// --- identical old/new rejected -------------------------------------------------
{
  const result = applyStrReplace(
    FILE,
    "const label = 'hello';",
    "const label = 'hello';",
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_change");
}

// --- diff preview: single-line change, full-line -/+ block ----------------------
{
  const diff = buildStrReplaceDiff(FILE, "'hello'", "'world'");
  assert.match(diff, /^@@ -4,1 \+4,1 @@/);
  assert.ok(diff.includes("-  const label = 'hello';"));
  assert.ok(diff.includes("+  const label = 'world';"));
}

// --- diff preview: replaceAll trailer --------------------------------------------
{
  const diff = buildStrReplaceDiff(FILE, "label", "title", 3);
  assert.match(diff, /applied to 3 occurrences/);
}

// --- diff preview: deletion shows only the removed line ---------------------------
{
  const diff = buildStrReplaceDiff(FILE, "  const label = 'hello';", "");
  assert.ok(diff.includes("-  const label = 'hello';"));
}

// --- diff preview: very large regions are truncated -------------------------------
{
  const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
  const diff = buildStrReplaceDiff(big, big, "replaced");
  assert.match(diff, /diff lines omitted/);
}

process.stdout.write("str-replace.test.ts: all assertions passed\n");
