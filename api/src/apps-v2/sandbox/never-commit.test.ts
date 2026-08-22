/**
 * The snapshot is taken with `git add -A` at the repository root, so anything
 * git does not ignore gets staged — and one `npm install` puts a hundred
 * thousand files in the tree. A scaffolded app ignores them itself, but an
 * imported repository need not, so the sandbox installs its own excludes as a
 * backstop. These assert the list is the one that matters and is expressed in
 * a form git actually honours.
 */
import assert from "node:assert/strict";
import { NEVER_COMMIT } from "../box";

assert.ok(
  NEVER_COMMIT.includes("node_modules"),
  "node_modules is the whole reason this list exists",
);
for (const name of [".npm", ".cache", ".vite", ".pnpm-store", "dist"]) {
  assert.ok(NEVER_COMMIT.includes(name), `${name} must never be committed`);
}

// Unanchored, so a NESTED apps/<slug>/node_modules is caught too — the flat
// form only matches at the repository root, which is not where an app's
// dependencies land.
for (const name of NEVER_COMMIT) {
  assert.ok(!name.startsWith("/"), `${name} must not be anchored to the root`);
  assert.ok(!name.includes("*"), `${name} should be a plain directory name`);
}

// `.git` is deliberately absent: it is not ignored, it IS the repository. The
// old sync layer had to exclude it because it copied trees around; nothing
// copies a tree any more.
assert.ok(
  !NEVER_COMMIT.includes(".git"),
  ".git is the repository, not an ignorable directory",
);

console.log("never-commit: all assertions passed");
