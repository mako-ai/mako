/**
 * The boot repo warm and the startup check it holds (2026-11-16: a new
 * instance's first apps request was a 12 s clone that filled the pool).
 *
 * - `/health/ready` waits only for the 5 most recent workspaces; the rest
 *   clone after the instance is ready;
 * - the wait is capped, counted from process start: past it the instance
 *   starts as it did before, even when a clone hangs;
 * - a repo over 300 MB is never warmed, and the warm stops at 1.5 GB;
 * - one failing workspace does not stop the others;
 * - a failure to list the hot workspaces still ends the warm.
 *
 * Run: tsx src/apps/cloud-repo/warm-boot.test.ts
 */
import assert from "node:assert/strict";
import {
  REPO_WARM_MAX_WAIT_MS,
  planRepoWarm,
  repoWarmReady,
  resetRepoWarmForTests,
  startRepoWarmOnBoot,
  warmWorkspaceRepos,
} from "./warm-boot";

const MB = 1024 * 1024;
const small = async () => 10 * MB;

async function readyWaitsOnlyForTheGate() {
  resetRepoWarmForTests();
  assert.equal(repoWarmReady(), true, "no warm started: ready");

  const ids = ["w1", "w2", "w3", "w4", "w5", "w6", "w7"];
  const finish = new Map<string, () => void>();
  const cloned: string[] = [];
  const done = startRepoWarmOnBoot({
    listHot: async () => ids,
    sizeOf: small,
    ensure: id =>
      new Promise<void>(r =>
        finish.set(id, () => {
          cloned.push(id);
          r();
        }),
      ),
  });
  const tick = () => new Promise(r => setTimeout(r, 5));
  await tick();
  assert.equal(repoWarmReady(), false, "gated clones running: not ready");
  // Release the gated five; the instance is ready with w6, w7 still to go.
  for (let i = 0; i < 5; i++) {
    for (const id of ["w1", "w2", "w3", "w4", "w5"]) {
      finish.get(id)?.();
      finish.delete(id);
    }
    await tick();
  }
  assert.equal(repoWarmReady(), true, "gated part done: ready");
  assert.deepEqual([...cloned].sort(), ["w1", "w2", "w3", "w4", "w5"]);
  await tick();
  for (const id of ["w6", "w7"]) finish.get(id)?.();
  await done;
  assert.deepEqual([...cloned].sort(), ids, "the rest warm in the background");
}

async function readyAtTheCapFromWarmStart() {
  resetRepoWarmForTests();
  assert.equal(REPO_WARM_MAX_WAIT_MS, 90_000);
  const before = Date.now();
  void startRepoWarmOnBoot({
    listHot: async () => ["ws1"],
    sizeOf: small,
    ensure: () => new Promise(() => {}), // a clone that never ends
  });
  // 13:17 on 2026-11-17: a clone still running 30 s in must hold the gate.
  assert.equal(repoWarmReady(before + 30_000), false, "30 s in: warming");
  assert.equal(repoWarmReady(before + 89_000), false, "89 s in: warming");
  assert.equal(repoWarmReady(Date.now() + 90_001), true, "cap passed: ready");
}

async function sizeBudget() {
  const sizes: Record<string, number | null> = {
    a: 200 * MB,
    huge: 400 * MB, // over 300 MB: never warmed
    none: null, // no repo bound
    b: 250 * MB,
    c: 280 * MB,
    d: 290 * MB,
    e: 290 * MB,
    f: 290 * MB, // would pass 1.5 GB in total
    g: 100 * MB, // still fits
  };
  const plan = await planRepoWarm(Object.keys(sizes), {
    sizeOf: async id => sizes[id],
  });
  assert.deepEqual(plan.ids, ["a", "b", "c", "d", "e", "g"]);
  assert.equal(plan.bytes, 1410 * MB);
  assert.equal(plan.skipped, 2);

  // A size GitHub would not give skips that workspace only.
  const failing = await planRepoWarm(["x", "y"], {
    sizeOf: async id => {
      if (id === "x") throw new Error("GitHub 500");
      return MB;
    },
  });
  assert.deepEqual(failing.ids, ["y"]);
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
  await readyWaitsOnlyForTheGate();
  await readyAtTheCapFromWarmStart();
  await sizeBudget();
  await failuresDoNotStopTheWarm();
  console.info("boot repo warm tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
