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
  __setRealtimeSubscriberForTest,
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

/** A scripted subscriber that records the calls it gets. */
function fakeSubscriber(opts: {
  failSubscribes?: number;
  unsubscribeMs?: number;
}) {
  const calls: string[] = [];
  const handlers = new Map<string, (message: string) => void>();
  let failures = opts.failSubscribes ?? 0;
  const sub: Subscriber = {
    connect: async () => undefined,
    subscribe: async (channel, callback) => {
      calls.push(`subscribe`);
      if (failures > 0) {
        failures--;
        throw new Error("redis over quota");
      }
      handlers.set(channel, callback);
    },
    unsubscribe: async channel => {
      calls.push(`unsubscribe:start`);
      if (opts.unsubscribeMs) await delay(opts.unsubscribeMs);
      handlers.delete(channel);
      calls.push(`unsubscribe:end`);
    },
  };
  const deliver = (event: RealtimeEvent) => {
    for (const handler of handlers.values()) handler(JSON.stringify(event));
  };
  return { sub, calls, handlers, deliver };
}

/**
 * A failed backend subscribe must not leave a dead registry entry: the next
 * subscriber retries the backend subscribe and receives events.
 */
async function testFailedSubscribeDoesNotPoisonRegistry() {
  const fake = fakeSubscriber({ failSubscribes: 1 });
  __setRealtimeSubscriberForTest(fake.sub);
  try {
    await assert.rejects(
      subscribeToWorkspaceEvents(WS_A, () => {}),
      /over quota/,
    );
    const received: RealtimeEvent[] = [];
    const dispose = await subscribeToWorkspaceEvents(WS_A, e =>
      received.push(e),
    );
    assert.deepEqual(fake.calls, ["subscribe", "subscribe"]);
    fake.deliver(consoleUpdated("c-retry", 1));
    assert.equal(received.length, 1, "second subscriber must be live");
    await dispose();
  } finally {
    __setRealtimeSubscriberForTest(null);
  }
}

/**
 * The last listener leaving while a new one arrives: the pending
 * unsubscribe must not remove the new subscription.
 */
async function testUnsubscribeRacingSubscribeIsSerialized() {
  const fake = fakeSubscriber({ unsubscribeMs: 20 });
  __setRealtimeSubscriberForTest(fake.sub);
  try {
    const first = await subscribeToWorkspaceEvents(WS_A, () => {});
    const disposing = first();
    const received: RealtimeEvent[] = [];
    const second = subscribeToWorkspaceEvents(WS_A, e => received.push(e));
    await Promise.all([disposing, second]);
    assert.deepEqual(fake.calls, [
      "subscribe",
      "unsubscribe:start",
      "unsubscribe:end",
      "subscribe",
    ]);
    fake.deliver(consoleUpdated("c-race", 1));
    assert.equal(received.length, 1, "new subscription must survive");
    await (
      await second
    )();
  } finally {
    __setRealtimeSubscriberForTest(null);
  }
}

async function main() {
  assert.equal(
    getPubSubBackendKind(),
    "memory",
    "test must run against the in-memory backend",
  );
  await testPublishReachesSubscriber();
  await testWorkspaceIsolation();
  await testRefCountedListeners();
  await testMalformedEventDropped();
  await testThrowingListenerIsolated();
  await testFailedSubscribeDoesNotPoisonRegistry();
  await testUnsubscribeRacingSubscribeIsSerialized();
  // eslint-disable-next-line no-console
  console.log("realtime.service.test.ts: all tests passed");
}

void main();
