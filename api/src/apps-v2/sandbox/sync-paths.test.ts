/**
 * Regression guard for the §10 Block B sync bug.
 *
 * Apps used to BE the repo root, so `--exclude ./node_modules` matched. Once
 * apps became `apps/<slug>/` folders and `app2_bash` started running with
 * cwd = the app root, every install wrote a NESTED `apps/<slug>/node_modules`
 * that these root-anchored patterns no longer matched. The nested tree was
 * then round-tripped host<->sandbox on every command: `stripLinks` deleted the
 * symlinks in it (emptying `.bin/`, so `tsc`/`vite` vanished while the package
 * files stayed readable), and tens of MB moved per exec.
 *
 * These assertions encode the invariant: sandbox-local paths must be matched
 * at ANY depth, never anchored to the archive root.
 */
import assert from "node:assert/strict";
import {
  SANDBOX_LOCAL,
  SYNC_OUT_IGNORES,
  excludeArgs,
  sandboxLocalFindFilter,
} from "./e2b-provider";

const patterns = excludeArgs().filter(arg => arg !== "--exclude");

// The bug, stated directly: a leading "./" anchors the pattern to the archive
// root in GNU tar, which is what let nested node_modules escape.
for (const pattern of patterns) {
  assert.ok(
    !pattern.startsWith("./"),
    `tar exclude ${JSON.stringify(pattern)} is anchored to the archive root; ` +
      `nested apps/<slug>/${pattern.replace("./", "")} would be synced`,
  );
}

assert.deepEqual(
  patterns,
  [...SANDBOX_LOCAL],
  "every sandbox-local dir must be excluded, by bare name",
);

const filter = sandboxLocalFindFilter();
for (const name of SANDBOX_LOCAL) {
  assert.ok(
    filter.includes(`"*/${name}"`),
    `find filter must preserve a nested ${name} directory`,
  );
  assert.ok(
    filter.includes(`"*/${name}/*"`),
    `find filter must preserve the contents of a nested ${name}`,
  );
}

// .git syncs IN but never OUT; it must not be dropped from the in-bound pack.
assert.ok(
  SYNC_OUT_IGNORES.includes(".git"),
  ".git must never be synced out of the sandbox",
);
assert.ok(
  !SANDBOX_LOCAL.includes(".git"),
  ".git must still sync INTO the sandbox so in-session git works",
);

console.log("sync-paths.test.ts: all assertions passed");
