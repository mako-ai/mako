import { loggers } from "../logging";

const logger = loggers.agent();

/**
 * Per-chat finalization queue.
 *
 * The AI SDK keeps the UI message stream open until the `onFinish` callback of
 * `toUIMessageStreamResponse` resolves (it is awaited inside the stream's
 * `flush()`). On the client, `useChat` only fires the tool-result auto-resume
 * once that stream closes. So any slow work in `onFinish` (gateway pricing
 * lookups, `saveChat`, etc.) is serialized *into the user-perceived latency* of
 * every client-side tool round-trip — the assistant appears frozen even though
 * the tool itself (e.g. an instant `modify_console` patch) resolved in
 * milliseconds, and a stuck round-trip only unblocks when the held-open stream
 * hits its proxy/HTTP timeout.
 *
 * To keep tool round-trips snappy we run finalization in the background instead
 * of blocking stream close. We still serialize finalizations per chat so that
 * the full-thread `$set` writes in `saveChat` always apply in step order (the
 * blocking behavior previously guaranteed this for free).
 *
 * This regression has been re-introduced multiple times (PR #424, PR #440) by
 * awaiting finalization inline again. `scheduleChatFinalization` MUST stay
 * non-blocking — see `chat-finalization-queue.test.ts`.
 */
const chatFinalizationChains = new Map<string, Promise<void>>();

/**
 * Schedule post-stream finalization work for a chat WITHOUT blocking the caller.
 *
 * Returns synchronously (`void`). This is load-bearing: callers run inside the
 * stream's `onFinish`, and awaiting here would stall every client-tool
 * round-trip until the held-open stream times out. Keep it fire-and-forget.
 */
export function scheduleChatFinalization(
  chatId: string,
  task: () => Promise<void>,
): void {
  const previous = chatFinalizationChains.get(chatId) ?? Promise.resolve();
  const next = previous
    // Isolate this task from a prior task's failure so the chain keeps running.
    .catch(() => {})
    .then(task)
    .catch(err =>
      logger.error("Chat finalization failed", { chatId, error: err }),
    );

  chatFinalizationChains.set(chatId, next);

  // Drop the map entry once this task is the tail and has settled, to avoid
  // leaking one promise per chat for the lifetime of the process.
  void next.finally(() => {
    if (chatFinalizationChains.get(chatId) === next) {
      chatFinalizationChains.delete(chatId);
    }
  });
}

/**
 * Resolves when the currently-queued finalization work for `chatId` has
 * settled. Intended for tests; resolves immediately if nothing is queued.
 */
export function awaitChatFinalization(chatId: string): Promise<void> {
  return chatFinalizationChains.get(chatId) ?? Promise.resolve();
}

/**
 * Number of chats with in-flight finalization chains. Intended for tests to
 * assert the map does not leak entries after work settles.
 */
export function getChatFinalizationChainCount(): number {
  return chatFinalizationChains.size;
}
