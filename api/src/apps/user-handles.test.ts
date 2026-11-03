/**
 * Personal folder handles: derivation, deterministic assignment, and the
 * directory every `users/<x>/` path resolves its owner through.
 *
 * Run: npx tsx src/apps/user-handles.test.ts
 */
import assert from "node:assert/strict";
import {
  OwnerDirectory,
  assignHandles,
  handleFromEmail,
  isHandle,
} from "./user-handles";

// Derivation --------------------------------------------------------------

assert.equal(handleFromEmail("joan@realadvisor.com"), "joan");
assert.equal(
  handleFromEmail("Joan.Rodriguez@RealAdvisor.com"),
  "joan.rodriguez",
);
assert.equal(handleFromEmail("joan+mako@gmail.com"), "joan");
assert.equal(handleFromEmail("josé.müller@x.ch"), "jose.muller");
assert.equal(handleFromEmail("a b/c\\d@x"), "a-b-c-d");
assert.equal(handleFromEmail("..weird..@x"), "weird");
assert.equal(handleFromEmail("@x.com"), "user");
assert.ok(handleFromEmail(`${"a".repeat(80)}@x`).length <= 40);
for (const email of [
  "joan@realadvisor.com",
  "Joan.Rodriguez@x",
  "..weird..@x",
  "a b/c\\d@x",
  "_x_@y",
]) {
  assert.ok(isHandle(handleFromEmail(email)), email);
}

// Grammar: lowercase, path- and URL-safe, no traversal.
assert.ok(isHandle("joan"));
assert.ok(isHandle("joan-2"));
assert.ok(isHandle("kirill.vakalov"));
assert.ok(!isHandle("Joan"));
assert.ok(!isHandle(".joan"));
assert.ok(!isHandle("joan."));
assert.ok(!isHandle("jo..an"));
assert.ok(!isHandle(".."));
assert.ok(!isHandle("a/b"));
assert.ok(!isHandle(""));

// Assignment --------------------------------------------------------------

// Oldest member keeps the bare handle; the next gets -2, then -3 — in input
// order or not, because every instance and the migration must agree.
const joans = [
  { userId: "late", email: "joan@other.com", joinedAt: new Date("2026-03-01") },
  {
    userId: "early",
    email: "joan@realadvisor.com",
    joinedAt: new Date("2025-01-01"),
  },
  { userId: "mid", email: "Joan@gmail.com", joinedAt: new Date("2026-01-01") },
];
const assigned = assignHandles(joans, []);
assert.deepEqual(assigned, [
  { userId: "early", handle: "joan" },
  { userId: "mid", handle: "joan-2" },
  { userId: "late", handle: "joan-3" },
]);
assert.deepEqual(assignHandles([...joans].reverse(), []), assigned);

// Existing handles are kept and never handed out again — a departed
// member's handle stays theirs.
assert.deepEqual(
  assignHandles(
    [{ userId: "new", email: "joan@x.com", joinedAt: new Date() }],
    [{ userId: "gone", handle: "joan" }],
  ),
  [{ userId: "new", handle: "joan-2" }],
);
// Already-handled people are skipped; duplicate candidates count once.
assert.deepEqual(
  assignHandles(
    [
      { userId: "gone", email: "joan@x.com" },
      { userId: "b", email: "bob@x.com" },
      { userId: "b", email: "bob@x.com" },
    ],
    [{ userId: "gone", handle: "joan" }],
  ),
  [{ userId: "b", handle: "bob" }],
);
// A handle may never spell a known userId: an old `users/<thatId>/` folder
// would resolve to the wrong person.
assert.deepEqual(
  assignHandles(
    [{ userId: "u1", email: "165tpi4r5ozyuv9@x.com" }],
    [],
    new Set(["165tpi4r5ozyuv9"]),
  ),
  [{ userId: "u1", handle: "165tpi4r5ozyuv9-2" }],
);
// Members without a join date sort after those with one.
assert.deepEqual(
  assignHandles(
    [
      { userId: "z", email: "sam@x" },
      { userId: "y", email: "sam@y", joinedAt: new Date("2026-01-01") },
    ],
    [],
  ),
  [
    { userId: "y", handle: "sam" },
    { userId: "z", handle: "sam-2" },
  ],
);

// Directory: the only way a segment names an owner ------------------------

const dir = new OwnerDirectory([
  { userId: "165tpi4r5ozyuv9", handle: "joan" },
  { userId: "v0vn7md31n3ly5d", handle: "jakub" },
]);
assert.equal(dir.ownerOf("joan"), "165tpi4r5ozyuv9");
assert.equal(dir.handleOf("v0vn7md31n3ly5d"), "jakub");
// A raw userId is NOT a way into someone's tree.
assert.equal(dir.ownerOf("165tpi4r5ozyuv9"), null);
// Unknown handles, case variants and empties are nobody's.
assert.equal(dir.ownerOf("ghost"), null);
assert.equal(dir.ownerOf("Joan"), null);
assert.equal(dir.ownerOf(""), null);
assert.equal(dir.ownerOf(undefined), null);
assert.equal(dir.handleOf("nobody"), undefined);
assert.equal(dir.handleOf(undefined), undefined);

console.log("user-handles: ok");
