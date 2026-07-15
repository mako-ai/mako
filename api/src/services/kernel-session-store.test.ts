/* eslint-disable no-console, no-process-exit */
/**
 * Contract tests for the in-process SessionStore — put/get/delete/touch/list
 * round-trip plus the creation lock's mutual exclusion. The Redis store
 * implements the same interface (covered by the live preview check); this
 * guards the interface + the lock semantics both backends must honour.
 *
 * Run with: tsx src/services/kernel-session-store.test.ts
 */
import assert from "node:assert/strict";

delete process.env.REDIS_URL; // force the in-process backend

import {
  getSessionStore,
  resetSessionStoreForTests,
  type StoredSession,
} from "./kernel-session-store";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function fixture(overrides: Partial<StoredSession> = {}): StoredSession {
  const now = Date.now();
  return {
    sessionId: "s1",
    workspaceId: "w",
    notebookId: "n",
    userId: "u",
    provider: "gke",
    endpoint: { baseUrl: "http://10.0.0.1:8888", podIp: "10.0.0.1", podName: "pod-1" },
    kernelId: "k1",
    kernelToken: "mnk_abc.def",
    tokenExpMs: now + 900_000,
    startedAtMs: now,
    lastActivityAtMs: now,
    ...overrides,
  };
}

async function testCrudRoundTrip() {
  resetSessionStoreForTests();
  const store = getSessionStore();
  assert.equal(store.kind, "memory");

  assert.equal(await store.get("w:n"), null);
  const rec = fixture();
  await store.put("w:n", rec);
  assert.deepEqual(await store.get("w:n"), rec);
  assert.equal((await store.list()).length, 1);

  await store.delete("w:n");
  assert.equal(await store.get("w:n"), null);
  assert.equal((await store.list()).length, 0);
}

async function testTouchPatchesAndPreserves() {
  resetSessionStoreForTests();
  const store = getSessionStore();
  await store.put("w:n", fixture({ kernelToken: "mnk_old", tokenExpMs: 111 }));

  await store.touch("w:n", {
    kernelToken: "mnk_new",
    tokenExpMs: 999,
    lastActivityAtMs: 42,
  });
  const s = await store.get("w:n");
  assert.equal(s?.kernelToken, "mnk_new");
  assert.equal(s?.tokenExpMs, 999);
  assert.equal(s?.lastActivityAtMs, 42);
  // Untouched fields survive.
  assert.equal(s?.kernelId, "k1");
  assert.equal(s?.provider, "gke");

  // touch on a missing key is a no-op (never creates).
  await store.touch("gone", { lastActivityAtMs: 1 });
  assert.equal(await store.get("gone"), null);
}

async function testLockMutualExclusion() {
  resetSessionStoreForTests();
  const store = getSessionStore();

  // Same key: strictly serialized.
  const order: string[] = [];
  const a = store.withLock("k", async () => {
    order.push("a:start");
    await sleep(25);
    order.push("a:end");
  });
  const b = store.withLock("k", async () => {
    order.push("b:start");
    await sleep(5);
    order.push("b:end");
  });
  await Promise.all([a, b]);
  assert.deepEqual(
    order,
    ["a:start", "a:end", "b:start", "b:end"],
    "same-key withLock must not interleave",
  );

  // Different keys: may overlap (both start before either ends).
  const seen: string[] = [];
  const x = store.withLock("x", async () => {
    seen.push("x:start");
    await sleep(20);
    seen.push("x:end");
  });
  const y = store.withLock("y", async () => {
    seen.push("y:start");
    await sleep(20);
    seen.push("y:end");
  });
  await Promise.all([x, y]);
  assert.ok(
    seen.indexOf("y:start") < seen.indexOf("x:end"),
    "different-key withLock should run concurrently",
  );

  // The lock releases even when the body throws.
  await assert.rejects(
    store.withLock("k", async () => {
      throw new Error("boom");
    }),
  );
  let ran = false;
  await store.withLock("k", async () => {
    ran = true;
  });
  assert.ok(ran, "lock must release after a throwing body");
}

async function main() {
  await testCrudRoundTrip();
  await testTouchPatchesAndPreserves();
  await testLockMutualExclusion();
  console.log(
    "kernel-session-store.test: OK — CRUD + touch + lock mutual exclusion",
  );
  process.exit(0);
}

void main();
