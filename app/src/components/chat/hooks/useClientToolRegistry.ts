import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { generateObjectId } from "../../../utils/objectId";
import { ToolDispatchGate } from "../tool-dispatch-gate";
import type { ActiveClientToolCall } from "../tool-presentation";

/** Matches useChat's addToolOutput for the fields the registry uses. */
export type AddToolOutputFn = (payload: {
  tool: string;
  toolCallId: string;
  output: Record<string, unknown>;
}) => void | PromiseLike<void>;

export interface UseClientToolRegistryArgs {
  /**
   * Latest useChat addToolOutput. A ref because the registry is created
   * BEFORE useChat (its register/settle callbacks are captured by the
   * onToolCall config); Chat.tsx assigns `.current` right after useChat.
   */
  addToolOutputRef: MutableRefObject<AddToolOutputFn | undefined>;
  manualStopRequestedRef: MutableRefObject<boolean>;
  /** Active chat — the dispatch gate resets when it changes. */
  chatId: string;
}

/**
 * Tracks client-side tool executions in flight (abort/cancel plumbing +
 * "is anything running" count) and owns the per-chat dispatch dedupe gate.
 */
export function useClientToolRegistry({
  addToolOutputRef,
  manualStopRequestedRef,
  chatId,
}: UseClientToolRegistryArgs) {
  const activeClientToolCallsRef = useRef(
    new Map<string, ActiveClientToolCall>(),
  );
  const cancelledClientToolCallIdsRef = useRef(new Set<string>());
  // Dispatch dedupe by toolCallId (see ToolDispatchGate). Resumable-stream
  // replays and concurrent stream consumers re-deliver `tool-input-available`
  // chunks for calls this page already dispatched — without this gate a single
  // create_dashboard call executed once per consumer (the triplicate-dashboard
  // incident). Reset on chat switch; the session loader seeds it from raw
  // history.
  const toolDispatchGateRef = useRef(new ToolDispatchGate());
  useEffect(() => {
    toolDispatchGateRef.current.reset();
  }, [chatId]);

  const [activeClientToolCallCount, setActiveClientToolCallCount] = useState(0);

  const createCancellationOutput = useCallback(
    (toolName: string): Record<string, unknown> => ({
      success: false,
      error:
        toolName === "run_console"
          ? "Query cancelled because the chat stopped."
          : "Tool cancelled because the chat stopped.",
    }),
    [],
  );

  const registerActiveClientToolCall = useCallback(
    (
      toolName: string,
      toolCallId: string,
      options?: {
        executionId?: string;
        cancel?: () => void | Promise<void>;
        cancellationOutput?: Record<string, unknown>;
      },
    ) => {
      const abortController = new AbortController();
      const executionId =
        options?.executionId ?? `chat-tool-${generateObjectId()}`;

      cancelledClientToolCallIdsRef.current.delete(toolCallId);
      activeClientToolCallsRef.current.set(toolCallId, {
        toolCallId,
        toolName,
        executionId,
        abortController,
        cancel: options?.cancel ?? (() => {}),
        cancellationOutput:
          options?.cancellationOutput ?? createCancellationOutput(toolName),
        settled: false,
      });
      setActiveClientToolCallCount(activeClientToolCallsRef.current.size);

      return { abortController, executionId };
    },
    [createCancellationOutput],
  );

  const settleActiveClientToolCall = useCallback(
    async (
      toolName: string,
      toolCallId: string,
      output: Record<string, unknown>,
    ): Promise<void> => {
      if (cancelledClientToolCallIdsRef.current.delete(toolCallId)) {
        return;
      }

      const activeToolCall = activeClientToolCallsRef.current.get(toolCallId);
      if (!activeToolCall) {
        if (!manualStopRequestedRef.current) {
          await addToolOutputRef.current?.({
            tool: toolName,
            toolCallId,
            output,
          });
        }
        return;
      }

      try {
        if (!activeToolCall.settled) {
          activeToolCall.settled = true;
          await addToolOutputRef.current?.({
            tool: activeToolCall.toolName,
            toolCallId,
            output,
          });
        }
      } finally {
        activeClientToolCallsRef.current.delete(toolCallId);
        setActiveClientToolCallCount(activeClientToolCallsRef.current.size);
      }
    },
    [addToolOutputRef, manualStopRequestedRef],
  );

  const cancelActiveClientToolCalls = useCallback((reason: string): void => {
    for (const activeToolCall of activeClientToolCallsRef.current.values()) {
      cancelledClientToolCallIdsRef.current.add(activeToolCall.toolCallId);
      activeToolCall.abortController.abort(reason);
      activeToolCall.settled = true;
      void Promise.resolve(activeToolCall.cancel()).catch(() => undefined);
    }

    activeClientToolCallsRef.current.clear();
    setActiveClientToolCallCount(0);
  }, []);

  /**
   * Interrupt path (manual stop / force-send): abort every in-flight client
   * tool AND settle it with its cancellation output so the SDK's "all tool
   * calls answered" invariant holds for the next sendMessage.
   */
  const interruptActiveClientToolCalls = useCallback((): void => {
    for (const activeToolCall of activeClientToolCallsRef.current.values()) {
      cancelledClientToolCallIdsRef.current.add(activeToolCall.toolCallId);
      activeToolCall.abortController.abort("chat-stop");
      void Promise.resolve(activeToolCall.cancel()).catch(() => undefined);

      if (!activeToolCall.settled) {
        activeToolCall.settled = true;
        void addToolOutputRef.current?.({
          tool: activeToolCall.toolName,
          toolCallId: activeToolCall.toolCallId,
          output: activeToolCall.cancellationOutput,
        });
      }
    }

    activeClientToolCallsRef.current.clear();
    setActiveClientToolCallCount(0);
  }, [addToolOutputRef]);

  return {
    activeClientToolCallsRef,
    cancelledClientToolCallIdsRef,
    toolDispatchGateRef,
    activeClientToolCallCount,
    registerActiveClientToolCall,
    settleActiveClientToolCall,
    cancelActiveClientToolCalls,
    interruptActiveClientToolCalls,
  };
}

export type ClientToolRegistry = ReturnType<typeof useClientToolRegistry>;
