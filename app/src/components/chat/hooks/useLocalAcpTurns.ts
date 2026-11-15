import { useCallback, useEffect, useRef, useState } from "react";
import type { FileUIPart, UIMessage } from "ai";
import { useAcpStore } from "../../../store/acpStore";
import {
  isLocalAcpModelId,
  localAcpModelIdToProviderId,
} from "../../../lib/local-acp-models";
import { runLocalAcpChatTurn } from "../../../lib/local-acp-chat";
import { resumeLocalAcpChatTurn } from "../../../lib/resume-local-acp-chat";
import { clearLocalAcpChatBinding } from "../../../lib/persist-local-acp-chat";

export interface LocalAcpBinding {
  providerId: string;
  sessionId: string;
  modelId: string;
}

interface UseLocalAcpTurnsArgs {
  chatId: string;
  selectedModelId: string | undefined;
  workspaceIdRef: React.MutableRefObject<string | undefined>;
  chatIdRef: React.MutableRefObject<string>;
  modelIdRef: React.MutableRefObject<string | undefined>;
  messagesRef: React.MutableRefObject<UIMessage[]>;
  isLoadingRef: React.MutableRefObject<boolean>;
  drainQueuedPromptAfterTurnRef: React.MutableRefObject<(() => void) | null>;
  fetchSessionsRef: React.MutableRefObject<(() => unknown) | undefined>;
  setMessages: (
    updater: UIMessage[] | ((prev: UIMessage[]) => UIMessage[]),
  ) => void;
  setIsExistingChat: (value: boolean) => void;
}

/**
 * Main Chat → Local Agent (Claude Code / Codex over ACP) when the model
 * picker selects a local model: the send path, the refresh / History-reopen /
 * tab-wake reattach to a still-running turn, and the session binding that
 * lets consecutive turns reuse one ACP process session.
 */
export function useLocalAcpTurns({
  chatId,
  selectedModelId,
  workspaceIdRef,
  chatIdRef,
  modelIdRef,
  messagesRef,
  isLoadingRef,
  drainQueuedPromptAfterTurnRef,
  fetchSessionsRef,
  setMessages,
  setIsExistingChat,
}: UseLocalAcpTurnsArgs) {
  const sendViaLocalAcpRef = useRef<
    ((text: string, files?: FileUIPart[]) => Promise<boolean>) | null
  >(null);
  const localAcpAbortRef = useRef<AbortController | null>(null);
  const localAcpBindingRef = useRef<LocalAcpBinding | null>(null);
  /** Bumps on each ACP send so overlapping finally blocks don't clear busy early. */
  const localAcpGenerationRef = useRef(0);
  /** In-flight refresh/wake reattach to a Local Agent turn (see resume below). */
  const localAcpResumeAbortRef = useRef<AbortController | null>(null);
  const requestLocalAcpResumeRef = useRef<(() => void) | undefined>(undefined);
  const [localAcpBusy, setLocalAcpBusy] = useState(false);
  const localAcpBusyRef = useRef(false);
  localAcpBusyRef.current = localAcpBusy;

  // Leaving local Claude/Codex must drop the persisted ACP binding so History
  // reopen doesn't force a dead session (Bugbot: stale localAcp).
  useEffect(() => {
    if (isLocalAcpModelId(selectedModelId)) return;
    if (!localAcpBindingRef.current) return;
    const workspaceId = workspaceIdRef.current;
    const id = chatIdRef.current;
    const transcript = messagesRef.current;
    localAcpBindingRef.current = null;
    if (!workspaceId || !id || transcript.length === 0) return;
    void clearLocalAcpChatBinding({
      workspaceId,
      chatId: id,
      messages: transcript,
    });
    // Only a model switch matters; the refs carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModelId]);

  /** Abort an in-flight local turn and any reattach (Stop / interrupt). */
  const abortLocalAcp = useCallback(() => {
    localAcpAbortRef.current?.abort();
    localAcpAbortRef.current = null;
    localAcpResumeAbortRef.current?.abort();
    localAcpResumeAbortRef.current = null;
    setLocalAcpBusy(false);
    void useAcpStore
      .getState()
      .cancelActive()
      .catch(() => undefined);
  }, []);

  const finishTurn = () => {
    setLocalAcpBusy(false);
    isLoadingRef.current = false;
    queueMicrotask(() => drainQueuedPromptAfterTurnRef.current?.());
  };

  // Generation counter: overlapping send/abort must not clear busy while an
  // older turn is still awaiting the Local Agent (that race poisoned Skill
  // cards as "Interrupted" and surfaced "Session is already processing").
  sendViaLocalAcpRef.current = async (text: string, files?: FileUIPart[]) => {
    const modelId = modelIdRef.current;
    if (!modelId || !isLocalAcpModelId(modelId)) return false;

    localAcpAbortRef.current?.abort();
    // A refresh-reattach must yield to a fresh user send (it would otherwise
    // race this turn's assistant bubble with replayed events).
    localAcpResumeAbortRef.current?.abort();
    localAcpResumeAbortRef.current = null;
    // Cancel the in-flight ACP prompt so the next turn can start cleanly.
    void useAcpStore
      .getState()
      .cancelActive()
      .catch(() => undefined);

    const abort = new AbortController();
    localAcpAbortRef.current = abort;
    const generation = ++localAcpGenerationRef.current;
    setLocalAcpBusy(true);
    isLoadingRef.current = true;
    try {
      const binding = localAcpBindingRef.current;
      const providerId = localAcpModelIdToProviderId(modelId);
      // Reuse the ACP process session across Terra/Luna/Sol picks for the same
      // provider. Exact modelId equality used to drop the binding on every
      // picker change, which forced set_config / reconnect mid-chat and made
      // the user's turn look like it disappeared ("Conversation interrupted").
      await runLocalAcpChatTurn({
        modelId,
        text,
        files,
        workspaceId: workspaceIdRef.current,
        chatId: chatIdRef.current,
        preferredSessionId:
          binding && providerId && binding.providerId === providerId
            ? binding.sessionId
            : undefined,
        setMessages,
        signal: abort.signal,
        onPersisted: binding => {
          if (binding) localAcpBindingRef.current = binding;
          setIsExistingChat(true);
          void fetchSessionsRef.current?.();
        },
      });
    } catch {
      // Transcript already includes the error text.
    } finally {
      if (localAcpGenerationRef.current === generation) {
        if (localAcpAbortRef.current === abort) {
          localAcpAbortRef.current = null;
        }
        finishTurn();
      }
    }
    return true;
  };

  // Refresh / History-reopen / tab-wake reattach for Local ACP: the Local
  // Agent keeps running the turn (and buffering events for replay) while the
  // page is gone, but nothing re-subscribed — the chat froze at the last
  // checkpoint. Rebuild the in-flight turn from the replay backlog, stream
  // the rest live, and persist the finished turn. Cheap no-op when idle.
  requestLocalAcpResumeRef.current = () => {
    const binding = localAcpBindingRef.current;
    const workspaceId = workspaceIdRef.current;
    const targetChatId = chatIdRef.current;
    if (!binding || !workspaceId || !targetChatId) return;
    // An in-page turn (or an already-attached resume) is streaming — leave it.
    if (localAcpBusyRef.current) return;
    localAcpResumeAbortRef.current?.abort();
    const abort = new AbortController();
    localAcpResumeAbortRef.current = abort;
    let attached = false;
    void resumeLocalAcpChatTurn({
      binding,
      workspaceId,
      chatId: targetChatId,
      setMessages,
      getMessages: () => messagesRef.current,
      signal: abort.signal,
      onLiveAttach: () => {
        if (abort.signal.aborted) return;
        attached = true;
        // Ref first: the state flush lags, and the wake handler must not
        // start a second resume in that window.
        localAcpBusyRef.current = true;
        setLocalAcpBusy(true);
        isLoadingRef.current = true;
      },
      onPersisted: b => {
        if (b) localAcpBindingRef.current = b;
        setIsExistingChat(true);
        void fetchSessionsRef.current?.();
      },
    })
      .catch(() => undefined)
      .finally(() => {
        if (localAcpResumeAbortRef.current === abort) {
          localAcpResumeAbortRef.current = null;
        }
        // Clear busy only if no in-page send took over after aborting us.
        if (attached && !localAcpAbortRef.current) {
          localAcpBusyRef.current = false;
          finishTurn();
        }
      });
  };

  // Drop a stale reattach when the user switches chats (the loader kicks off
  // a fresh one for the next chat if its binding warrants it) or unmounts.
  useEffect(() => {
    return () => {
      localAcpResumeAbortRef.current?.abort();
      localAcpResumeAbortRef.current = null;
    };
  }, [chatId]);

  // Tab wake / network back: if the resume (or its SSE) died while the
  // machine slept, reattach to a still-running local ACP turn. No-ops fast
  // when there is no binding or a turn is already streaming in-page.
  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState !== "visible") return;
      requestLocalAcpResumeRef.current?.();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
    };
  }, []);

  return {
    localAcpBusy,
    localAcpBusyRef,
    localAcpBindingRef,
    sendViaLocalAcpRef,
    requestLocalAcpResumeRef,
    abortLocalAcp,
  };
}
