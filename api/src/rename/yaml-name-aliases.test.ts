/**
 * Textual `name:` / `aliases:` edits for a rename: everything else in the
 * file — comments, unknown keys, long command lists — must come out exactly
 * as it went in, and anything the editor cannot handle must be refused
 * rather than guessed at.
 *
 * Run: npx tsx src/rename/yaml-name-aliases.test.ts
 */
import assert from "node:assert/strict";

import { parseJobFile } from "../dbt/dbt-config-files";
import { parseFlowFileResult } from "../services/flow-config-files";
import {
  editNameAndAliases,
  setTopLevelAliases,
  setTopLevelScalar,
} from "./yaml-name-aliases";

const FLOW = [
  "# owned by growth team — do not change the schema",
  "name: Foo",
  "type: webhook",
  "description: leads stream",
  "source:",
  "  type: connector",
  "  connector_id: 6ac4ce06203633531a77d513",
  "destination:",
  "  connection_id: 6ac4ce06203633531a77d514",
  "  table:",
  "    schema: raw_a  # prod dataset",
  "    create_if_not_exists: true",
  "webhook:",
  "  enabled: true",
  "sync:",
  "  mode: incremental",
  "  write_mode: append_dedup",
  "  engine: cdc",
  "",
].join("\n");

// ---- the reviewer's round trip: comments and unknown keys survive --------
{
  const out = editNameAndAliases(FLOW, "Foo → Warehouse", ["foo"]);
  assert.ok(out);
  const expected = FLOW.replace(
    "name: Foo\n",
    "name: Foo → Warehouse\naliases:\n  - foo\n",
  );
  assert.equal(out, expected, "only the two owned keys may change");
  const parsed = parseFlowFileResult(out);
  assert.ok(parsed.ok);
  assert.equal(parsed.file.name, "Foo → Warehouse");
  assert.deepEqual(parsed.file.aliases, ["foo"]);
}

// ---- a title-only edit leaves even the aliases stanza untouched ----------
{
  const withAliases = FLOW.replace(
    "name: Foo\n",
    "name: Foo\naliases:\n  - old\n",
  );
  const out = editNameAndAliases(withAliases, "Bar", ["old"]);
  assert.equal(out, withAliases.replace("name: Foo", "name: Bar"));
}

// ---- values that need quoting are quoted the way the parser reads them --
{
  const out = setTopLevelScalar(FLOW, "name", "a: b #not a comment");
  assert.ok(out);
  const parsed = parseFlowFileResult(out);
  assert.ok(parsed.ok);
  assert.equal(parsed.file.name, "a: b #not a comment");
}

// ---- aliases: inline, block, empty, removal, insertion -------------------
{
  const inline = FLOW.replace(
    "name: Foo\n",
    "name: Foo\naliases: [a, b]  # old names\n",
  );
  const out = setTopLevelAliases(inline, ["a", "b", "c"]);
  // Inline stays inline, and the author's comment stays with it.
  assert.equal(
    out,
    FLOW.replace("name: Foo\n", "name: Foo\naliases: [a, b, c]  # old names\n"),
  );
}
{
  const block = FLOW.replace(
    "type: webhook\n",
    "type: webhook\naliases:\n  - a\n  # kept: a rename never drops a comment\n  - b\n",
  );
  const out = setTopLevelAliases(block, ["z"]);
  assert.equal(
    out,
    FLOW.replace(
      "type: webhook\n",
      "type: webhook\naliases:\n  # kept: a rename never drops a comment\n  - z\n",
    ),
  );
}
{
  // Comments on the two owned lines, inside the list and on its items all
  // survive a rename; a new old name is appended in the list's indentation;
  // the one taken back (renaming back to it) loses its line.
  const annotated = [
    "name: Foo  # shown in the sidebar",
    "aliases:  # every name it had",
    "  # the first one",
    "    - foo-old",
    "    - foo-older # 2025",
    "type: webhook",
    "",
  ].join("\n");
  assert.equal(
    editNameAndAliases(annotated, "Foo 2", ["foo-old", "foo-older", "foo"]),
    [
      "name: Foo 2  # shown in the sidebar",
      "aliases:  # every name it had",
      "  # the first one",
      "    - foo-old",
      "    - foo-older # 2025",
      "    - foo",
      "type: webhook",
      "",
    ].join("\n"),
  );
  assert.equal(
    editNameAndAliases(annotated, "Foo", ["foo-old", "foo"]),
    [
      "name: Foo  # shown in the sidebar",
      "aliases:  # every name it had",
      "  # the first one",
      "    - foo-old",
      "    - foo",
      "type: webhook",
      "",
    ].join("\n"),
  );
  // A quoted name keeps its comment; a `#` inside the quotes is not one.
  assert.equal(
    setTopLevelScalar("name: 'a # b'  # note\n", "name", "c"),
    "name: c  # note\n",
  );
  assert.equal(
    setTopLevelScalar('name: "x \\" # y" # z\n', "name", "c"),
    "name: c # z\n",
  );
  assert.equal(
    setTopLevelAliases("name: N\naliases: [a] # see [x]\n", ["a", "b"]),
    "name: N\naliases: [a, b] # see [x]\n",
  );
  // An unterminated quote is refused, not guessed.
  assert.equal(setTopLevelScalar("name: 'open\n", "name", "c"), null);
}
{
  const empty = FLOW.replace("name: Foo\n", "name: Foo\naliases: []\n");
  assert.equal(
    setTopLevelAliases(empty, []),
    FLOW,
    "an empty list removes the key",
  );
  assert.equal(
    setTopLevelAliases(FLOW, []),
    FLOW,
    "nothing to remove is a no-op",
  );
}

// ---- CRLF files keep their line endings ------------------------------------
{
  const crlf = FLOW.replace(/\n/g, "\r\n");
  const out = editNameAndAliases(crlf, "X", ["y"]);
  assert.ok(out);
  assert.ok(!/[^\r]\n/.test(out), "no bare LF introduced");
  assert.ok(out.includes("name: X\r\naliases:\r\n  - y\r\n"));
}

// ---- refusals: never guess ---------------------------------------------------
assert.equal(
  setTopLevelScalar("type: webhook\n", "name", "x"),
  null,
  "no name key",
);
assert.equal(
  setTopLevelScalar("name: |\n  multi\n  line\ntype: webhook\n", "name", "x"),
  null,
  "block scalar",
);
assert.equal(setTopLevelScalar("name: &n Foo\n", "name", "x"), null, "anchor");
assert.equal(
  setTopLevelScalar("name: Foo\nname: Bar\n", "name", "x"),
  null,
  "duplicate key",
);
assert.equal(
  setTopLevelAliases("name: Foo\naliases: &a [x]\n", ["y"]),
  null,
  "aliases with an anchor",
);
assert.equal(
  setTopLevelAliases("name: Foo\naliases:\n  key: value\n", ["y"]),
  null,
  "aliases that is a mapping",
);
assert.equal(
  setTopLevelAliases("type: webhook\n", ["y"]),
  null,
  "nowhere to insert without a name key",
);
// A nested `name:` (indented) is not the top-level one.
{
  const nested = "name: Top\nsource:\n  name: inner\n";
  assert.equal(
    setTopLevelScalar(nested, "name", "New"),
    "name: New\nsource:\n  name: inner\n",
  );
}

// ---- dbt: twelve commands and a comment come through a rename intact -----
{
  const job =
    "# nightly prod build\nname: N\nenvironment: prod\ncommands:\n" +
    Array.from({ length: 12 }, (_, i) => `  - build --select m${i}`).join(
      "\n",
    ) +
    "\n";
  const out = editNameAndAliases(job, "Nightly", ["n-old"]);
  assert.ok(out);
  assert.equal(
    out,
    job.replace("name: N\n", "name: Nightly\naliases:\n  - n-old\n"),
  );
  assert.ok(out.includes("# nightly prod build"));
  assert.equal((out.match(/build --select m/g) ?? []).length, 12);
  const parsed = parseJobFile(out);
  assert.equal(parsed?.name, "Nightly");
  assert.deepEqual(parsed?.aliases, ["n-old"]);
}

console.log("yaml name/aliases edits: all assertions passed");
