/**
 * The users/<userId>/ → users/<handle>/ rename plan.
 *
 * Run: npx tsx src/apps/user-folder-migration.test.ts
 */
import assert from "node:assert/strict";
import {
  planUserFolderRenames,
  rewriteUserPath,
  userSegments,
} from "./user-folder-migration";

const files = [
  "users/165tpi4r5ozyuv9/apps/decks/mako.json",
  "users/165tpi4r5ozyuv9/consoles/all/x.sql",
  "users/v0vn7md31n3ly5d/notebooks/a.deepnote",
  "users/jakub/consoles/new.sql", // already renamed (created after deploy)
  "users/v0vn7md31n3ly5d/consoles/new.sql", // …and clashes with it
  "users/deadbeefdeadbee/consoles/old.sql", // nobody's
  "users/joan2/apps/x/mako.json", // a handle already in place
];
const handles = [
  { userId: "165tpi4r5ozyuv9", handle: "joan" },
  { userId: "v0vn7md31n3ly5d", handle: "jakub" },
  { userId: "u-joan2", handle: "joan2" },
];

assert.deepEqual(userSegments(files), [
  "165tpi4r5ozyuv9",
  "deadbeefdeadbee",
  "jakub",
  "joan2",
  "v0vn7md31n3ly5d",
]);

const plan = planUserFolderRenames(files, handles);
assert.deepEqual(
  plan.renames.map(r => [r.from, r.to, r.files.length]),
  [["users/165tpi4r5ozyuv9", "users/joan", 2]],
);
assert.deepEqual(plan.renames[0].files[1], {
  from: "users/165tpi4r5ozyuv9/consoles/all/x.sql",
  to: "users/joan/consoles/all/x.sql",
});
assert.deepEqual(plan.alreadyHandles, ["users/jakub", "users/joan2"]);
assert.deepEqual(plan.orphans, ["users/deadbeefdeadbee"]);
assert.deepEqual(plan.conflicts, [
  {
    from: "users/v0vn7md31n3ly5d",
    to: "users/jakub",
    files: ["users/jakub/consoles/new.sql"],
  },
]);

// Stored paths: only those under a renamed folder, prefix-exact.
const renames = plan.renames;
assert.equal(
  rewriteUserPath("users/165tpi4r5ozyuv9/apps/decks", renames),
  "users/joan/apps/decks",
);
assert.equal(rewriteUserPath("users/165tpi4r5ozyuv9", renames), "users/joan");
assert.equal(rewriteUserPath("users/165tpi4r5ozyuv9x/apps/a", renames), null);
assert.equal(rewriteUserPath("apps/165tpi4r5ozyuv9", renames), null);
assert.equal(rewriteUserPath(undefined, renames), null);

console.log("user-folder-migration: ok");
