import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { useConsoleStore } from "../../../store/consoleStore";
import { generateObjectId } from "../../../utils/objectId";
import { executeConsoleAgentTool } from "../../../agent-runtime/console-agent-tools";
import { executeDashboardAgentTool } from "../../../dashboard-runtime/agent-tools";
import { executeAppAgentTool } from "../../../app-runtime/agent-tools";
import { executeDbtAgentTool } from "../../../dbt-runtime/agent-tools";
import { executeDataSourceTool } from "../../../agent-runtime/data-source-tools";
import {
  DASHBOARD_EXECUTOR_TOOL_NAMES,
  APP_EXECUTOR_TOOL_NAMES,
  DBT_EXECUTOR_TOOL_NAMES,
  DATA_SOURCE_EXECUTOR_TOOL_NAMES,
  getAgentToolManifestEntry,
  type AgentToolName,
} from "../../../agent-runtime/client-tool-manifest";
import {
  isApprovalPendingState,
  isHumanInTheLoopToolPartType,
  reportStreamInterruption,
  toolNameFromPartType,
} from "../tool-presentation";
import type { DbFlowFormRef } from "../../DbFlowForm";
import type {
  ClientToolRegistry,
  AddToolOutputFn,
} from "./useClientToolRegistry";

type ChatHelpers = UseChatHelpers<UIMessage>;

/** The fields of the SDK's onToolCall payload the dispatcher reads. */
export interface DispatchableToolCall {
  toolCallId: string;
  toolName: string;
  input?: unknown;
  dynamic?: boolean;
}

export interface UseClientToolDispatchArgs {
  registry: Pick<
    ClientToolRegistry,
    | "activeClientToolCallsRef"
    | "toolDispatchGateRef"
    | "activeClientToolCallCount"
    | "registerActiveClientToolCall"
    | "settleActiveClientToolCall"
  >;
  addToolOutputRef: MutableRefObject<AddToolOutputFn | undefined>;
  manualStopRequestedRef: MutableRefObject<boolean>;
  workspaceIdRef: MutableRefObject<string | undefined>;
  onChartSpecChangeRef?: MutableRefObject<
    | ((payload: import("../../Editor").ChartSpecChangePayload) => void)
    | undefined
  >;
  dbFlowFormRefCurrent: MutableRefObject<
    RefObject<DbFlowFormRef | null> | undefined
  >;
  // Reactive values for the orphan-rescue effect.
  status: ChatHelpers["status"];
  messages: ChatHelpers["messages"];
  chatId: string;
  setMessages: ChatHelpers["setMessages"];
  /**
   * Refetch persisted messages (session loader's shared pipeline). The
   * orphan-rescue effect tries this FIRST for stuck tool parts: a pending
   * part is often just a lagging local copy of a tool that already settled
   * (mid-turn reload raced the per-segment persistence), and the server's
   * finalization holds the correct terminal state.
   */
  loadPersistedMessagesRef: MutableRefObject<
    ((opts?: { forHistoryLoad?: boolean }) => Promise<boolean>) | undefined
  >;
}

/**
 * Client-side tool dispatch: the `onToolCall` body (executor routing for
 * console/dashboard/app/dbt/data-source/flow tools), the orphan recovery
 * re-dispatch, and the orphan-rescue effect. All dispatch flows through the
 * registry's ToolDispatchGate so a replayed or re-delivered tool call can
 * never execute twice.
 */
export function useClientToolDispatch({
  registry,
  addToolOutputRef,
  manualStopRequestedRef,
  workspaceIdRef,
  onChartSpecChangeRef,
  dbFlowFormRefCurrent,
  status,
  messages,
  chatId,
  setMessages,
  loadPersistedMessagesRef,
}: UseClientToolDispatchArgs) {
  const {
    activeClientToolCallsRef,
    toolDispatchGateRef,
    activeClientToolCallCount,
    registerActiveClientToolCall,
    settleActiveClientToolCall,
  } = registry;

  const onToolCall = useCallback(
    async (toolCall: DispatchableToolCall): Promise<void> => {
      // Latest addToolOutput (assigned by Chat.tsx right after useChat).
      const addToolOutput: AddToolOutputFn = payload => {
        void addToolOutputRef.current?.(payload);
      };

      // Skip dynamic tools (not our console tools)
      if (toolCall.dynamic) {
        return;
      }

      const toolName = toolCall.toolName;
      const input = toolCall.input as Record<string, unknown>;

      // Deferred plan-lifecycle tools: do NOT settle here. The interactive
      // card rendered in the message list resolves them via addToolOutput once
      // the user answers / approves. Returning without output keeps the tool
      // call pending (human-in-the-loop) until then.
      if (
        toolName === "ask_clarifying_questions" ||
        toolName === "submit_plan"
      ) {
        return;
      }

      // Dedupe by toolCallId: resumable-stream replays (resumeStream after a
      // wake/refresh/error) and additional concurrent stream consumers
      // re-deliver `tool-input-available` chunks for calls this page already
      // dispatched. The tool PART merges by id so the transcript looks fine,
      // but re-dispatching re-runs the side effect — one create_dashboard call
      // must never create two dashboards.
      if (!toolDispatchGateRef.current.markDispatched(toolCall.toolCallId)) {
        return;
      }

      try {
        if (
          await executeConsoleAgentTool({
            toolCall: {
              toolName,
              toolCallId: toolCall.toolCallId,
            },
            input,
            workspaceId: workspaceIdRef.current,
            onChartSpecChange: onChartSpecChangeRef?.current,
            addToolOutput,
            registerActiveClientToolCall,
            settleActiveClientToolCall,
          })
        ) {
          return;
        }

        // --- Dashboard tools (client-side) ---
        if (DASHBOARD_EXECUTOR_TOOL_NAMES.has(toolName as AgentToolName)) {
          const activeDashboardTool = registerActiveClientToolCall(
            toolName,
            toolCall.toolCallId,
          );

          // Fire-and-forget for ALL dashboard client work, never await it here.
          // The AI SDK awaits onToolCall while reading the SSE stream, and only
          // sends the follow-up request with the tool output once the stream
          // reaches its finish chunk. Awaiting any client work inside
          // onToolCall blocks the reader from processing that finish chunk, so
          // the continuation hangs until the HTTP/proxy stream times out — even
          // for tools that resolve in milliseconds (e.g. remove_widget,
          // get_dashboard_state). Settling asynchronously lets the finish chunk
          // be read immediately and the stream close cleanly.
          void (async () => {
            try {
              const dashboardToolOutput = await executeDashboardAgentTool(
                toolName,
                input,
                {
                  executionId: activeDashboardTool.executionId,
                  signal: activeDashboardTool.abortController.signal,
                  // Server-side idempotency: another window attached to the
                  // same stream may execute this exact call too.
                  toolCallId: toolCall.toolCallId,
                },
              );

              if (activeDashboardTool.abortController.signal.aborted) {
                return;
              }

              void settleActiveClientToolCall(
                toolName,
                toolCall.toolCallId,
                dashboardToolOutput ?? {
                  success: false,
                  error: `Dashboard tool "${toolName}" did not return a result.`,
                },
              );
            } catch (dashboardError) {
              if (
                manualStopRequestedRef.current ||
                activeDashboardTool.abortController.signal.aborted
              ) {
                return;
              }
              void settleActiveClientToolCall(toolName, toolCall.toolCallId, {
                success: false,
                error:
                  dashboardError instanceof Error
                    ? dashboardError.message
                    : "Dashboard tool execution failed",
              });
            }
          })();
          return;
        }

        // --- React App tools (client-side) ---
        if (APP_EXECUTOR_TOOL_NAMES.has(toolName as AgentToolName)) {
          const activeAppTool = registerActiveClientToolCall(
            toolName,
            toolCall.toolCallId,
          );

          // Fire-and-forget, same rationale as dashboard tools above: never
          // await client work inside onToolCall or the SSE finish chunk stalls.
          void (async () => {
            try {
              const appToolOutput = await executeAppAgentTool(toolName, input, {
                executionId: activeAppTool.executionId,
                signal: activeAppTool.abortController.signal,
              });

              if (activeAppTool.abortController.signal.aborted) return;

              void settleActiveClientToolCall(
                toolName,
                toolCall.toolCallId,
                appToolOutput ?? {
                  success: false,
                  error: `App tool "${toolName}" did not return a result.`,
                },
              );
            } catch (appError) {
              if (
                manualStopRequestedRef.current ||
                activeAppTool.abortController.signal.aborted
              ) {
                return;
              }
              void settleActiveClientToolCall(toolName, toolCall.toolCallId, {
                success: false,
                error:
                  appError instanceof Error
                    ? appError.message
                    : "App tool execution failed",
              });
            }
          })();
          return;
        }

        // --- dbt tools (client-side) ---
        if (DBT_EXECUTOR_TOOL_NAMES.has(toolName as AgentToolName)) {
          const activeDbtTool = registerActiveClientToolCall(
            toolName,
            toolCall.toolCallId,
          );
          // Fire-and-forget, same rationale as app tools above.
          void (async () => {
            try {
              const dbtToolOutput = await executeDbtAgentTool(toolName, input);
              if (activeDbtTool.abortController.signal.aborted) return;
              void settleActiveClientToolCall(
                toolName,
                toolCall.toolCallId,
                dbtToolOutput ?? {
                  success: false,
                  error: `dbt tool "${toolName}" did not return a result.`,
                },
              );
            } catch (dbtError) {
              if (
                manualStopRequestedRef.current ||
                activeDbtTool.abortController.signal.aborted
              ) {
                return;
              }
              void settleActiveClientToolCall(toolName, toolCall.toolCallId, {
                success: false,
                error:
                  dbtError instanceof Error
                    ? dbtError.message
                    : "dbt tool execution failed",
              });
            }
          })();
          return;
        }

        // --- Shared data source tools (apps + dashboards) ---
        if (DATA_SOURCE_EXECUTOR_TOOL_NAMES.has(toolName as AgentToolName)) {
          const activeDataTool = registerActiveClientToolCall(
            toolName,
            toolCall.toolCallId,
          );
          void (async () => {
            try {
              const output = await executeDataSourceTool(toolName, input);
              if (activeDataTool.abortController.signal.aborted) return;
              void settleActiveClientToolCall(
                toolName,
                toolCall.toolCallId,
                output ?? {
                  success: false,
                  error: `Data source tool "${toolName}" did not return a result.`,
                },
              );
            } catch (dataError) {
              if (
                manualStopRequestedRef.current ||
                activeDataTool.abortController.signal.aborted
              ) {
                return;
              }
              void settleActiveClientToolCall(toolName, toolCall.toolCallId, {
                success: false,
                error:
                  dataError instanceof Error
                    ? dataError.message
                    : "Data source tool execution failed",
              });
            }
          })();
          return;
        }

        // Handle flow agent client-side tools
        // get_form_state - Return current form configuration
        if (toolName === "get_form_state") {
          const formRef = dbFlowFormRefCurrent.current?.current;
          if (!formRef) {
            addToolOutput({
              tool: "get_form_state",
              toolCallId: toolCall.toolCallId,
              output: {
                success: false,
                error:
                  "Form is not available. Make sure you're in the flow editor.",
              },
            });
            return;
          }

          const formState = formRef.getFormState();
          addToolOutput({
            tool: "get_form_state",
            toolCallId: toolCall.toolCallId,
            output: {
              success: true,
              formState,
            },
          });
          return;
        }

        // set_form_field - Update a single form field
        if (toolName === "set_form_field") {
          const formRef = dbFlowFormRefCurrent.current?.current;
          if (!formRef) {
            addToolOutput({
              tool: "set_form_field",
              toolCallId: toolCall.toolCallId,
              output: {
                success: false,
                error:
                  "Form is not available. Make sure you're in the flow editor.",
              },
            });
            return;
          }

          const { fieldName, value } = input as {
            fieldName: string;
            value: unknown;
          };

          // The tool schema uses a structured z.union() instead of z.any(),
          // so the LLM returns proper typed values (arrays as arrays, not strings).
          // See: TYPE_COERCION_SCHEMA in db-flow-form.schema.ts
          formRef.setField(fieldName, value);
          addToolOutput({
            tool: "set_form_field",
            toolCallId: toolCall.toolCallId,
            output: {
              success: true,
              fieldName,
              value,
              message: `Updated ${fieldName} successfully`,
            },
          });
          return;
        }

        // set_multiple_fields - Update multiple fields at once
        if (toolName === "set_multiple_fields") {
          const formRef = dbFlowFormRefCurrent.current?.current;
          if (!formRef) {
            addToolOutput({
              tool: "set_multiple_fields",
              toolCallId: toolCall.toolCallId,
              output: {
                success: false,
                error:
                  "Form is not available. Make sure you're in the flow editor.",
              },
            });
            return;
          }

          const { fields } = input as { fields: Record<string, unknown> };
          formRef.setMultipleFields(fields);
          addToolOutput({
            tool: "set_multiple_fields",
            toolCallId: toolCall.toolCallId,
            output: {
              success: true,
              fields: Object.keys(fields),
              message: `Updated ${Object.keys(fields).length} field(s) successfully`,
            },
          });
          return;
        }

        // NOTE: set_column_mappings has been removed
        // Use set_form_field with fieldName="typeCoercions" instead

        // create_flow_tab - Create a new db-scheduled flow tab
        if (toolName === "create_flow_tab") {
          const currentStore = useConsoleStore.getState();
          const title = (input.title as string) || "New Database Sync";

          // Generate a new ID and create the flow tab
          const newTabId = generateObjectId();
          currentStore.openTab({
            id: newTabId,
            title,
            content: "",
            kind: "flow-editor",
            metadata: { isNew: true, flowType: "db-scheduled" },
          });
          currentStore.setActiveTab(newTabId);

          addToolOutput({
            tool: "create_flow_tab",
            toolCallId: toolCall.toolCallId,
            output: {
              success: true,
              tabId: newTabId,
              title,
              message: `Created new flow tab "${title}"`,
            },
          });
          return;
        }

        // list_flow_tabs - List all open flow editor tabs
        if (toolName === "list_flow_tabs") {
          const currentStore = useConsoleStore.getState();
          const currentTabs = Object.values(currentStore.tabs);
          const currentActiveId = currentStore.activeTabId;

          const flowTabs = currentTabs
            .filter((tab: any) => tab?.kind === "flow-editor")
            .map((tab: any) => ({
              id: tab.id,
              title: tab.title || "Untitled Flow",
              flowType: tab.metadata?.flowType || "unknown",
              flowId: tab.metadata?.flowId,
              isNew: tab.metadata?.isNew || false,
              isActive: tab.id === currentActiveId,
            }));

          addToolOutput({
            tool: "list_flow_tabs",
            toolCallId: toolCall.toolCallId,
            output: {
              success: true,
              flowTabs,
              message: `Found ${flowTabs.length} open flow tab(s)`,
            },
          });
          return;
        }

        const manifestEntry = getAgentToolManifestEntry(toolName);
        if (manifestEntry?.execution === "client") {
          addToolOutput({
            tool: toolName,
            toolCallId: toolCall.toolCallId,
            output: {
              success: false,
              error: `Client-side tool "${toolName}" is registered but has no browser handler.`,
            },
          });
          return;
        }

        // Unknown tool - not a client-side tool, let it be handled server-side
      } catch (toolError) {
        // Safety net: if any client-side tool throws an uncaught error,
        // return the error to the LLM so the conversation doesn't hang.
        addToolOutput({
          tool: toolName,
          toolCallId: toolCall.toolCallId,
          output: {
            success: false,
            error:
              toolError instanceof Error
                ? toolError.message
                : "Client-side tool execution failed unexpectedly",
          },
        });
      }
    },
    [
      addToolOutputRef,
      manualStopRequestedRef,
      workspaceIdRef,
      onChartSpecChangeRef,
      dbFlowFormRefCurrent,
      toolDispatchGateRef,
      registerActiveClientToolCall,
      settleActiveClientToolCall,
    ],
  );

  // Self-heal a client tool call that the live stream delivered but never got
  // to dispatch (the SSE dropped, the SDK reconnected to a 204, and `status`
  // settled to "ready" with the tool frozen at "input-available"). Because a
  // completed run would be "output-available", a tool stuck at "input-available"
  // provably never executed — so we can safely re-dispatch it through the exact
  // same executor `onToolCall` would have used. Its result settles via
  // `addToolOutput`, and `sendAutomaticallyWhen` resumes the turn, recovering
  // transparently instead of poisoning the card with "Interrupted".
  //
  // Returns true if it took ownership of the call (recovering), false if the
  // tool is not a client-executable family we can safely re-run (those still
  // get the terminal error patch).
  const recoveredToolCallIdsRef = useRef<Set<string>>(new Set());
  const recoverOrphanedClientToolCall = useCallback(
    (
      toolName: string,
      toolCallId: string,
      input: Record<string, unknown>,
    ): boolean => {
      const name = toolName as AgentToolName;
      let run:
        | ((ctx: {
            executionId: string;
            signal: AbortSignal;
          }) => Promise<Record<string, unknown> | null | undefined>)
        | null = null;
      if (APP_EXECUTOR_TOOL_NAMES.has(name)) {
        run = ({ executionId, signal }) =>
          executeAppAgentTool(toolName, input, { executionId, signal });
      } else if (DASHBOARD_EXECUTOR_TOOL_NAMES.has(name)) {
        run = ({ executionId, signal }) =>
          executeDashboardAgentTool(toolName, input, {
            executionId,
            signal,
            toolCallId,
          });
      } else if (DBT_EXECUTOR_TOOL_NAMES.has(name)) {
        run = () => executeDbtAgentTool(toolName, input);
      } else if (DATA_SOURCE_EXECUTOR_TOOL_NAMES.has(name)) {
        run = () => executeDataSourceTool(toolName, input);
      }
      if (!run) return false;

      // Already recovering this exact call (effect re-ran before it settled):
      // keep ownership so it isn't poisoned, but don't dispatch twice.
      if (recoveredToolCallIdsRef.current.has(toolCallId)) return true;

      // A call this page instance already dispatched must NOT be re-run — its
      // side effects may have landed even though the part looks stuck. Decline
      // ownership so the poison path settles it instead.
      if (toolDispatchGateRef.current.wasDispatched(toolCallId)) return false;

      recoveredToolCallIdsRef.current.add(toolCallId);
      // Recovery IS a dispatch: claim the id so a later stream replay of the
      // same call can't run it a second time.
      toolDispatchGateRef.current.markDispatched(toolCallId);

      const active = registerActiveClientToolCall(toolName, toolCallId);
      void (async () => {
        try {
          const output = await run({
            executionId: active.executionId,
            signal: active.abortController.signal,
          });
          if (active.abortController.signal.aborted) return;
          await settleActiveClientToolCall(
            toolName,
            toolCallId,
            output ?? {
              success: false,
              error: `Recovered tool "${toolName}" did not return a result.`,
            },
          );
        } catch (recoverError) {
          if (
            manualStopRequestedRef.current ||
            active.abortController.signal.aborted
          ) {
            return;
          }
          await settleActiveClientToolCall(toolName, toolCallId, {
            success: false,
            error:
              recoverError instanceof Error
                ? recoverError.message
                : "Recovered tool execution failed",
          });
        } finally {
          recoveredToolCallIdsRef.current.delete(toolCallId);
        }
      })();
      return true;
    },
    [
      manualStopRequestedRef,
      toolDispatchGateRef,
      registerActiveClientToolCall,
      settleActiveClientToolCall,
    ],
  );

  // Rescue tool cards orphaned by a clean stream end.
  //
  // A tool card's "Running…" status is derived purely from the AI SDK tool
  // part `state` — it only resolves once a terminal `output-available` /
  // `output-error` chunk arrives. `onError` patches stuck parts when the
  // stream *throws* (e.g. a 524), and the history-load path rewrites them when
  // a chat is reopened. But with resumable streams a long server-side tool can
  // outlive the edge proxy's idle timeout: the SSE connection is closed, the
  // SDK silently reconnects, the reconnect returns 204 ("nothing streaming"),
  // and `status` settles back to "ready" without any error ever surfacing. The
  // live in-memory message then keeps a tool part frozen at "input-available"
  // → a permanent "Running…" card that also blocks the composer (the SDK won't
  // accept a new message until every tool call is settled).
  //
  // Once the turn has settled (`status === "ready"`) and no client-side tool is
  // still executing, any non-terminal tool part on the last assistant message
  // is orphaned. Patch it to an error so the card resolves and input unblocks.
  // Mirrors the `onError` rescue; uses `setMessages` (not `addToolOutput`) so
  // it does not feed back into `sendAutomaticallyWhen` and kick off a new turn.
  //
  // Server-reconcile first: a pending part is often just a LAGGING LOCAL COPY
  // of a tool that already settled (a mid-turn reload can load a per-segment
  // snapshot older than the settle), while the server's finalization holds the
  // correct terminal state. Refetch once per toolCallId before recovering /
  // poisoning; only parts still pending after the refetch are treated as
  // genuine orphans.
  const reconcileAttemptedToolCallIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    reconcileAttemptedToolCallIdsRef.current = new Set();
  }, [chatId]);
  const [rescueTick, setRescueTick] = useState(0);
  useEffect(() => {
    if (status !== "ready" || activeClientToolCallCount > 0) return;
    if (activeClientToolCallsRef.current.size > 0) return;
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") return;
    // Human-in-the-loop tools (clarifying questions / plan review) are *meant*
    // to sit at "input-available" with no output until the user answers via
    // their docked card — that is not an orphan. Patching them here would tear
    // the card down before it can be answered (it surfaces as "Interrupted —
    // stream disconnected"). Leave them pending.
    const pendingToolParts = (last.parts ?? []).filter(p => {
      const pt = p.type as string;
      if (!pt?.startsWith("tool-") && pt !== "dynamic-tool") return false;
      if (isHumanInTheLoopToolPartType(pt)) return false;
      const s = (p as Record<string, unknown>).state as string;
      // MCP approval flow: the turn intentionally pauses here.
      if (isApprovalPendingState(s)) return false;
      return s !== "output-available" && s !== "output-error" && s !== "error";
    });
    if (pendingToolParts.length === 0) return;

    const unreconciled = pendingToolParts.filter(p => {
      const id = (p as Record<string, unknown>).toolCallId;
      return (
        typeof id === "string" &&
        id &&
        !reconcileAttemptedToolCallIdsRef.current.has(id)
      );
    });
    if (unreconciled.length > 0) {
      for (const p of unreconciled) {
        reconcileAttemptedToolCallIdsRef.current.add(
          (p as Record<string, unknown>).toolCallId as string,
        );
      }
      void (async () => {
        const reloaded = await loadPersistedMessagesRef.current?.();
        // A successful reload replaces `messages` and re-runs this effect
        // (now past the reconcile step). When the reload was skipped (stale
        // snapshot / fetch failure), nothing re-triggers the effect — bump a
        // tick so the rescue below still runs for the genuine-orphan case.
        if (!reloaded) setRescueTick(t => t + 1);
      })();
      return;
    }

    // Try to self-heal first: re-dispatch any client-executable tool stuck at
    // "input-available". The IDs we recover keep their card alive (the
    // re-dispatch registers an active client tool call) and must NOT be
    // poisoned below.
    const recoveredCallIds = new Set<string>();
    const recoveredToolNames: string[] = [];
    const orphanedToolNames: string[] = [];
    for (const part of pendingToolParts) {
      const record = part as Record<string, unknown>;
      const pt = part.type as string;
      const toolName =
        pt === "dynamic-tool"
          ? ((record.toolName as string) ?? "")
          : toolNameFromPartType(pt);
      const toolCallId = record.toolCallId as string | undefined;
      const input = (record.input ?? {}) as Record<string, unknown>;
      if (
        record.state === "input-available" &&
        toolCallId &&
        recoverOrphanedClientToolCall(toolName, toolCallId, input)
      ) {
        recoveredCallIds.add(toolCallId);
        recoveredToolNames.push(toolName);
      } else {
        orphanedToolNames.push(toolName);
      }
    }

    reportStreamInterruption({
      path: "orphan-rescue",
      chatId,
      status,
      toolNames: orphanedToolNames,
      recoveredToolNames,
    });

    // Nothing left to poison — everything is being recovered.
    if (orphanedToolNames.length === 0) return;
    setMessages(prev => {
      const lastIndex = prev.length - 1;
      const lastMsg = prev[lastIndex];
      if (!lastMsg || lastMsg.role !== "assistant") return prev;
      return prev.map((msg, i) => {
        if (i !== lastIndex) return msg;
        return {
          ...msg,
          parts: msg.parts.map(p => {
            const record = p as Record<string, unknown>;
            const pt = p.type as string;
            if (!pt?.startsWith("tool-") && pt !== "dynamic-tool") return p;
            if (isHumanInTheLoopToolPartType(pt)) return p;
            // Leave parts we just handed to recovery untouched.
            if (recoveredCallIds.has(record.toolCallId as string)) return p;
            const s = record.state as string;
            if (
              s === "output-available" ||
              s === "output-error" ||
              s === "error" ||
              isApprovalPendingState(s)
            ) {
              return p;
            }
            return {
              ...p,
              state: "error" as const,
              output: {
                success: false,
                error:
                  "Interrupted — stream disconnected before tool completed",
              },
            };
          }) as any,
        };
      });
    });
  }, [
    status,
    activeClientToolCallCount,
    activeClientToolCallsRef,
    messages,
    chatId,
    recoverOrphanedClientToolCall,
    setMessages,
    loadPersistedMessagesRef,
    rescueTick,
  ]);

  return { onToolCall, recoverOrphanedClientToolCall };
}
