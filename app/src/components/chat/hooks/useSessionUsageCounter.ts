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
import { api } from "../../../api/client";

/**
 * How long to wait after a turn settles before reconciling against the server.
 * Long enough for the final `saveChat` to land, short enough that the figure
 * is right before the user reads it.
 */
const RECONCILE_DELAY_MS = 1200;

interface UseSessionUsageCounterArgs {
  chatId: string;
  workspaceId: string | undefined;
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
  workspaceId,
  messagesRef,
}: UseSessionUsageCounterArgs): UseSessionUsageCounterResult {
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const reconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const onTurnFinishedImpl = (message?: {
    id?: string;
    metadata?: unknown;
  }) => {
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

  // The optimistic delta above only covers segments whose `finish` part
  // actually reached this browser. An agentic turn is several segments, and
  // measured on the preview a tool-using turn showed 25.0k live against 76.8k
  // persisted — the figure only became right on reload. So after the turn
  // settles, reconcile against the authoritative per-chat aggregate and
  // REPLACE. Cheap: ~2KB and ~70ms, once per turn, never per chunk.
  onTurnFinishedRef.current = (message => {
    const applyOptimistic = onTurnFinishedImpl;
    applyOptimistic(message);

    if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
    const targetChatId = chatIdRef.current;
    const targetWorkspaceId = workspaceIdRef.current;
    if (!targetChatId || !targetWorkspaceId) return;

    reconcileTimerRef.current = setTimeout(() => {
      void (async () => {
        try {
          const { data } = await api.GET(
            "/api/workspaces/{workspaceId}/usage/by-chat/{chatId}",
            {
              params: {
                path: { workspaceId: targetWorkspaceId, chatId: targetChatId },
              },
            },
          );
          const totals = data?.totals;
          if (!totals) return;
          // The user may have switched chats while this was in flight.
          if (chatIdRef.current !== targetChatId) return;
          useChatUsageStore.getState().seedSessionUsage(targetChatId, {
            inputTokens: totals.inputTokens ?? 0,
            outputTokens: totals.outputTokens ?? 0,
            cacheReadTokens: totals.cacheReadTokens ?? 0,
            cacheWriteTokens: totals.cacheWriteTokens ?? 0,
            reasoningTokens: totals.reasoningTokens ?? 0,
            costUsd: totals.costUsd ?? 0,
            hasCost: (totals.costUsd ?? 0) > 0,
          });
        } catch {
          // Best effort: the optimistic figure stands and the next chat load
          // reseeds from the server anyway.
        }
      })();
    }, RECONCILE_DELAY_MS);
  }) as typeof onTurnFinishedRef.current;

  return { onTurnFinishedRef };
}
