import assert from "node:assert/strict";
import {
  scheduleChatFinalization,
  awaitChatFinalization,
  getChatFinalizationChainCount,
} from "./chat-finalization-queue";

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * The load-bearing guarantee: scheduling finalization must NOT block the
 * caller. The route schedules this inside `toUIMessageStreamResponse.onFinish`,
 * and the AI SDK awaits that callback before closing the stream. Awaiting the
 * task inline (the PR #424 / PR #440 regression) stalls every client-tool
 * round-trip until the held-open stream times out.
 */
async function testReturnsBeforeTaskCompletes() {
  let taskCompleted = false;
  scheduleChatFinalization("chat-sync", async () => {
    await delay(20);
    taskCompleted = true;
  });

  // If scheduling awaited the task, this would already be true.
  assert.equal(
    taskCompleted,
    false,
    "scheduleChatFinalization must return before the task runs to completion",
  );

  await awaitChatFinalization("chat-sync");
  assert.equal(taskCompleted, true, "task should eventually complete");
}

/** Per-chat tasks run in submission order even when the first is slower. */
async function testSerializesPerChatInOrder() {
  const order: number[] = [];
  scheduleChatFinalization("chat-order", async () => {
    await delay(25);
    order.push(1);
  });
  scheduleChatFinalization("chat-order", async () => {
    await delay(1);
    order.push(2);
  });

  await awaitChatFinalization("chat-order");
  assert.deepEqual(
    order,
    [1, 2],
    "finalizations for one chat must apply in step order",
  );
}

/** A failing task is isolated: it neither rejects to the caller nor breaks the chain. */
async function testFailureIsolation() {
  const ran: string[] = [];

  assert.doesNotThrow(() => {
    scheduleChatFinalization("chat-fail", async () => {
      throw new Error("boom");
    });
  }, "a throwing task must not reject synchronously to the caller");

  scheduleChatFinalization("chat-fail", async () => {
    ran.push("after-failure");
  });

  await awaitChatFinalization("chat-fail");
  assert.deepEqual(
    ran,
    ["after-failure"],
    "a failed task must not prevent the next task from running",
  );
}

/** The chain map must not leak an entry per chat after work settles. */
async function testNoMapLeakAfterSettle() {
  scheduleChatFinalization("chat-leak", async () => {
    await delay(1);
  });
  await awaitChatFinalization("chat-leak");
  // Allow the cleanup `finally` microtask to run.
  await delay(0);

  assert.equal(
    getChatFinalizationChainCount(),
    0,
    "settled chats must be dropped from the finalization map",
  );
}

async function main() {
  await testReturnsBeforeTaskCompletes();
  await testSerializesPerChatInOrder();
  await testFailureIsolation();
  await testNoMapLeakAfterSettle();
}

void main();
