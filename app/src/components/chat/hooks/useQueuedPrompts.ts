import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { FileUIPart, UIMessage } from "ai";
import { useConsoleStore } from "../../../store/consoleStore";
import type { ConsoleTab } from "../../../store/lib/types";
import { usePlanStore } from "../../../store/planStore";
import { generateObjectId } from "../../../utils/objectId";
import { trackEvent } from "../../../lib/analytics";
import {
  hasPendingAssistantToolCalls,
  type AutoSendPredicateArgs,
} from "../tool-presentation";
import type { QueuedPrompt } from "../QueuedPrompts";

type ChatHelpers = UseChatHelpers<UIMessage>;

export interface UseQueuedPromptsArgs {
  chatId: string;
  status: ChatHelpers["status"];
  isLoading: boolean;
  activeClientToolCallCount: number;
  isLoadingRef: MutableRefObject<boolean>;
  manualStopRequestedRef: MutableRefObject<boolean>;
  messagesRef: MutableRefObject<ChatHelpers["messages"]>;
  sendMessageRef: MutableRefObject<ChatHelpers["sendMessage"] | undefined>;
  modelIdRef: MutableRefObject<string | undefined>;
  capturedConsoleIdRef: MutableRefObject<string | null>;
  capturedDashboardIdRef: MutableRefObject<string | null>;
  activeConsoleIdRef: MutableRefObject<string | null>;
  pendingPlanToolCallIdRef: MutableRefObject<string | null>;
  /** One-shot latch consumed by the SDK's `sendAutomaticallyWhen` predicate.
   * Set right before resolving a plan with feedback so `addToolOutput` does
   * not auto-send — the feedback `sendMessage` below carries the resolved
   * tool output AND the user message in a single request. */
  suppressNextAutoSendRef: MutableRefObject<boolean>;
  autoSendWhenComplete: (options: AutoSendPredicateArgs) => boolean;
  interruptActiveTurn: () => void;
  /**
   * Declared in Chat.tsx (useChat's onFinish drains through it before this
   * hook runs); this hook assigns the implementation.
   */
  drainQueuedPromptAfterTurnRef: MutableRefObject<(() => void) | null>;
  /**
   * When the selected model is a local ACP provider (Claude Code / Codex),
   * Chat.tsx handles the turn. Return true if the send was claimed.
   */
  sendViaLocalAcpRef: MutableRefObject<
    ((text: string, files?: FileUIPart[]) => Promise<boolean>) | null
  >;
}

/**
 * Prompt queue (Cursor-style): prompts typed while the agent is busy queue up
 * and drain one at a time when the turn settles, with in-composer editing and
 * force-send (interrupt + send now).
 */
export function useQueuedPrompts({
  chatId,
  status,
  isLoading,
  activeClientToolCallCount,
  isLoadingRef,
  manualStopRequestedRef,
  messagesRef,
  sendMessageRef,
  modelIdRef,
  capturedConsoleIdRef,
  capturedDashboardIdRef,
  activeConsoleIdRef,
  pendingPlanToolCallIdRef,
  suppressNextAutoSendRef,
  autoSendWhenComplete,
  interruptActiveTurn,
  drainQueuedPromptAfterTurnRef,
  sendViaLocalAcpRef,
}: UseQueuedPromptsArgs) {
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const queuedPromptsRef = useRef(queuedPrompts);
  queuedPromptsRef.current = queuedPrompts;
  // Id of the queued prompt currently being edited in the composer (Cursor-style).
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const editingPromptIdRef = useRef<string | null>(null);
  editingPromptIdRef.current = editingPromptId;
  // Id of a prompt the user force-sent (top arrow). Once the interrupted turn
  // settles, the drain sends it immediately, bypassing the normal busy guards.
  const pendingForcePromptIdRef = useRef<string | null>(null);
  const editingPrompt = useMemo(
    () => queuedPrompts.find(prompt => prompt.id === editingPromptId) ?? null,
    [queuedPrompts, editingPromptId],
  );

  // When a turn ends on a completed client-side tool call (e.g. a data
  // binding), `lastAssistantMessageIsCompleteWithToolCalls` stays true and the
  // SDK *may* auto-continue the agent loop in a microtask after onFinish. We
  // must not drain into that gap, but we also must not stall forever when the
  // SDK is actually idle and won't resume (e.g. the tool settled while the
  // stream was still streaming, so the SDK's auto-continue condition was
  // missed). When that predicate is the *only* thing blocking the drain, defer
  // one macrotask and re-check: if the SDK resumed, `status` is now
  // submitted/streaming and the loading guard bails; if it stayed idle, force
  // the drain past the (now-stale) predicate so the queue can't hang.
  const drainRecheckScheduledRef = useRef(false);
  const forceDrainPastAutoContinueRef = useRef(false);

  // A submit_plan awaiting review is the one unanswered tool call the queue
  // can settle itself: the drained prompt resolves the plan as
  // request_changes feedback (carrying the current draft, so manual edits
  // made in the plan tab flow back) — the same conversational plan-iteration
  // path as typing in the composer while the plan is pending. The suppress
  // latch stops `addToolOutput`'s auto-send; the caller's `sendMessage`
  // ships the resolved tool output AND the user message in one request.
  // Returns false (and stays blocked) when no plan is pending or no live
  // resolver is registered yet.
  const resolvePendingPlanWithFeedback = (feedback: string): boolean => {
    const pendingPlanToolCallId = pendingPlanToolCallIdRef.current;
    if (!pendingPlanToolCallId) return false;
    const planStore = usePlanStore.getState();
    if (planStore.plans[pendingPlanToolCallId]?.status !== "pending") {
      return false;
    }
    suppressNextAutoSendRef.current = true;
    // The latch is consumed (one-shot) inside the SDK's sendAutomaticallyWhen
    // predicate, normally synchronously via the resolver → addToolOutput →
    // predicate chain.
    const resolved = planStore.resolvePlan(
      pendingPlanToolCallId,
      "request_changes",
      feedback.trim() || undefined,
    );
    if (!resolved) {
      // No live resolver — release the unconsumed latch and stay blocked.
      suppressNextAutoSendRef.current = false;
      return false;
    }
    trackEvent("ai_plan_feedback_sent", { model: modelIdRef.current });
    return true;
  };

  const tryDrainQueuedPromptRef = useRef<() => void>(() => {});
  tryDrainQueuedPromptRef.current = () => {
    // Force-send (top arrow): the user interrupted the running turn to push
    // this prompt now. Wait only until the aborted turn has fully settled
    // (no in-flight stream / unanswered tool calls), then send it past every
    // other guard — including the manual-stop flag the interrupt just set.
    const forcedId = pendingForcePromptIdRef.current;
    if (forcedId) {
      const forced = queuedPromptsRef.current.find(p => p.id === forcedId);
      if (!forced) {
        pendingForcePromptIdRef.current = null;
      } else {
        if (isLoadingRef.current) {
          return;
        }
        // A pending submit_plan is not a hard block: force-sending delivers
        // the prompt as plan feedback (request_changes), same as typing
        // while the plan awaits review.
        if (
          hasPendingAssistantToolCalls(messagesRef.current) &&
          !resolvePendingPlanWithFeedback(forced.text)
        ) {
          return;
        }
        pendingForcePromptIdRef.current = null;
        const remaining = queuedPromptsRef.current.filter(
          p => p.id !== forcedId,
        );
        queuedPromptsRef.current = remaining;
        isLoadingRef.current = true;
        setQueuedPrompts(remaining);
        capturedConsoleIdRef.current = forced.consoleId;
        capturedDashboardIdRef.current = forced.dashboardId;
        manualStopRequestedRef.current = false;
        trackEvent("ai_chat_message_sent", {
          model: modelIdRef.current,
          has_context: false,
          has_images: (forced.files?.length ?? 0) > 0,
        });
        sendMessageRef.current?.({ text: forced.text, files: forced.files });
        return;
      }
    }

    if (
      manualStopRequestedRef.current ||
      // Don't auto-fire the next queued prompt into a failed turn. The error
      // (e.g. usage_limit_exceeded) stays on screen; dismissing it via
      // clearError flips status back to "ready" and re-triggers this drain.
      status === "error" ||
      queuedPromptsRef.current.length === 0 ||
      // Don't drain the head item while the user is editing it in the composer.
      queuedPromptsRef.current[0]?.id === editingPromptIdRef.current
    ) {
      forceDrainPastAutoContinueRef.current = false;
      return;
    }

    // Hard block: the agent is genuinely mid-turn (streaming or running a
    // client tool). Sending now would race the loop.
    if (isLoadingRef.current) {
      forceDrainPastAutoContinueRef.current = false;
      return;
    }

    if (hasPendingAssistantToolCalls(messagesRef.current)) {
      // An unanswered tool call usually hard-blocks the drain (sending would
      // break the SDK's "all tool calls must be settled" invariant) — except
      // a submit_plan awaiting review, which the head prompt settles itself
      // as request_changes feedback. When the plan resolves, fall through to
      // the send below (skipping the soft block: the feedback message MUST
      // ship now to carry the resolved tool output back to the agent).
      if (!resolvePendingPlanWithFeedback(queuedPromptsRef.current[0].text)) {
        forceDrainPastAutoContinueRef.current = false;
        return;
      }
    } else if (
      // Soft block: the turn ended on completed tool calls and the SDK might
      // auto-continue in a microtask. Give it one macrotask before draining.
      autoSendWhenComplete({ messages: messagesRef.current }) &&
      !forceDrainPastAutoContinueRef.current
    ) {
      if (!drainRecheckScheduledRef.current) {
        drainRecheckScheduledRef.current = true;
        setTimeout(() => {
          drainRecheckScheduledRef.current = false;
          forceDrainPastAutoContinueRef.current = true;
          tryDrainQueuedPromptRef.current();
        }, 80);
      }
      return;
    }

    forceDrainPastAutoContinueRef.current = false;

    const [next, ...rest] = queuedPromptsRef.current;
    // Synchronously advance the queue and mark loading BEFORE sending so a
    // second drain trigger firing in the same tick (the [isLoading,status]
    // effect and the onFinish microtask can both run before React re-renders)
    // bails out at the guards above instead of re-sending the same prompt.
    queuedPromptsRef.current = rest;
    isLoadingRef.current = true;
    setQueuedPrompts(rest);
    capturedConsoleIdRef.current = next.consoleId;
    capturedDashboardIdRef.current = next.dashboardId;
    manualStopRequestedRef.current = false;
    trackEvent("ai_chat_message_sent", {
      model: modelIdRef.current,
      has_context: false,
      has_images: (next.files?.length ?? 0) > 0,
    });
    const localSend = sendViaLocalAcpRef.current;
    if (localSend) {
      void localSend(next.text, next.files).then(handled => {
        if (!handled) {
          sendMessageRef.current?.({ text: next.text, files: next.files });
        }
      });
      return;
    }
    sendMessageRef.current?.({ text: next.text, files: next.files });
  };
  drainQueuedPromptAfterTurnRef.current = () =>
    tryDrainQueuedPromptRef.current();

  const handleChatSubmit = useCallback(
    (text: string, files?: FileUIPart[]) => {
      // Committing an edit of a queued prompt: update the queue entry in place
      // instead of sending/queuing a new message.
      if (editingPromptIdRef.current) {
        const id = editingPromptIdRef.current;
        const trimmed = text.trim();
        setEditingPromptId(null);
        if (trimmed) {
          setQueuedPrompts(prev =>
            prev.map(prompt =>
              prompt.id === id ? { ...prompt, text: trimmed } : prompt,
            ),
          );
        }
        return;
      }

      // Conversational plan iteration (Cursor-style): while a submitted plan
      // is awaiting review, the typed message resolves the plan as
      // request_changes (carrying the current draft, so manual edits made in
      // the plan tab flow back) AND is sent as a real user message so the
      // feedback stays visible in the chat transcript. The suppress latch
      // stops `addToolOutput`'s auto-send; the `sendMessage` below ships the
      // resolved tool output and the feedback in one request.
      const pendingPlanToolCallId = pendingPlanToolCallIdRef.current;
      if (pendingPlanToolCallId) {
        const planStore = usePlanStore.getState();
        const planEntry = planStore.plans[pendingPlanToolCallId];
        const feedback = text.trim();
        if (planEntry?.status === "pending" && feedback) {
          suppressNextAutoSendRef.current = true;
          // The latch is consumed (one-shot) inside the SDK's
          // sendAutomaticallyWhen predicate, normally synchronously via the
          // resolver → addToolOutput → predicate chain.
          const resolved = planStore.resolvePlan(
            pendingPlanToolCallId,
            "request_changes",
            feedback,
          );
          if (resolved) {
            trackEvent("ai_plan_feedback_sent", { model: modelIdRef.current });
            capturedConsoleIdRef.current = activeConsoleIdRef.current;
            isLoadingRef.current = true;
            manualStopRequestedRef.current = false;
            sendMessageRef.current?.({ text: feedback, files });
            return;
          }
          // No live resolver (should not happen while the plan is pending in
          // the live messages) — release the unconsumed latch and fall
          // through to the normal send path so the user's message is never
          // silently swallowed.
          suppressNextAutoSendRef.current = false;
        }
      }

      capturedConsoleIdRef.current = activeConsoleIdRef.current;
      const store = useConsoleStore.getState();
      const currentTab = store.tabs[store.activeTabId || ""] as
        | (ConsoleTab & { metadata?: Record<string, unknown> })
        | undefined;
      const dashboardId =
        currentTab?.kind === "dashboard"
          ? ((currentTab.metadata?.dashboardId as string | undefined) ?? null)
          : null;
      capturedDashboardIdRef.current = dashboardId;
      const consoleId = capturedConsoleIdRef.current;

      if (isLoadingRef.current) {
        trackEvent("ai_chat_message_queued", {
          model: modelIdRef.current,
          has_images: (files?.length ?? 0) > 0,
        });
        setQueuedPrompts(prev => [
          ...prev,
          {
            id: generateObjectId(),
            text,
            files,
            consoleId,
            dashboardId,
          },
        ]);
        return;
      }

      manualStopRequestedRef.current = false;
      const activeConsole = store.tabs[store.activeTabId || ""];
      trackEvent("ai_chat_message_sent", {
        model: modelIdRef.current,
        has_context: !!activeConsole?.content,
        has_images: (files?.length ?? 0) > 0,
      });
      const localSend = sendViaLocalAcpRef.current;
      if (localSend) {
        isLoadingRef.current = true;
        void localSend(text, files).then(handled => {
          if (!handled) {
            sendMessageRef.current?.({ text, files });
          }
        });
        return;
      }
      sendMessageRef.current?.({ text, files });
    },
    [
      activeConsoleIdRef,
      capturedConsoleIdRef,
      capturedDashboardIdRef,
      isLoadingRef,
      manualStopRequestedRef,
      modelIdRef,
      pendingPlanToolCallIdRef,
      sendMessageRef,
      sendViaLocalAcpRef,
      suppressNextAutoSendRef,
    ],
  );

  useEffect(() => {
    tryDrainQueuedPromptRef.current();
  }, [isLoading, status, activeClientToolCallCount]);

  // Belt-and-suspenders: useChat `id` resets hook state on chatId change.
  useEffect(() => {
    setQueuedPrompts([]);
  }, [chatId]);

  const handleRemoveQueuedPrompt = useCallback((id: string) => {
    setQueuedPrompts(prev => prev.filter(prompt => prompt.id !== id));
  }, []);

  const handleStartEditQueuedPrompt = useCallback((id: string) => {
    setEditingPromptId(id);
  }, []);

  const handleCancelEditQueuedPrompt = useCallback(() => {
    setEditingPromptId(null);
  }, []);

  // If the edited prompt leaves the queue (drained, removed, or cleared), exit
  // edit mode so a stale id can't swallow the next real submit.
  useEffect(() => {
    if (
      editingPromptId &&
      !queuedPrompts.some(prompt => prompt.id === editingPromptId)
    ) {
      setEditingPromptId(null);
    }
  }, [queuedPrompts, editingPromptId]);

  // Force-send (top arrow): send this prompt right now. If the agent is still
  // running, interrupt the current turn first, then push it. If idle, just
  // send it immediately (ahead of any other queued items).
  const handleSendQueuedPromptNow = useCallback(
    (id: string) => {
      if (!queuedPromptsRef.current.some(p => p.id === id)) return;
      if (editingPromptIdRef.current === id) setEditingPromptId(null);

      // Move to the front for immediate visual feedback.
      setQueuedPrompts(prev => {
        const index = prev.findIndex(prompt => prompt.id === id);
        if (index <= 0) return prev;
        const next = [...prev];
        const [item] = next.splice(index, 1);
        next.unshift(item);
        return next;
      });

      pendingForcePromptIdRef.current = id;
      if (isLoadingRef.current) {
        interruptActiveTurn();
      }
      // Drain now if already idle; otherwise the status→ready transition from
      // the interrupt re-fires the drain effect, which sends the forced prompt.
      queueMicrotask(() => tryDrainQueuedPromptRef.current());
    },
    [interruptActiveTurn, isLoadingRef],
  );

  const clearQueuedPrompts = useCallback(() => {
    setQueuedPrompts([]);
  }, []);

  return {
    queuedPrompts,
    editingPromptId,
    editingPrompt,
    handleChatSubmit,
    handleRemoveQueuedPrompt,
    handleStartEditQueuedPrompt,
    handleCancelEditQueuedPrompt,
    handleSendQueuedPromptNow,
    clearQueuedPrompts,
  };
}
