// @vitest-environment jsdom
/**
 * useQueuedPrompts — queued-prompt drain vs a pending submit_plan.
 *
 * Regression coverage for "queued message never sends after the agent builds
 * a plan": a turn that ends on an unresolved submit_plan (human-in-the-loop
 * review) left `hasPendingAssistantToolCalls` true forever, hard-blocking
 * both the auto-drain and the force-send (top arrow). The drain now settles
 * a pending plan itself by resolving it as request_changes with the queued
 * prompt as feedback — the same conversational plan-iteration path as typing
 * in the composer while the plan awaits review.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import type { UIMessage } from "ai";
import type { SubmitPlanOutput } from "@mako/agent-tools";

vi.mock("../../../store/consoleStore", () => ({
  useConsoleStore: { getState: () => ({ tabs: {}, activeTabId: null }) },
}));
vi.mock("../../../lib/analytics", () => ({ trackEvent: vi.fn() }));

import { usePlanStore } from "../../../store/planStore";
import {
  useQueuedPrompts,
  type UseQueuedPromptsArgs,
} from "./useQueuedPrompts";

const PLAN_TOOL_CALL_ID = "plan-tc-1";
const CHAT_ID = "chat-1";

const PLAN_INPUT = {
  title: "My plan",
  planMarkdown: "1. do things",
  todos: [{ content: "step one", status: "pending" as const }],
};

function assistantMessageWithTool(
  toolType: string,
  state: string,
  toolCallId = PLAN_TOOL_CALL_ID,
): UIMessage[] {
  return [
    {
      id: "m1",
      role: "assistant",
      parts: [{ type: toolType, state, toolCallId, input: PLAN_INPUT }],
    } as unknown as UIMessage,
  ];
}

function makeRef<T>(value: T): MutableRefObject<T> {
  return { current: value };
}

interface Harness {
  args: UseQueuedPromptsArgs;
  sendMessage: ReturnType<typeof vi.fn>;
  interruptActiveTurn: ReturnType<typeof vi.fn>;
}

function buildArgs(overrides: Partial<UseQueuedPromptsArgs> = {}): Harness {
  const sendMessage = vi.fn();
  const interruptActiveTurn = vi.fn();
  const args: UseQueuedPromptsArgs = {
    chatId: CHAT_ID,
    status: "ready",
    isLoading: false,
    activeClientToolCallCount: 0,
    isLoadingRef: makeRef(false),
    manualStopRequestedRef: makeRef(false),
    messagesRef: makeRef<UIMessage[]>([]),
    sendMessageRef: makeRef(
      sendMessage,
    ) as unknown as UseQueuedPromptsArgs["sendMessageRef"],
    modelIdRef: makeRef<string | undefined>("model-x"),
    capturedConsoleIdRef: makeRef<string | null>(null),
    capturedDashboardIdRef: makeRef<string | null>(null),
    activeConsoleIdRef: makeRef<string | null>(null),
    pendingPlanToolCallIdRef: makeRef<string | null>(null),
    suppressNextAutoSendRef: makeRef(false),
    autoSendWhenComplete: () => false,
    interruptActiveTurn,
    drainQueuedPromptAfterTurnRef: makeRef<(() => void) | null>(null),
    ...overrides,
  };
  return { args, sendMessage, interruptActiveTurn };
}

/** Queue a prompt through the real submit path (isLoading forces queueing). */
function queuePrompt(
  harness: Harness,
  result: { current: ReturnType<typeof useQueuedPrompts> },
  text: string,
) {
  const wasLoading = harness.args.isLoadingRef.current;
  harness.args.isLoadingRef.current = true;
  act(() => {
    result.current.handleChatSubmit(text);
  });
  harness.args.isLoadingRef.current = wasLoading;
}

/** Register a pending plan (with resolver) and point the ref at it. */
function registerPendingPlan(harness: Harness) {
  const resolver = vi.fn<(output: SubmitPlanOutput) => void>();
  usePlanStore.getState().registerPlan(PLAN_TOOL_CALL_ID, CHAT_ID, PLAN_INPUT);
  usePlanStore.getState().registerResolver(PLAN_TOOL_CALL_ID, resolver);
  harness.args.pendingPlanToolCallIdRef.current = PLAN_TOOL_CALL_ID;
  harness.args.messagesRef.current = assistantMessageWithTool(
    "tool-submit_plan",
    "input-available",
  );
  return resolver;
}

beforeEach(() => {
  usePlanStore.setState({ plans: {} });
});

describe("useQueuedPrompts × pending submit_plan", () => {
  it("auto-drains a queued prompt as request_changes plan feedback", () => {
    const harness = buildArgs();
    const { result } = renderHook(() => useQueuedPrompts(harness.args));

    queuePrompt(harness, result, "also include churn by region");
    expect(result.current.queuedPrompts).toHaveLength(1);

    const resolver = registerPendingPlan(harness);

    // The onFinish drain (post-turn) fires with the plan awaiting review.
    act(() => {
      harness.args.drainQueuedPromptAfterTurnRef.current?.();
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    const output = resolver.mock.calls[0][0];
    expect(output.decision).toBe("request_changes");
    expect(output.feedback).toBe("also include churn by region");
    expect(output.editedPlan?.title).toBe("My plan");
    // Latch set so addToolOutput's auto-send is suppressed (consumed by the
    // SDK predicate in the real flow).
    expect(harness.args.suppressNextAutoSendRef.current).toBe(true);
    expect(harness.sendMessage).toHaveBeenCalledWith({
      text: "also include churn by region",
      files: undefined,
    });
    expect(result.current.queuedPrompts).toHaveLength(0);
    expect(usePlanStore.getState().plans[PLAN_TOOL_CALL_ID]?.status).toBe(
      "request_changes",
    );
  });

  it("force-send (top arrow) resolves the pending plan and sends now", async () => {
    const harness = buildArgs();
    const { result } = renderHook(() => useQueuedPrompts(harness.args));

    queuePrompt(harness, result, "first queued");
    queuePrompt(harness, result, "use monthly granularity instead");
    const forced = result.current.queuedPrompts[1];

    const resolver = registerPendingPlan(harness);

    // Idle (plan awaiting review) — force-send must not need an interrupt.
    await act(async () => {
      result.current.handleSendQueuedPromptNow(forced.id);
    });

    expect(harness.interruptActiveTurn).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0][0].feedback).toBe(
      "use monthly granularity instead",
    );
    expect(harness.sendMessage).toHaveBeenCalledWith({
      text: "use monthly granularity instead",
      files: undefined,
    });
    // The other prompt stays queued.
    expect(result.current.queuedPrompts.map(p => p.text)).toEqual([
      "first queued",
    ]);
  });

  it("stays blocked on a non-plan unanswered tool call", () => {
    const harness = buildArgs();
    const { result } = renderHook(() => useQueuedPrompts(harness.args));

    queuePrompt(harness, result, "queued text");
    harness.args.messagesRef.current = assistantMessageWithTool(
      "tool-run_query",
      "input-available",
      "other-tc",
    );

    act(() => {
      harness.args.drainQueuedPromptAfterTurnRef.current?.();
    });

    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(result.current.queuedPrompts).toHaveLength(1);
    expect(harness.args.suppressNextAutoSendRef.current).toBe(false);
  });

  it("stays blocked (latch released) when the plan has no live resolver", () => {
    const harness = buildArgs();
    const { result } = renderHook(() => useQueuedPrompts(harness.args));

    queuePrompt(harness, result, "queued text");
    // Plan registered as pending, but no resolver (e.g. pre-rehydration).
    usePlanStore
      .getState()
      .registerPlan(PLAN_TOOL_CALL_ID, CHAT_ID, PLAN_INPUT);
    harness.args.pendingPlanToolCallIdRef.current = PLAN_TOOL_CALL_ID;
    harness.args.messagesRef.current = assistantMessageWithTool(
      "tool-submit_plan",
      "input-available",
    );

    act(() => {
      harness.args.drainQueuedPromptAfterTurnRef.current?.();
    });

    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(result.current.queuedPrompts).toHaveLength(1);
    expect(harness.args.suppressNextAutoSendRef.current).toBe(false);
  });

  it("drains normally when no tool calls are pending", () => {
    const harness = buildArgs();
    const { result } = renderHook(() => useQueuedPrompts(harness.args));

    queuePrompt(harness, result, "plain queued prompt");

    act(() => {
      harness.args.drainQueuedPromptAfterTurnRef.current?.();
    });

    expect(harness.sendMessage).toHaveBeenCalledWith({
      text: "plain queued prompt",
      files: undefined,
    });
    expect(result.current.queuedPrompts).toHaveLength(0);
  });
});
