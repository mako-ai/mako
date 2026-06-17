/* eslint-disable no-console, no-process-exit */
/**
 * Unit tests for the dbt warm-dir / cache pure logic that ships on-by-default.
 *
 * Run with: tsx src/dbt/warm-dir-cache.test.ts (no DB / network / dbt needed).
 *
 * Covers:
 *   - selectWarmDirsToReap — eviction policy (count cap LRU, TTL, lock skip)
 *   - computePackagesHash  — "are there real packages?" heuristic + stable hash
 *   - writeFileIfChanged   — change detection (must NOT rewrite identical
 *                            content, or it bumps mtime and defeats dbt's
 *                            checksum-based partial parsing)
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { selectWarmDirsToReap } from "./workspace-dir.service";
import { computePackagesHash } from "./dbt-cache.service";
import { writeFileIfChanged } from "./runner.service";

const HOUR = 60 * 60 * 1000;
const noLocks = () => false;

function testReapNothingWhenHealthy() {
  const now = 1_000_000;
  const reaped = selectWarmDirsToReap(
    [
      { dir: "a", mtimeMs: now - 1000 },
      { dir: "b", mtimeMs: now - 2000 },
    ],
    { now, maxDirs: 40, ttlMs: 24 * HOUR, isLocked: noLocks },
  );
  assert.deepEqual(reaped, [], "under cap + within TTL → reap nothing");
}

function testCountCapEvictsOldest() {
  const now = 1_000_000;
  const reaped = selectWarmDirsToReap(
    [
      { dir: "newest", mtimeMs: now - 100 },
      { dir: "oldest", mtimeMs: now - 9000 },
      { dir: "middle", mtimeMs: now - 5000 },
    ],
    { now, maxDirs: 2, ttlMs: 24 * HOUR, isLocked: noLocks },
  );
  assert.deepEqual(reaped, ["oldest"], "count cap evicts the LRU dir first");
}

function testTtlEvictsStale() {
  const now = 1_000_000;
  const reaped = selectWarmDirsToReap(
    [
      { dir: "fresh", mtimeMs: now - 1 * HOUR },
      { dir: "stale", mtimeMs: now - 30 * HOUR },
    ],
    { now, maxDirs: 40, ttlMs: 24 * HOUR, isLocked: noLocks },
  );
  assert.deepEqual(
    reaped,
    ["stale"],
    "TTL evicts the idle dir regardless of cap",
  );
}

function testNeverReapsLockedDir() {
  const now = 1_000_000;
  const reaped = selectWarmDirsToReap(
    [
      { dir: "locked-stale", mtimeMs: now - 30 * HOUR },
      { dir: "idle-stale", mtimeMs: now - 30 * HOUR },
    ],
    {
      now,
      maxDirs: 1,
      ttlMs: 24 * HOUR,
      isLocked: dir => dir === "locked-stale",
    },
  );
  assert.deepEqual(
    reaped,
    ["idle-stale"],
    "an in-flight (locked) dir is never reaped",
  );
  assert.ok(!reaped.includes("locked-stale"));
}

function testCountCapAndTtlDeduped() {
  const now = 1_000_000;
  const reaped = selectWarmDirsToReap(
    [
      { dir: "a", mtimeMs: now - 40 * HOUR }, // overflow AND stale
      { dir: "b", mtimeMs: now - 2000 },
      { dir: "c", mtimeMs: now - 1000 },
    ],
    { now, maxDirs: 2, ttlMs: 24 * HOUR, isLocked: noLocks },
  );
  assert.deepEqual(reaped, ["a"], "a dir hit by both rules appears once");
}

function testPackagesHash() {
  assert.equal(
    computePackagesHash([{ path: "dbt_project.yml", content: "x" }]),
    null,
    "no packages files → null",
  );
  assert.equal(
    computePackagesHash([
      { path: "packages.yml", content: "# packages:\n#  - package: foo" },
    ]),
    null,
    "comments-only → null",
  );
  assert.equal(
    computePackagesHash([{ path: "packages.yml", content: "packages:\n" }]),
    null,
    "empty declaration → null",
  );

  const files = [
    {
      path: "packages.yml",
      content: "packages:\n  - package: dbt-labs/dbt_utils\n    version: 1.1.1",
    },
  ];
  const h1 = computePackagesHash(files);
  const h2 = computePackagesHash([...files]);
  assert.match(h1 ?? "", /^[0-9a-f]{64}$/, "real packages → sha256 hex");
  assert.equal(h1, h2, "hash is stable for identical declarations");

  const other = computePackagesHash([
    {
      path: "packages.yml",
      content: "packages:\n  - package: a/x\n    version: 2",
    },
  ]);
  assert.notEqual(h1, other, "different declarations → different hash");
}

async function testWriteFileIfChanged(dir: string) {
  const missing = join(dir, "new.txt");
  assert.equal(
    await writeFileIfChanged(missing, "hello"),
    true,
    "writes when missing",
  );
  assert.equal(await readFile(missing, "utf8"), "hello");

  const stable = join(dir, "stable.txt");
  assert.equal(await writeFileIfChanged(stable, "same"), true);
  const before = (await stat(stable)).mtimeMs;
  await new Promise(r => setTimeout(r, 20));
  assert.equal(
    await writeFileIfChanged(stable, "same"),
    false,
    "identical content → no write",
  );
  const after = (await stat(stable)).mtimeMs;
  assert.equal(
    after,
    before,
    "mtime untouched so dbt partial parse stays valid",
  );

  const changing = join(dir, "changing.txt");
  await writeFile(changing, "v1");
  assert.equal(
    await writeFileIfChanged(changing, "v2"),
    true,
    "rewrites on change",
  );
  assert.equal(await readFile(changing, "utf8"), "v2");
}

async function main() {
  testReapNothingWhenHealthy();
  testCountCapEvictsOldest();
  testTtlEvictsStale();
  testNeverReapsLockedDir();
  testCountCapAndTtlDeduped();
  testPackagesHash();

  const dir = mkdtempSync(join(tmpdir(), "mako-wfc-"));
  try {
    await testWriteFileIfChanged(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(
    "warm-dir-cache.test: OK — reaper policy, packages hash, change-detection",
  );
  process.exit(0);
}

void main();
