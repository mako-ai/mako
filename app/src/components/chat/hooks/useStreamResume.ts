import { useEffect, useRef, type MutableRefObject } from "react";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { useRealtimeStore } from "../../../store/realtimeStore";
import {
  isHumanInTheLoopToolPartType,
  reportStreamInterruption,
  toolNameFromPartType,
  type ActiveClientToolCall,
} from "../tool-presentation";

type ChatHelpers = UseChatHelpers<UIMessage>;

export interface ErrorResumeState {
  count: number;
  windowStart: number;
  timer: ReturnType<typeof setTimeout> | null;
}

// Spacing/budget for onError → resume retries. A failed resume re-fires
// onError, so retrying instantly would burst; instead we schedule one delayed
// attempt (giving a brief network blip time to recover) and cap attempts per
// window before falling back to poisoning the tool cards.
const RESUME_RETRY_DELAY_MS = 1500;
const RESUME_RETRY_WINDOW_MS = 30_000;
const RESUME_MAX_RETRIES = 4;

export interface UseStreamResumeArgs {
  // Reactive values (drive the liveness effect).
  status: ChatHelpers["status"];
  messages: ChatHelpers["messages"];
  // Latest-value refs (assigned by Chat.tsx each render / after useChat).
  statusRef: MutableRefObject<ChatHelpers["status"]>;
  messagesRef: MutableRefObject<ChatHelpers["messages"]>;
  chatIdRef: MutableRefObject<string>;
  manualStopRequestedRef: MutableRefObject<boolean>;
  activeClientToolCallsRef: MutableRefObject<Map<string, ActiveClientToolCall>>;
  stopRef: MutableRefObject<ChatHelpers["stop"] | undefined>;
  resumeStreamRef: MutableRefObject<ChatHelpers["resumeStream"] | undefined>;
  loadPersistedMessagesRef: MutableRefObject<
    ((opts?: { forHistoryLoad?: boolean }) => Promise<boolean>) | undefined
  >;
  /**
   * Wired by this hook; declared in Chat.tsx because useChat's onError (built
   * before this hook runs) schedules retries through it.
   */
  requestResumeRef: MutableRefObject<
    ((opts?: { skipReload?: boolean }) => Promise<void>) | undefined
  >;
  /** onError's retry budget/timer — the wake effect's cleanup clears it. */
  errorResumeRef: MutableRefObject<ErrorResumeState>;
  /**
   * Wired by this hook; declared in Chat.tsx because useChat's onError —
   * captured once per Chat instance — delegates through it.
   */
  onStreamErrorImplRef: MutableRefObject<
    ((error: unknown) => void) | undefined
  >;
  /** Latest clearError (re-bound per Chat instance). */
  clearErrorRef: MutableRefObject<ChatHelpers["clearError"] | undefined>;
  setMessages: ChatHelpers["setMessages"];
  cancelActiveClientToolCalls: (reason: string) => void;
}

/**
 * Single-flight, liveness-gated stream resume manager + tab-wake reattach.
 *
 * The SDK's resumeStream() has no guard of its own: each call attaches a NEW
 * consumer to the resumable stream (replaying the segment buffer from
 * position 0) WITHOUT aborting the previous consumer — so concurrent triggers
 * (loadSession + wake burst + error retry) stacked N consumers on one turn,
 * and every consumer re-processed every chunk: client tools executed N times
 * and text/step-start parts were appended N times.
 */
export function useStreamResume({
  status,
  messages,
  statusRef,
  messagesRef,
  chatIdRef,
  manualStopRequestedRef,
  activeClientToolCallsRef,
  stopRef,
  resumeStreamRef,
  loadPersistedMessagesRef,
  requestResumeRef,
  errorResumeRef,
  onStreamErrorImplRef,
  clearErrorRef,
  setMessages,
  cancelActiveClientToolCalls,
}: UseStreamResumeArgs): void {
  // Stream liveness: the moment chunks last arrived. `messages` mutates on
  // every processed chunk while a consumer is attached, so a recent timestamp
  // while status reports an active stream means the consumer is healthy.
  const lastStreamActivityAtRef = useRef(0);
  useEffect(() => {
    if (status === "streaming" || status === "submitted") {
      lastStreamActivityAtRef.current = Date.now();
    }
  }, [messages, status]);

  // This wrapper makes a resume:
  //   1. a no-op while another resume is in flight or the attached consumer
  //      is demonstrably alive (chunk activity within the liveness window);
  //   2. tear down a stale consumer via stop() before reattaching;
  //   3. reset to the persisted turn snapshot before replaying (when safe),
  //      so the replay never appends onto parts this page already received.
  const resumeInFlightRef = useRef(false);
  requestResumeRef.current = async (opts?: {
    skipReload?: boolean;
  }): Promise<void> => {
    const STREAM_LIVENESS_WINDOW_MS = 10_000;
    if (resumeInFlightRef.current) return;
    if (manualStopRequestedRef.current) return;

    const currentStatus = statusRef.current;
    const consuming =
      currentStatus === "streaming" || currentStatus === "submitted";
    if (consuming) {
      // "submitted" = a POST is in flight and no chunk has arrived yet. That
      // is NOT staleness: thinking models routinely take >10s before the
      // first token, and a segment continuation (right after a client tool
      // settles) sits in this state too. Tearing it down here reloaded a
      // mid-segment persisted snapshot where the just-settled client tool was
      // still input-available — the history converter then poisoned it to
      // "Interrupted" and the turn's tail was lost. If the request is truly
      // dead (frozen tab), its fetch errors on wake and the onError retry
      // path resumes; never stale-kill a submitted request from here.
      if (currentStatus === "submitted") return;
      if (
        Date.now() - lastStreamActivityAtRef.current <
        STREAM_LIVENESS_WINDOW_MS
      ) {
        // A healthy consumer is attached and receiving chunks — resuming now
        // would add a SECOND consumer of the same stream.
        return;
      }
    }

    resumeInFlightRef.current = true;
    try {
      if (consuming) {
        // Stale consumer (status says streaming but no chunks for a while —
        // the socket is likely dead, or a long silent server-side tool is
        // running): abort it before attaching the replacement. Aborting a
        // healthy-but-quiet consumer is safe — the replay rebuilds the same
        // state and the dispatch gate blocks tool re-execution.
        await stopRef.current?.();
      }
      // Reset to the persisted turn snapshot before replaying when safe. The
      // replay clones the last in-memory assistant message and APPENDS every
      // replayed text/step-start part onto it — resuming on top of parts this
      // page already received is what duplicated message content. Skipped
      // while a client tool is mid-flight (the reload would tear its live
      // card down) and by loadSession (which just loaded).
      if (!opts?.skipReload && activeClientToolCallsRef.current.size === 0) {
        await loadPersistedMessagesRef.current?.();
      }
      if (manualStopRequestedRef.current) return;
      await resumeStreamRef.current?.();
    } finally {
      resumeInFlightRef.current = false;
    }
  };

  // Stream-error handler (useChat's onError delegates here). The turn's
  // lifetime is decoupled from the HTTP connection: the server keeps
  // generating and buffers a resumable stream after a client disconnect. A
  // mobile lock / computer sleep freezes the tab and the OS kills the SSE
  // socket; on wake the dead read surfaces here as a non-structured
  // network/stream error (the user-reported "network error" / "Stream
  // disconnected"). When the turn still looks live, reattach instead of
  // poisoning the cards — the replay re-emits the tool outputs, and any
  // in-flight client tool (e.g. a slow capture_screenshot) is left running so
  // it can settle on its own.
  onStreamErrorImplRef.current = (err: unknown): void => {
    console.error("[Chat] Error:", err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    const lastMessage = messagesRef.current.at(-1);
    const stalledToolNames =
      lastMessage?.role === "assistant"
        ? (lastMessage.parts ?? [])
            .filter(p => {
              const pt = p.type as string;
              if (!pt?.startsWith("tool-") && pt !== "dynamic-tool") {
                return false;
              }
              if (isHumanInTheLoopToolPartType(pt)) return false;
              const s = (p as Record<string, unknown>).state as string;
              return s !== "output-available" && s !== "error";
            })
            .map(p => toolNameFromPartType(p.type as string))
        : [];

    // Structured server errors (billing / model availability) arrive as JSON
    // with a `code` — those are genuine and must NOT be resumed.
    let isStructuredServerError = false;
    try {
      const parsed = JSON.parse(errorMessage);
      isStructuredServerError = !!parsed && typeof parsed.code === "string";
    } catch {
      /* not JSON → network / stream drop */
    }

    const turnLooksLive =
      statusRef.current === "streaming" ||
      statusRef.current === "submitted" ||
      useRealtimeStore.getState().chatActivity[chatIdRef.current] ===
        "streaming" ||
      document.visibilityState !== "visible" ||
      stalledToolNames.length > 0;

    const now = Date.now();
    const resumeState = errorResumeRef.current;
    if (now - resumeState.windowStart > RESUME_RETRY_WINDOW_MS) {
      resumeState.windowStart = now;
      resumeState.count = 0;
    }
    // Keep taking the resume branch while a retry is still scheduled, so we
    // never poison the cards out from under a pending reattach.
    const canRetryResume =
      resumeState.count < RESUME_MAX_RETRIES || resumeState.timer !== null;

    if (
      !isStructuredServerError &&
      turnLooksLive &&
      canRetryResume &&
      !manualStopRequestedRef.current
    ) {
      reportStreamInterruption({
        path: "stream-error",
        chatId: chatIdRef.current,
        status: statusRef.current,
        toolNames: stalledToolNames,
        errorMessage,
        resumed: true,
      });
      // Clear the SDK error so the hook can stream again, then reattach to
      // the buffered turn after a short delay. The delay coalesces the burst
      // of onError calls a failing reconnect produces and gives a brief
      // network blip time to recover. A finished turn answers 204 (cheap
      // no-op) and the orphan-rescue effect handles any stranded card.
      clearErrorRef.current?.();
      if (!resumeState.timer) {
        resumeState.count += 1;
        resumeState.timer = setTimeout(() => {
          resumeState.timer = null;
          void requestResumeRef.current?.();
        }, RESUME_RETRY_DELAY_MS);
      }
      return;
    }

    // Genuine / fatal error (or too many resume retries): fall back to the
    // original behavior — cancel in-flight client tools and poison pending
    // tool parts so the AI SDK unblocks the next sendMessage.
    cancelActiveClientToolCalls("stream-error");
    reportStreamInterruption({
      path: "stream-error",
      chatId: chatIdRef.current,
      status: statusRef.current,
      toolNames: stalledToolNames,
      errorMessage,
      resumed: false,
    });
    // When the stream disconnects (e.g. 524 timeout), tool calls may be
    // stuck in "input-available" state. The AI SDK blocks sendMessage until
    // all tool calls are settled. Patch them to "error" so the chat remains
    // usable.
    setMessages(prev =>
      prev.map(msg => {
        if (msg.role !== "assistant") return msg;
        const hasPending = msg.parts?.some(p => {
          const pt = p.type as string;
          if (!pt?.startsWith("tool-") && pt !== "dynamic-tool") return false;
          if (isHumanInTheLoopToolPartType(pt)) return false;
          const s = (p as Record<string, unknown>).state as string;
          return s !== "output-available" && s !== "error";
        });
        if (!hasPending) return msg;
        return {
          ...msg,
          parts: msg.parts.map(p => {
            const pt = p.type as string;
            if (!pt?.startsWith("tool-") && pt !== "dynamic-tool") return p;
            if (isHumanInTheLoopToolPartType(pt)) return p;
            const s = (p as Record<string, unknown>).state as string;
            if (s === "output-available" || s === "error") return p;
            return {
              ...p,
              state: "error" as const,
              output: { success: false, error: "Stream disconnected" },
            };
          }) as any,
        };
      }),
    );
  };

  // Reattach the chat stream when the tab wakes. A mobile lock / computer sleep
  // freezes the page and the OS silently kills the SSE socket; on wake the AI
  // SDK does not re-reconnect on its own, so an in-flight turn would otherwise
  // surface as a "stream error" (or strand a tool card). The server keeps
  // generating and buffers the turn as a resumable stream, so resumeStream()
  // replays the buffered + live chunks; a finished turn answers 204 (cheap
  // no-op). Mirrors realtimeStore.wake() (visibilitychange + focus + pageshow +
  // resume), throttled so a single wake burst fires the work once. Listeners
  // are installed once (stable closure over refs) and never re-installed.
  useEffect(() => {
    const WAKE_THROTTLE_MS = 2000;
    let lastWakeAt = 0;
    // Stable across the component's life (useRef object identity never changes);
    // captured for the cleanup to read the latest pending resume timer.
    const resumeState = errorResumeRef.current;

    const hasResumableTurn = (): boolean => {
      if (manualStopRequestedRef.current) return false;
      // A client tool executing locally is NOT a stranded turn: the segment's
      // stream already ended (dashboard/app tools dispatch fire-and-forget)
      // and the turn resumes via sendAutomaticallyWhen once the tool settles.
      // Reattaching here would replay the finished segment for nothing — and
      // long tools (a 2-3 min create_data_source materialization) kept this
      // window open for minutes, turning every tab switch into a replay.
      if (activeClientToolCallsRef.current.size > 0) return false;
      const s = statusRef.current;
      if (s === "streaming" || s === "submitted") return true;
      if (
        useRealtimeStore.getState().chatActivity[chatIdRef.current] ===
        "streaming"
      ) {
        return true;
      }
      // A tool card frozen mid-turn (non-terminal, non-HITL) means the turn was
      // interrupted while we were away — worth a reattach.
      const last = messagesRef.current.at(-1);
      if (!last || last.role !== "assistant") return false;
      return (last.parts ?? []).some(p => {
        const pt = p.type as string;
        if (!pt?.startsWith("tool-") && pt !== "dynamic-tool") return false;
        if (isHumanInTheLoopToolPartType(pt)) return false;
        const st = (p as Record<string, unknown>).state as string;
        return (
          st !== "output-available" && st !== "output-error" && st !== "error"
        );
      });
    };

    const wake = () => {
      const now = Date.now();
      // A window switch fires a burst (focus + visibilitychange); the first one
      // does the work.
      if (now - lastWakeAt < WAKE_THROTTLE_MS) return;
      lastWakeAt = now;
      if (!hasResumableTurn()) return;
      reportStreamInterruption({
        path: "wake-resume",
        chatId: chatIdRef.current,
        status: statusRef.current,
        toolNames: [],
        resumed: true,
      });
      void requestResumeRef.current?.();
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") wake();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", wake);
    window.addEventListener("pageshow", wake);
    // Page Lifecycle API: fired when the browser unfreezes a frozen tab.
    document.addEventListener("resume", wake);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", wake);
      window.removeEventListener("pageshow", wake);
      document.removeEventListener("resume", wake);
      if (resumeState.timer) {
        clearTimeout(resumeState.timer);
        resumeState.timer = null;
      }
    };
    // Deps are all stable ref objects — the listeners install exactly once.
  }, [
    activeClientToolCallsRef,
    chatIdRef,
    errorResumeRef,
    manualStopRequestedRef,
    messagesRef,
    requestResumeRef,
    statusRef,
  ]);
}
