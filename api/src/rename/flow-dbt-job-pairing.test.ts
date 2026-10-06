/**
 * Laptop-rename pairing (graceful rename, rule 3): which vanished slug is
 * which appeared slug. The decision this protects is "never tear down a
 * live stream that merely moved" — and its mirror, "never re-key a stream
 * onto the wrong file", which is why ambiguity resolves to nothing.
 *
 * The rules are pure and tested as data; git's rename detection is driven
 * against a real bare repo so the plumbing (`-M` over two synthetic trees)
 * is exercised, not mocked.
 *
 * Run: npx tsx src/rename/flow-dbt-job-pairing.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_BRANCH,
  blobOid,
  commitBlobsOnBranch,
  initRepo,
} from "../apps/repository.service";
import {
  definitionIdentity,
  detectGitRenames,
  mergedAliases,
  pairRenamedSlugs,
  readBlobByOid,
} from "./flow-dbt-job-pairing";

const FLOW = (name: string, cron = "0 3 * * *") =>
  [
    `name: ${name}`,
    "type: scheduled",
    "source:",
    "  type: connector",
    "  connection_id: 6a2bd881b6f8c41ea17e9bc7",
    "destination:",
    "  connection_id: 69c2719490eb18199aafa882",
    "schedule:",
    `  cron: ${cron}`,
    "  timezone: UTC",
    "sync:",
    "  engine: cdc",
    "",
  ].join("\n");

// ---- identity: name and aliases are the only rename-mutable keys ----------
assert.equal(
  definitionIdentity(FLOW("Old name")),
  definitionIdentity(`aliases: [old]\n` + FLOW("New name")),
  "name and aliases must not take part in the identity",
);
assert.notEqual(
  definitionIdentity(FLOW("x")),
  definitionIdentity(FLOW("x", "0 4 * * *")),
  "any other change is a different definition",
);
assert.equal(definitionIdentity("not: [valid"), null);
assert.equal(definitionIdentity("- a list\n"), null);

// ---- rule 1: the added file's aliases name the removed slug ---------------
{
  const result = pairRenamedSlugs({
    removed: [{ slug: "close-crm", contents: FLOW("Close") }],
    added: [
      {
        slug: "crm-sync",
        contents: FLOW("Close", "0 9 * * *"), // edited too: alias still wins
        aliases: ["close-crm"],
      },
      { slug: "unrelated", contents: FLOW("Other"), aliases: [] },
    ],
  });
  assert.deepEqual(result.pairs, [
    { from: "close-crm", to: "crm-sync", via: "alias" },
  ]);
  assert.deepEqual(result.ambiguous, []);
}

// ---- rule 1, the other direction: renamed BACK to an old name ------------
{
  const result = pairRenamedSlugs({
    removed: [
      { slug: "crm-sync", aliases: ["close-crm"], contents: FLOW("x") },
    ],
    added: [
      { slug: "close-crm", contents: FLOW("y", "1 1 * * *"), aliases: [] },
    ],
  });
  assert.deepEqual(result.pairs, [
    { from: "crm-sync", to: "close-crm", via: "alias" },
  ]);
}

// ---- rule 2: git says so ---------------------------------------------------
{
  const result = pairRenamedSlugs({
    removed: [{ slug: "a", contents: FLOW("A") }],
    added: [{ slug: "b", contents: FLOW("A", "5 5 * * *"), aliases: [] }],
    gitRenames: new Map([["a", "b"]]),
  });
  assert.deepEqual(result.pairs, [{ from: "a", to: "b", via: "git" }]);
}
{
  // Git naming a slug that was not added is not a pairing.
  const result = pairRenamedSlugs({
    removed: [{ slug: "a", contents: FLOW("A") }],
    added: [{ slug: "b", contents: FLOW("B", "5 5 * * *"), aliases: [] }],
    gitRenames: new Map([["a", "zzz"]]),
  });
  assert.deepEqual(result.pairs, []);
}

// ---- rule 3: identical apart from name/aliases ---------------------------
{
  const result = pairRenamedSlugs({
    removed: [{ slug: "a", contents: FLOW("Old") }],
    added: [{ slug: "b", contents: FLOW("New"), aliases: [] }],
  });
  assert.deepEqual(result.pairs, [{ from: "a", to: "b", via: "identical" }]);
}
{
  // A removed slug with no known contents cannot be paired by content.
  const result = pairRenamedSlugs({
    removed: [{ slug: "a" }],
    added: [{ slug: "b", contents: FLOW("New"), aliases: [] }],
  });
  assert.deepEqual(result.pairs, []);
  assert.deepEqual(result.ambiguous, []);
}

// ---- ambiguity is never guessed --------------------------------------------
{
  // Two added files both claim the old slug.
  const result = pairRenamedSlugs({
    removed: [{ slug: "a", contents: FLOW("A") }],
    added: [
      { slug: "b", contents: FLOW("B"), aliases: ["a"] },
      { slug: "c", contents: FLOW("C"), aliases: ["a"] },
    ],
  });
  assert.deepEqual(result.pairs, []);
  assert.deepEqual(result.ambiguous, [
    { slug: "a", rule: "alias", candidates: ["b", "c"] },
  ]);
}
{
  // Two added files identical to the removed one.
  const result = pairRenamedSlugs({
    removed: [{ slug: "a", contents: FLOW("A") }],
    added: [
      { slug: "b", contents: FLOW("B"), aliases: [] },
      { slug: "c", contents: FLOW("C"), aliases: [] },
    ],
  });
  assert.deepEqual(result.pairs, []);
  assert.equal(result.ambiguous[0]?.rule, "identical");
}
{
  // Two removed slugs both identical to ONE added file: given to neither.
  const result = pairRenamedSlugs({
    removed: [
      { slug: "a", contents: FLOW("A") },
      { slug: "b", contents: FLOW("B") },
    ],
    added: [{ slug: "c", contents: FLOW("C"), aliases: [] }],
  });
  assert.deepEqual(result.pairs, []);
  assert.deepEqual(result.ambiguous.map(e => e.slug).sort(), ["a", "b"]);
}
{
  // An ambiguous higher rule does not fall through to a lower one.
  const result = pairRenamedSlugs({
    removed: [{ slug: "a", contents: FLOW("A") }],
    added: [
      { slug: "b", contents: FLOW("B"), aliases: ["a"] },
      { slug: "c", contents: FLOW("C", "9 9 * * *"), aliases: ["a"] },
    ],
    gitRenames: new Map([["a", "b"]]),
  });
  assert.deepEqual(result.pairs, []);
}

// ---- empty sides short-circuit ---------------------------------------------
assert.deepEqual(
  pairRenamedSlugs({
    removed: [],
    added: [{ slug: "b", contents: "", aliases: [] }],
  }),
  { pairs: [], ambiguous: [] },
);

// ---- mergedAliases: grows, dedupes, never holds the current slug ----------
assert.deepEqual(mergedAliases(["a", "b"], ["b", "c", "x"], "x"), [
  "a",
  "b",
  "c",
]);
assert.deepEqual(mergedAliases(undefined, undefined, "x"), []);
assert.deepEqual(mergedAliases(["", "a"], [], undefined), ["a"]);

// ---- git -M over two synthetic trees, against a real repo -----------------
async function gitCases(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rename-pairing-"));
  try {
    const repoDir = path.join(tmp, "ws.git");
    const old = FLOW("Close CRM");
    await initRepo(repoDir, { "flows/close-crm.yml": old });

    // A laptop `git mv` + a cron edit in the same commit.
    const moved = FLOW("Close CRM", "0 9 * * *");
    await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      {
        writes: { "flows/crm-sync.yml": moved },
        deletes: ["flows/close-crm.yml"],
      },
      { message: "mv" },
    );
    const renames = await detectGitRenames(
      repoDir,
      [{ path: "flows/close-crm.yml", oid: blobOid(old) }],
      [{ path: "flows/crm-sync.yml", oid: blobOid(moved) }],
    );
    assert.deepEqual(
      [...renames],
      [["flows/close-crm.yml", "flows/crm-sync.yml"]],
      "git must pair a moved-and-edited file",
    );

    // The old blob is still readable by its oid: that is what lets the
    // sync compare without remembering a previous commit.
    assert.equal(await readBlobByOid(repoDir, blobOid(old)), old);
    assert.equal(await readBlobByOid(repoDir, "0".repeat(40)), null);
    assert.equal(await readBlobByOid(repoDir, "nope"), null);

    // A wholly different file is not a rename, and a blob the repo never
    // saw is simply left out (no throw).
    const other = [
      "name: Stripe",
      "type: webhook",
      "source: { type: connector, connection_id: 69c2719490eb18199aafa883 }",
      "destination: { connection_id: 69c2719490eb18199aafa884 }",
      "entities: { filter: [charges, refunds, payouts, customers] }",
      "sync: { engine: cdc, mode: incremental, write_mode: append_dedup }",
      "",
    ].join("\n");
    await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { writes: { "flows/stripe.yml": other } },
      { message: "add" },
    );
    const none = await detectGitRenames(
      repoDir,
      [
        { path: "flows/close-crm.yml", oid: blobOid(old) },
        { path: "flows/ghost.yml", oid: "f".repeat(40) },
        { path: "flows/unknown.yml", oid: undefined },
      ],
      [{ path: "flows/stripe.yml", oid: blobOid(other) }],
    );
    assert.deepEqual([...none], []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

void gitCases().then(() => {
  console.log("flow/dbt-job rename pairing: all assertions passed");
});
