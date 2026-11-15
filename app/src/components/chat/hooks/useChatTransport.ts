import { useMemo } from "react";
import { DefaultChatTransport } from "ai";
import { useConsoleStore } from "../../../store/consoleStore";
import type { ConsoleTab } from "../../../store/lib/types";
import { selectActiveExplorer, useUIStore } from "../../../store/uiStore";
import { toJsonSafe } from "../../../lib/json-safe";
import {
  buildChatRequestBody,
  type ActiveConsoleResultsContext,
} from "../../../agent-runtime/request-context";
import { consumePendingScreenshotVisionAttachments } from "../../../agent-runtime/screenshot-agent-tools";
import type { DbFlowFormRef } from "../../DbFlowForm";
import type { ConsoleResultsContext } from "../../Editor";

type ChatActiveView = "flow-editor" | "console" | "empty";

function normalizeChatActiveView(kind: ConsoleTab["kind"]): ChatActiveView {
  return kind === "flow-editor" || kind === "console" ? kind : "empty";
}

interface UseChatTransportArgs {
  workspaceIdRef: React.MutableRefObject<string | undefined>;
  modelIdRef: React.MutableRefObject<string | undefined>;
  chatIdRef: React.MutableRefObject<string>;
  activeConsoleIdRef: React.MutableRefObject<string | null>;
  dbFlowFormRefCurrent: React.MutableRefObject<
    React.RefObject<DbFlowFormRef | null> | undefined
  >;
  resultsContextRef?: React.MutableRefObject<ConsoleResultsContext | null>;
}

/**
 * The chat transport, created once — prepareSendMessagesRequest reads all
 * dynamic values from getState() / refs at request time, so the transport
 * identity is stable for the lifetime of the component.
 */
export function useChatTransport({
  workspaceIdRef,
  modelIdRef,
  chatIdRef,
  activeConsoleIdRef,
  dbFlowFormRefCurrent,
  resultsContextRef,
}: UseChatTransportArgs) {
  return useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/agent/chat",
        prepareSendMessagesRequest: ({ messages }) => {
          // Get fresh console state at request time
          const store = useConsoleStore.getState();
          const tabs = Object.values(store.tabs) as ConsoleTab[];
          const activeTab = tabs.find(t => t.id === store.activeTabId);
          const computedActiveView = normalizeChatActiveView(activeTab?.kind);
          const workspaceId = workspaceIdRef.current;

          const flowFormState = dbFlowFormRefCurrent.current?.current
            ? dbFlowFormRefCurrent.current.current.getFormState()
            : undefined;

          // Read results context from Editor at request time
          const resultsCtx = resultsContextRef?.current ?? null;
          const activeConsoleResults: ActiveConsoleResultsContext | undefined =
            resultsCtx
              ? {
                  viewMode: resultsCtx.viewMode,
                  hasResults: resultsCtx.hasResults,
                  rowCount: resultsCtx.rowCount,
                  columns: resultsCtx.columns,
                  sampleRows: resultsCtx.sampleRows,
                  chartSpec: resultsCtx.chartSpec,
                }
              : undefined;

          const screenshotVisionAttachments =
            consumePendingScreenshotVisionAttachments();
          const requestBody = buildChatRequestBody({
            messages,
            workspaceId,
            modelId: modelIdRef.current,
            chatId: chatIdRef.current,
            tabs,
            activeTabId: store.activeTabId,
            activeTab,
            activeView: computedActiveView,
            activeExplorer: selectActiveExplorer(useUIStore.getState()),
            activeConsoleId: activeConsoleIdRef.current,
            activeConsoleResults,
            flowFormState,
          });

          return {
            body: toJsonSafe(
              screenshotVisionAttachments.length > 0
                ? {
                    ...requestBody,
                    screenshotVisionAttachments,
                  }
                : requestBody,
            ) as Record<string, unknown>,
          };
        },
        // Where `resume: true` reattaches to an in-flight turn (page refresh,
        // another device/viewer). 204 means nothing is streaming.
        prepareReconnectToStreamRequest: ({ id }) => ({
          api: `/api/agent/chat/${id}/stream`,
        }),
      }),
    // The refs are stable; only a new results-context bridge rebuilds it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resultsContextRef],
  );
}
