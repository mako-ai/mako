import { useCallback, useEffect, useMemo, useRef } from "react";
import type { UIMessage } from "ai";
import type { SubmitPlanInput } from "@mako/agent-tools";
import { completeDesktopHitlJob } from "../../../lib/desktop-acp-bridge";
import { useDesktopHitlStore } from "../../../store/desktopHitlStore";
import {
  focusPlanTab,
  syncPlanTabTitle,
  usePlanStore,
  type PartialSubmitPlanInput,
} from "../../../store/planStore";
import {
  findPendingInteractiveTool,
  type PendingInteractiveTool,
} from "../chat-helpers";

export type ResolveInteractiveTool = (args: {
  tool: string;
  toolCallId: string;
  output: Record<string, unknown>;
  viaAcpBridge?: boolean;
}) => void;

type AddToolOutput = (payload: {
  tool: string;
  toolCallId: string;
  output: Record<string, unknown>;
}) => unknown;

/**
 * Pending submit_plan: register the plan + its resolver in planStore and
 * auto-open the main-view plan tab (once per toolCallId, as soon as
 * streaming starts). While the input streams, each delta only does a cheap
 * store write (setStreamingInput) — no tab re-open, no resolver churn. The
 * resolver re-registers whenever `resolve` changes so it always settles the
 * tool through the live useChat instance.
 */
function usePendingPlanSync(
  pending: PendingInteractiveTool | null,
  chatId: string,
  resolve: ResolveInteractiveTool,
) {
  const autoOpenedPlanTabsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!pending || pending.toolName !== "submit_plan") {
      return;
    }
    const { toolCallId, streaming } = pending;
    if (!toolCallId) return;

    const planStore = usePlanStore.getState();
    if (streaming) {
      planStore.setStreamingInput(
        toolCallId,
        chatId,
        pending.input as PartialSubmitPlanInput | undefined,
      );
    } else {
      const input = pending.input as SubmitPlanInput;
      planStore.registerPlan(toolCallId, chatId, input);
      planStore.registerResolver(toolCallId, output => {
        resolve({
          tool: "submit_plan",
          toolCallId,
          output: output as unknown as Record<string, unknown>,
          viaAcpBridge: pending.viaAcpBridge,
        });
      });
    }

    const title = usePlanStore.getState().plans[toolCallId]?.draft.title;
    if (!autoOpenedPlanTabsRef.current.has(toolCallId)) {
      autoOpenedPlanTabsRef.current.add(toolCallId);
      focusPlanTab(toolCallId, chatId, title || "Plan");
    } else if (title) {
      // Keep the tab title in sync as the title streams in / finalizes
      // (no-op unless it actually changed).
      syncPlanTabTitle(toolCallId, chatId, title);
    }
  }, [pending, chatId, resolve]);
}

/**
 * The deferred interactive tool call (clarifying questions / plan) awaiting
 * the user, if any — from the last assistant message, or parked on the Local
 * Agent's desktop bridge (mako-desktop HITL while Claude's MCP call waits).
 * Rendered as a docked panel above the composer (Cursor-style) rather than
 * inline in the chat; the inline summary only appears once resolved.
 */
export function usePendingInteractiveTool({
  messages,
  chatId,
  addToolOutput,
  pendingPlanToolCallIdRef,
}: {
  messages: UIMessage[];
  chatId: string;
  addToolOutput: AddToolOutput;
  pendingPlanToolCallIdRef: React.MutableRefObject<string | null>;
}) {
  const desktopHitlPending = useDesktopHitlStore(s => s.pending);

  // Resolve a deferred interactive tool (clarifying questions / plan) with the
  // user's answer. Stable identity so the docked card doesn't remount.
  const resolve = useCallback<ResolveInteractiveTool>(
    args => {
      if (args.viaAcpBridge) {
        void completeDesktopHitlJob(args.toolCallId, args.output);
        return;
      }
      void addToolOutput({
        tool: args.tool,
        toolCallId: args.toolCallId,
        output: args.output,
      });
    },
    [addToolOutput],
  );

  const pending = useMemo<PendingInteractiveTool | null>(
    () =>
      desktopHitlPending
        ? {
            toolName: desktopHitlPending.toolName,
            toolCallId: desktopHitlPending.jobId,
            input: desktopHitlPending.input,
            streaming: false,
            viaAcpBridge: true,
          }
        : findPendingInteractiveTool(messages.at(-1)),
    [messages, desktopHitlPending],
  );

  // While a submit_plan awaits review (input fully available, unresolved),
  // the chat composer becomes the plan-iteration channel: a sent message is
  // routed to the tool output as request_changes feedback instead of a normal
  // user message. The ref (declared above useChat) keeps handleChatSubmit's
  // identity stable (perf rules).
  const isPlanAwaitingFeedback =
    pending?.toolName === "submit_plan" && !pending.streaming;
  pendingPlanToolCallIdRef.current = isPlanAwaitingFeedback
    ? pending.toolCallId
    : null;

  usePendingPlanSync(pending, chatId, resolve);

  return {
    pendingInteractiveTool: pending,
    handleResolveInteractiveTool: resolve,
    isPlanAwaitingFeedback,
  };
}
