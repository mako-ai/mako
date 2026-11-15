import { useCallback, useState } from "react";
import {
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";
import { safeStringify } from "../../../lib/json-safe";
import type {
  AutoSendPredicateArgs,
  ToolInvocationInfo,
} from "../tool-presentation";
import { serializeChatHistory } from "../chat-helpers";

/**
 * When useChat may auto-continue a turn. `autoSendWhenComplete` (settled
 * client tool calls / MCP approval responses, unless the user stopped) is
 * also the queued-prompt drain's soft-block mirror; `sdkAutoSendWhen` is the
 * predicate handed to useChat and alone consumes the one-shot plan-feedback
 * latch.
 */
export function useAutoSendPredicates(
  manualStopRequestedRef: React.MutableRefObject<boolean>,
  suppressNextAutoSendRef: React.MutableRefObject<boolean>,
) {
  const autoSendWhenComplete = useCallback(
    (options: AutoSendPredicateArgs) => {
      if (manualStopRequestedRef.current) {
        return false;
      }
      // Approval responses (MCP allow/deny) resume the turn just like settled
      // client tool calls do.
      return (
        lastAssistantMessageIsCompleteWithToolCalls(options) ||
        lastAssistantMessageIsCompleteWithApprovalResponses(options)
      );
    },
    [manualStopRequestedRef],
  );

  const sdkAutoSendWhen = useCallback(
    (options: AutoSendPredicateArgs) => {
      if (suppressNextAutoSendRef.current) {
        suppressNextAutoSendRef.current = false;
        return false;
      }
      return autoSendWhenComplete(options);
    },
    [autoSendWhenComplete, suppressNextAutoSendRef],
  );

  return { autoSendWhenComplete, sdkAutoSendWhen };
}

/** The tool debug dialog: which tool card was clicked. */
export function useToolDetailsDialog() {
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState<ToolInvocationInfo | null>(null);
  const openTool = useCallback((next: ToolInvocationInfo) => {
    setTool(next);
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    setTool(null);
  }, []);
  return { open, tool, openTool, close };
}

/** "Copy chat history as JSON", with a 2s copied state. */
export function useCopyChatHistory(onError: (message: string) => void) {
  const [copied, setCopied] = useState(false);
  const copy = async (messages: UIMessage[]) => {
    const history = serializeChatHistory(messages);
    try {
      await navigator.clipboard.writeText(safeStringify(history, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be unavailable (insecure context, denied permission).
      // Silently doing nothing looks like a broken button.
      onError("Could not copy the chat history to the clipboard.");
    }
  };
  return { copied, copy };
}
