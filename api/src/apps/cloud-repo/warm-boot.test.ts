/**
 * The boot repo warm and the startup check it holds (2026-11-16: a new
 * instance's first apps request was a 12 s clone that filled the pool).
 *
 * - `/health/ready` is not ready while the warm runs, ready once it ends;
 * - it is ready at the cap even when a clone hangs: the instance starts
 *   as it did before;
 * - one failing workspace does not stop the others;
 * - a failure to list the hot workspaces still ends the warm.
 *
 * Run: tsx src/apps/cloud-repo/warm-boot.test.ts
 */
import assert from "node:assert/strict";
import {
  repoWarmReady,
  resetRepoWarmForTests,
  startRepoWarmOnBoot,
  warmWorkspaceRepos,
} from "./warm-boot";

async function readyFollowsTheWarm() {
  resetRepoWarmForTests();
  assert.equal(repoWarmReady(), true, "no warm started: ready");

  let finish!: () => void;
  const clone = new Promise<void>(r => (finish = r));
  const done = startRepoWarmOnBoot({
    maxWaitMs: 60_000,
    listHot: async () => ["ws1"],
    ensure: () => clone,
  });
  assert.equal(repoWarmReady(), false, "warming: not ready");
  finish();
  await done;
  assert.equal(repoWarmReady(), true, "warm finished: ready");
}

async function readyAtTheCap() {
  resetRepoWarmForTests();
  const started = Date.now();
  void startRepoWarmOnBoot({
    maxWaitMs: 60_000,
    listHot: async () => ["ws1"],
    ensure: () => new Promise(() => {}), // a clone that never ends
  });
  assert.equal(repoWarmReady(started + 59_000), false);
  assert.equal(repoWarmReady(started + 60_001), true, "cap passed: ready");
}

async function failuresDoNotStopTheWarm() {
  const seen: string[] = [];
  const result = await warmWorkspaceRepos(["a", "b", "c", "d"], {
    concurrency: 2,
    ensure: async id => {
      seen.push(id);
      if (id === "b") throw new Error("clone failed");
    },
  });
  assert.deepEqual(result, { warmed: 3, failed: 1 });
  assert.deepEqual([...seen].sort(), ["a", "b", "c", "d"]);

  // Never more than `concurrency` clones at once.
  let running = 0;
  let peak = 0;
  await warmWorkspaceRepos(["1", "2", "3", "4", "5", "6"], {
    concurrency: 3,
    ensure: async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(r => setTimeout(r, 5));
      running--;
    },
  });
  assert.equal(peak, 3);

  resetRepoWarmForTests();
  await startRepoWarmOnBoot({
    listHot: async () => {
      throw new Error("db down");
    },
  });
  assert.equal(repoWarmReady(), true, "a failed listing still ends the warm");
}

(async () => {
  await readyFollowsTheWarm();
  await readyAtTheCap();
  await failuresDoNotStopTheWarm();
  console.info("boot repo warm tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
