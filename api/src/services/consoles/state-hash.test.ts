/**
 * The server's saved-state hash must equal the client's for the same
 * snapshot (app/src/utils/hash.ts + stateHash.ts), or Save misdetects
 * dirt. The expected values below were produced by the app's functions.
 *
 * Run with: pnpm --filter api exec tsx src/services/consoles/state-hash.test.ts
 */
import assert from "node:assert/strict";
import { computeConsoleStateHash, hashContent } from "./state-hash";

assert.equal(hashContent(""), "0");
assert.equal(hashContent("hello world"), "6aefe2c4");
assert.equal(computeConsoleStateHash("SELECT 1", "c1", "d1", "db"), "36f9a9b2");
// Missing connection / database fields hash as empty strings.
assert.equal(computeConsoleStateHash("select * from t"), "180b6d24");
assert.equal(
  computeConsoleStateHash("select * from t", undefined, "", undefined),
  computeConsoleStateHash("select * from t"),
);

console.info("console state-hash tests passed");
