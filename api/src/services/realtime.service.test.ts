/**
 * Self-running test for the workspace realtime channel (in-memory backend).
 * Run with: pnpm --filter api exec tsx src/services/realtime.service.test.ts
 *
 * REDIS_URL must be unset so the shared pub/sub backend uses the in-process
 * implementation (asserted below).
 */
import assert from "node:assert/strict";

delete process.env.REDIS_URL;

import {
  publishRealtimeEvent,
  subscribeToWorkspaceEvents,
  type RealtimeEvent,
} from "./realtime.service";
import { getPubSubBackendKind, createPubSubPublisher } from "./pubsub.service";

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const WS_A = "65f000000000000000000aaa";
const WS_B = "65f000000000000000000bbb";

function consoleUpdated(consoleId: string, draftRevision: number) {
  return {
    type: "console.updated",
    consoleId,
    draftRevision,
    updatedBy: "user-1",
    origin: "draft",
  } satisfies RealtimeEvent;
}

/** Publish must reach a subscriber on the same workspace channel. */
async function testPublishReachesSubscriber() {
  const received: RealtimeEvent[] = [];
  const dispose = await subscribeToWorkspaceEvents(WS_A, e => received.push(e));

  publishRealtimeEvent(WS_A, consoleUpdated("c1", 2));
  await delay(10);

  assert.equal(received.length, 1, "subscriber must receive published event");
  assert.deepEqual(received[0], consoleUpdated("c1", 2));
  await dispose();
}

/** Workspaces are isolated channels. */
async function testWorkspaceIsolation() {
  const receivedA: RealtimeEvent[] = [];
  const receivedB: RealtimeEvent[] = [];
  const disposeA = await subscribeToWorkspaceEvents(WS_A, e =>
    receivedA.push(e),
  );
  const disposeB = await subscribeToWorkspaceEvents(WS_B, e =>
    receivedB.push(e),
  );

  publishRealtimeEvent(WS_A, consoleUpdated("c2", 3));
  await delay(10);

  assert.equal(receivedA.length, 1, "workspace A must receive its event");
  assert.equal(
    receivedB.length,
    0,
    "workspace B must not receive workspace A's event",
  );
  await disposeA();
  await disposeB();
}

/** User-targeted events are filtered before callbacks, including anonymous subscribers. */
async function testUserTargetedFiltering() {
  const receivedUser1: RealtimeEvent[] = [];
  const receivedUser2: RealtimeEvent[] = [];
  const receivedUser3: RealtimeEvent[] = [];
  const receivedUnscoped: RealtimeEvent[] = [];
  const disposeUser1 = await subscribeToWorkspaceEvents(
    WS_A,
    event => receivedUser1.push(event),
    { userId: "user-1" },
  );
  const disposeUser2 = await subscribeToWorkspaceEvents(
    WS_A,
    event => receivedUser2.push(event),
    { userId: "user-2" },
  );
  const disposeUser3 = await subscribeToWorkspaceEvents(
    WS_A,
    event => receivedUser3.push(event),
    { userId: "user-3" },
  );
  const disposeUnscoped = await subscribeToWorkspaceEvents(WS_A, event =>
    receivedUnscoped.push(event),
  );

  publishRealtimeEvent(WS_A, {
    type: "dbt.checkout.updated",
    projectId: "project-1",
    branch: "main",
    forUserId: "user-1",
    updatedBy: "user-1",
  });
  await delay(10);

  assert.equal(receivedUser1.length, 1);
  assert.equal(receivedUser2.length, 0);
  assert.equal(receivedUnscoped.length, 0);

  publishRealtimeEvent(WS_A, {
    type: "app-v2.project.updated",
    projectId: "workspace-project",
  });
  publishRealtimeEvent(WS_A, {
    type: "app-v2.commit.created",
    projectId: "private-project",
    worktreeId: "worktree-2",
    sha: "a".repeat(40),
    forUserIds: ["user-2", "user-3"],
  });
  await delay(10);

  assert.equal(receivedUser1.length, 2, "workspace event broadcasts");
  assert.equal(receivedUser2.length, 2, "owner receives private commit");
  assert.equal(receivedUser3.length, 2, "collaborator receives private commit");
  assert.equal(receivedUnscoped.length, 1, "unscoped sees only broadcast");
  await disposeUser1();
  await disposeUser2();
  await disposeUser3();
  await disposeUnscoped();
}

/** Multiple listeners on one workspace all receive events; disposal is per-listener. */
async function testRefCountedListeners() {
  const received1: RealtimeEvent[] = [];
  const received2: RealtimeEvent[] = [];
  const dispose1 = await subscribeToWorkspaceEvents(WS_A, e =>
    received1.push(e),
  );
  const dispose2 = await subscribeToWorkspaceEvents(WS_A, e =>
    received2.push(e),
  );

  publishRealtimeEvent(WS_A, consoleUpdated("c3", 1));
  await delay(10);
  assert.equal(received1.length, 1);
  assert.equal(received2.length, 1);

  await dispose1();
  publishRealtimeEvent(WS_A, consoleUpdated("c3", 2));
  await delay(10);
  assert.equal(received1.length, 1, "disposed listener must stop receiving");
  assert.equal(received2.length, 2, "remaining listener keeps receiving");

  // Disposing twice must be a no-op.
  await dispose1();
  await dispose2();

  publishRealtimeEvent(WS_A, consoleUpdated("c3", 3));
  await delay(10);
  assert.equal(received2.length, 2, "all listeners disposed — no delivery");
}

/** Malformed JSON on the channel is dropped without breaking the listener. */
async function testMalformedEventDropped() {
  const received: RealtimeEvent[] = [];
  const dispose = await subscribeToWorkspaceEvents(WS_A, e => received.push(e));

  // Publish raw garbage straight through the backend.
  await createPubSubPublisher().publish(
    `mako:realtime:ws:${WS_A}`,
    "{not json",
  );
  await createPubSubPublisher().publish(`mako:realtime:ws:${WS_A}`, "null");
  publishRealtimeEvent(WS_A, consoleUpdated("c4", 9));
  await delay(10);

  assert.equal(
    received.length,
    1,
    "malformed event must be dropped; valid events still delivered",
  );
  assert.deepEqual(received[0], consoleUpdated("c4", 9));
  await dispose();
}

/** A throwing listener must not prevent other listeners from being called. */
async function testThrowingListenerIsolated() {
  const received: RealtimeEvent[] = [];
  const disposeThrowing = await subscribeToWorkspaceEvents(WS_A, () => {
    throw new Error("listener boom");
  });
  const disposeOk = await subscribeToWorkspaceEvents(WS_A, e =>
    received.push(e),
  );

  publishRealtimeEvent(WS_A, consoleUpdated("c5", 1));
  await delay(10);

  assert.equal(
    received.length,
    1,
    "a throwing listener must not block other listeners",
  );
  await disposeThrowing();
  await disposeOk();
}

async function main() {
  assert.equal(
    getPubSubBackendKind(),
    "memory",
    "test must run against the in-memory backend",
  );
  await testPublishReachesSubscriber();
  await testWorkspaceIsolation();
  await testUserTargetedFiltering();
  await testRefCountedListeners();
  await testMalformedEventDropped();
  await testThrowingListenerIsolated();
  // eslint-disable-next-line no-console
  console.log("realtime.service.test.ts: all tests passed");
}

void main();
