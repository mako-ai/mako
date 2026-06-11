/**
 * Self-running test for the console write-guard matrix.
 * Run with: pnpm --filter api exec tsx src/services/console-save-guards.test.ts
 */
import assert from "node:assert/strict";
import { buildConsoleWriteGuard } from "./console-save-guards";

const base = { _id: "X", workspaceId: "W" };

// --- no guards ---------------------------------------------------------------

{
  const g = buildConsoleWriteGuard({ baseFilter: base, docExists: true });
  assert.deepEqual(g.filter, base, "no expectations ⇒ identity filter");
  assert.equal(g.guardActive, false, "no expectations ⇒ guard inactive");
}

{
  // Guards never engage for documents that don't exist yet (first-time
  // upsert has nothing to conflict with).
  const g = buildConsoleWriteGuard({
    baseFilter: base,
    docExists: false,
    expectedVersion: 3,
    expectedDraftRevision: 7,
  });
  assert.deepEqual(g.filter, base, "missing doc ⇒ identity filter");
  assert.equal(g.guardActive, false, "missing doc ⇒ guard inactive (upsert ok)");
}

// --- single guards -----------------------------------------------------------

{
  const g = buildConsoleWriteGuard({
    baseFilter: base,
    docExists: true,
    expectedVersion: 3,
  });
  assert.deepEqual(g.filter, { ...base, version: 3 });
  assert.equal(g.guardActive, true);
}

{
  const g = buildConsoleWriteGuard({
    baseFilter: base,
    docExists: true,
    expectedDraftRevision: 7,
  });
  assert.deepEqual(g.filter, { ...base, draftRevision: 7 });
  assert.equal(g.guardActive, true);
}

// --- dual guard (explicit saves) ----------------------------------------------

{
  const g = buildConsoleWriteGuard({
    baseFilter: base,
    docExists: true,
    expectedVersion: 3,
    expectedDraftRevision: 7,
  });
  assert.deepEqual(
    g.filter,
    { ...base, version: 3, draftRevision: 7 },
    "explicit saves check BOTH counters",
  );
  assert.equal(g.guardActive, true);
}

// --- legacy documents (counters predate the fields ⇒ count as 1) --------------

{
  const g = buildConsoleWriteGuard({
    baseFilter: base,
    docExists: true,
    expectedVersion: 1,
    expectedDraftRevision: 1,
  });
  assert.deepEqual(g.filter, {
    ...base,
    version: { $in: [1, null] },
    draftRevision: { $in: [1, null] },
  });
}

// --- invalid expectations are ignored (defensive parsing belongs here too) ----

{
  const g = buildConsoleWriteGuard({
    baseFilter: base,
    docExists: true,
    expectedVersion: 0,
    expectedDraftRevision: 2.5,
  });
  assert.deepEqual(g.filter, base, "non-positive / non-integer ⇒ ignored");
  assert.equal(g.guardActive, false);
}

// eslint-disable-next-line no-console -- self-running test, not API code
console.log("console-save-guards.test.ts: all assertions passed");
