/**
 * Laptop-rename pairing (graceful rename, rule 3): which vanished slug is
 * which appeared slug. The decision this protects is "never tear down a
 * live stream that merely moved" — and its mirror, "never re-key a stream
 * onto a different file", which is why ambiguity resolves to nothing and
 * why git's similarity and identical content only ever pair two files that
 * point at the same source and destination.
 *
 * The rules are pure and tested as data; git's rename detection is driven
 * against a real bare repo so the plumbing (`-M90%` over two synthetic
 * trees) is exercised, not mocked.
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
import { flowRenameTarget, parseFlowFile } from "../services/flow-config-files";
import {
  definitionIdentity,
  detectGitRenames,
  mergedAliases,
  pairRenamedSlugs,
  readBlobByOid,
} from "./flow-dbt-job-pairing";

const FLOW = (
  name: string,
  cron = "0 3 * * *",
  source = "6a2bd881b6f8c41ea17e9bc7",
) =>
  [
    `name: ${name}`,
    "type: scheduled",
    "source:",
    "  type: connector",
    `  connection_id: ${source}`,
    "destination:",
    "  connection_id: 69c2719490eb18199aafa882",
    "schedule:",
    `  cron: ${cron}`,
    "  timezone: UTC",
    "sync:",
    "  engine: cdc",
    "",
  ].join("\n");
/** The flows above (default source) all point at the same source + destination. */
const T = "same-target";

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

// ---- the target key: what a flow reads from and writes to -----------------
{
  const ch = parseFlowFile(FLOW("Close CH"));
  const fr = parseFlowFile(
    FLOW("Close FR", "0 3 * * *", "69c2719490eb18199aafa999"),
  );
  const chRenamed = parseFlowFile(FLOW("Close CH (renamed)", "0 9 * * *"));
  assert.ok(ch && fr && chRenamed);
  assert.notEqual(flowRenameTarget(ch), flowRenameTarget(fr));
  assert.equal(flowRenameTarget(ch), flowRenameTarget(chRenamed));
}

// ---- rule 1: the added file's aliases name the removed slug ---------------
{
  const result = pairRenamedSlugs({
    removed: [{ slug: "close-crm", contents: FLOW("Close"), target: T }],
    added: [
      {
        slug: "crm-sync",
        contents: FLOW("Close", "0 9 * * *"), // edited too: alias still wins
        aliases: ["close-crm"],
        target: T,
      },
      { slug: "unrelated", contents: FLOW("Other"), aliases: [], target: T },
    ],
  });
  assert.deepEqual(result.pairs, [
    { from: "close-crm", to: "crm-sync", via: "alias" },
  ]);
  assert.deepEqual(result.ambiguous, []);
  assert.deepEqual(result.targetMismatch, []);
}

// ---- rule 1 is FORWARD only. "The removed row lists the added slug as an
// alias" is exactly what a tree read before a rename commit looks like, and
// pairing on it would undo the rename. Not a pairing.
{
  const result = pairRenamedSlugs({
    removed: [
      {
        slug: "crm-sync",
        aliases: ["close-crm"],
        contents: FLOW("x"),
        target: T,
      },
    ],
    added: [
      {
        slug: "close-crm",
        contents: FLOW("y", "1 1 * * *"),
        aliases: [],
        target: T,
      },
    ],
  });
  assert.deepEqual(result.pairs, []);
}

// ---- rule 1 honours an explicit alias across targets, but reports it -----
{
  const result = pairRenamedSlugs({
    removed: [{ slug: "close-ch", contents: FLOW("CH"), target: "ch" }],
    added: [
      {
        slug: "close-fr",
        contents: FLOW("FR"),
        aliases: ["close-ch"],
        target: "fr",
      },
    ],
  });
  assert.deepEqual(result.pairs, [
    { from: "close-ch", to: "close-fr", via: "alias" },
  ]);
  assert.deepEqual(result.targetMismatch, [
    { from: "close-ch", to: "close-fr" },
  ]);
}

// ---- rule 1, shared old name: two renames of one flow raced on two
// instances (a→b won the mirror, a→c wrote the row). Both say they used to
// be `a` — the same stream when the targets agree, and not otherwise.
{
  const result = pairRenamedSlugs({
    removed: [{ slug: "c", aliases: ["a"], contents: FLOW("C"), target: T }],
    added: [{ slug: "b", contents: FLOW("B"), aliases: ["a"], target: T }],
  });
  assert.deepEqual(result.pairs, [{ from: "c", to: "b", via: "alias" }]);
}
{
  const result = pairRenamedSlugs({
    removed: [{ slug: "c", aliases: ["a"], contents: FLOW("C"), target: "x" }],
    added: [{ slug: "b", contents: FLOW("B"), aliases: ["a"], target: "y" }],
  });
  assert.deepEqual(result.pairs, []);
}

// ---- rule 2: git says so — and both files point at the same thing --------
{
  const result = pairRenamedSlugs({
    removed: [{ slug: "a", contents: FLOW("A"), target: T }],
    added: [
      { slug: "b", contents: FLOW("A", "5 5 * * *"), aliases: [], target: T },
    ],
    gitRenames: new Map([["a", "b"]]),
  });
  assert.deepEqual(result.pairs, [{ from: "a", to: "b", via: "git" }]);
  assert.deepEqual(result.targetMismatch, []);
}
{
  // The reviewer's case: delete close-ch, add close-fr — same boilerplate,
  // DIFFERENT source connection and schema. Git calls it a rename; it is
  // not one, and treating it as one would hand FR the CH checkpoints.
  const result = pairRenamedSlugs({
    removed: [{ slug: "close-ch", contents: FLOW("Close CH"), target: "ch" }],
    added: [
      {
        slug: "close-fr",
        contents: FLOW("Close FR"),
        aliases: [],
        target: "fr",
      },
    ],
    gitRenames: new Map([["close-ch", "close-fr"]]),
  });
  assert.deepEqual(result.pairs, []);
  assert.deepEqual(result.ambiguous, []);
}
{
  // An unknown target pairs with nothing under rules 2 and 3.
  const result = pairRenamedSlugs({
    removed: [{ slug: "a", contents: FLOW("A"), target: null }],
    added: [{ slug: "b", contents: FLOW("A"), aliases: [], target: null }],
    gitRenames: new Map([["a", "b"]]),
  });
  assert.deepEqual(result.pairs, []);
}
{
  // Git naming a slug that was not added is not a pairing.
  const result = pairRenamedSlugs({
    removed: [{ slug: "a", contents: FLOW("A"), target: T }],
    added: [
      { slug: "b", contents: FLOW("B", "5 5 * * *"), aliases: [], target: T },
    ],
    gitRenames: new Map([["a", "zzz"]]),
  });
  assert.deepEqual(result.pairs, []);
}

// ---- rule 3: identical apart from name/aliases, same target ---------------
{
  const result = pairRenamedSlugs({
    removed: [{ slug: "a", contents: FLOW("Old"), target: T }],
    added: [{ slug: "b", contents: FLOW("New"), aliases: [], target: T }],
  });
  assert.deepEqual(result.pairs, [{ from: "a", to: "b", via: "identical" }]);
}
{
  // Identical YAML but a different target: the target wins, no pairing.
  const result = pairRenamedSlugs({
    removed: [{ slug: "a", contents: FLOW("Old"), target: "x" }],
    added: [{ slug: "b", contents: FLOW("New"), aliases: [], target: "y" }],
  });
  assert.deepEqual(result.pairs, []);
}
{
  // A removed slug with no known contents cannot be paired by content.
  const result = pairRenamedSlugs({
    removed: [{ slug: "a", target: T }],
    added: [{ slug: "b", contents: FLOW("New"), aliases: [], target: T }],
  });
  assert.deepEqual(result.pairs, []);
  assert.deepEqual(result.ambiguous, []);
}

// ---- ambiguity is never guessed --------------------------------------------
{
  // Two added files both claim the old slug.
  const result = pairRenamedSlugs({
    removed: [{ slug: "a", contents: FLOW("A"), target: T }],
    added: [
      { slug: "b", contents: FLOW("B"), aliases: ["a"], target: T },
      { slug: "c", contents: FLOW("C"), aliases: ["a"], target: T },
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
    removed: [{ slug: "a", contents: FLOW("A"), target: T }],
    added: [
      { slug: "b", contents: FLOW("B"), aliases: [], target: T },
      { slug: "c", contents: FLOW("C"), aliases: [], target: T },
    ],
  });
  assert.deepEqual(result.pairs, []);
  assert.equal(result.ambiguous[0]?.rule, "identical");
}
{
  // Two removed slugs both identical to ONE added file: given to neither.
  const result = pairRenamedSlugs({
    removed: [
      { slug: "a", contents: FLOW("A"), target: T },
      { slug: "b", contents: FLOW("B"), target: T },
    ],
    added: [{ slug: "c", contents: FLOW("C"), aliases: [], target: T }],
  });
  assert.deepEqual(result.pairs, []);
  assert.deepEqual(result.ambiguous.map(e => e.slug).sort(), ["a", "b"]);
}
{
  // An ambiguous higher rule does not fall through to a lower one.
  const result = pairRenamedSlugs({
    removed: [{ slug: "a", contents: FLOW("A"), target: T }],
    added: [
      { slug: "b", contents: FLOW("B"), aliases: ["a"], target: T },
      {
        slug: "c",
        contents: FLOW("C", "9 9 * * *"),
        aliases: ["a"],
        target: T,
      },
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
  { pairs: [], ambiguous: [], targetMismatch: [] },
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

    // At 90% a file that only shares the format's boilerplate (different
    // connection, different name) is not a rename any more — git's default
    // 50% reported exactly that as one.
    const lookalike = FLOW("Close FR", "0 3 * * *", "69c2719490eb18199aafa999");
    await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { writes: { "flows/close-fr.yml": lookalike } },
      { message: "add fr" },
    );
    assert.deepEqual(
      [
        ...(await detectGitRenames(
          repoDir,
          [{ path: "flows/close-crm.yml", oid: blobOid(old) }],
          [{ path: "flows/close-fr.yml", oid: blobOid(lookalike) }],
        )),
      ],
      [],
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
