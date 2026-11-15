/**
 * repo_glob / repo_grep / repo_read_file: the visibility rule and the
 * pathspec sandbox. The git reads are the repository.service functions the
 * app tools already cover.
 *
 * Run: tsx src/agent-lib/tools/repo-tools.test.ts
 */
import assert from "node:assert/strict";
import {
  createRepoTools,
  repoPathVisibility,
  safePathspec,
} from "./repo-tools";

// --- the three tools exist and are read-only by shape -----------------------
{
  const tools = createRepoTools({ workspaceId: "000000000000000000000000" });
  assert.deepEqual(Object.keys(tools).sort(), [
    "repo_glob",
    "repo_grep",
    "repo_read_file",
  ]);
}

// --- another person's private app and personal tree are invisible ----------
{
  const isVisible = repoPathVisibility({
    hiddenAppRoots: ["users/bob/apps/secret", "apps/finance/payroll"],
    visibleAppRoots: ["users/bob/apps/shared", "apps/sales"],
    ownHandle: "alice",
  });
  assert.equal(isVisible("dbt/models/marts/fct_mrr.sql"), true);
  assert.equal(isVisible("dbt/ontology/terms.yml"), true);
  assert.equal(isVisible("apps/sales/bindings/mrr.sql"), true);
  assert.equal(isVisible("apps/finance/payroll/bindings/pay.sql"), false);
  assert.equal(isVisible("apps/finance/payroll"), false);
  assert.equal(isVisible("users/alice/apps/mine/src/App.tsx"), true);
  assert.equal(isVisible("users/alice/notes.md"), true);
  assert.equal(isVisible("users/bob/apps/secret/src/App.tsx"), false);
  assert.equal(isVisible("users/bob/notes.md"), false);
  assert.equal(isVisible("users/bob/apps/shared/src/App.tsx"), true);
  // A sibling whose name only starts like a hidden root stays visible.
  assert.equal(isVisible("apps/finance/payroll-v2/x.sql"), true);
}

// --- no user (a workspace key without one): everything --------------------
{
  const isVisible = repoPathVisibility({
    hiddenAppRoots: ["users/bob/apps/secret"],
    visibleAppRoots: [],
    everything: true,
  });
  assert.equal(isVisible("users/bob/apps/secret/src/App.tsx"), true);
}

// --- pathspec stays inside the repo -------------------------------------------
{
  assert.equal(safePathspec(undefined), undefined);
  assert.equal(safePathspec("."), undefined);
  assert.equal(safePathspec("dbt/models/"), "dbt/models");
  assert.throws(() => safePathspec("../etc"));
  assert.throws(() => safePathspec("/etc/passwd"));
  assert.throws(() => safePathspec(".git/config"));
  assert.throws(() => safePathspec(":(top)"));
}

// eslint-disable-next-line no-console
console.log("repo-tools.test.ts: all assertions passed");
// The tool factories import the agent stack (loggers, mongoose schemas).
// eslint-disable-next-line no-process-exit
process.exit(0);
