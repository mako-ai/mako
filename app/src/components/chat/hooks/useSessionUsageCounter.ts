/**
 * Advances a chat's cumulative usage by one delta per finished turn.
 *
 * Exposes a ref-held callback rather than a plain function, matching the
 * `*ImplRef` pattern the rest of Chat.tsx uses: `useChat`'s `onFinish` closure
 * is created once, so anything it calls must be reachable through a stable
 * reference.
 *
 * Replay safety: a resumed stream can re-deliver the same `finish` part. Each
 * counted turn is recorded under a key derived from the message id and its
 * exact token counts, so re-delivery is a no-op while a genuinely different
 * turn still counts.
 */

import { useRef, type MutableRefObject } from "react";
import { getResponseCostMetadata } from "../response-cost";
import { turnUsageKey, usageDeltaFromMetadata } from "../session-usage";
import { useChatUsageStore } from "../../../store/chatUsageStore";

interface UseSessionUsageCounterArgs {
  chatId: string;
  /** Fallback source for the finished message when the SDK omits it. */
  messagesRef: MutableRefObject<Array<{ id?: string; metadata?: unknown }>>;
}

export interface UseSessionUsageCounterResult {
  onTurnFinishedRef: MutableRefObject<
    (message?: { id?: string; metadata?: unknown }) => void
  >;
}

export function useSessionUsageCounter({
  chatId,
  messagesRef,
}: UseSessionUsageCounterArgs): UseSessionUsageCounterResult {
  const chatIdRef = useRef(chatId);
  const countedKeysRef = useRef<Set<string>>(new Set());

  // Assigned during render, NOT in an effect — the same deliberate pattern as
  // Chat.tsx's other refs. An effect would leave a window between the chatId
  // prop changing and the effect flushing, and a turn finishing inside that
  // window would be credited to the chat the user just navigated away from.
  // Switching chats also starts a fresh dedup ledger, so keys from the
  // previous chat cannot suppress a turn here.
  if (chatIdRef.current !== chatId) {
    chatIdRef.current = chatId;
    countedKeysRef.current = new Set();
  }

  const onTurnFinishedRef = useRef<
    (message?: { id?: string; metadata?: unknown }) => void
  >(() => {});

  onTurnFinishedRef.current = message => {
    const finished =
      message ??
      // The AI SDK does not guarantee the finished message in the callback
      // payload across versions; the last assistant message is the same turn.
      messagesRef.current[messagesRef.current.length - 1];
    if (!finished) return;

    const delta = usageDeltaFromMetadata(getResponseCostMetadata(finished));
    if (!delta) return;

    const key = turnUsageKey(finished.id, delta);
    if (countedKeysRef.current.has(key)) return;
    countedKeysRef.current.add(key);

    useChatUsageStore.getState().addTurnUsage(chatIdRef.current, delta);
  };

  return { onTurnFinishedRef };
}
