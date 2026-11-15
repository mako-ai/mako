import { useEffect, useRef, useState } from "react";
import { useConsoleStore } from "../../../store/consoleStore";
import type { ConsoleTab } from "../../../store/lib/types";
import { trackEvent } from "../../../lib/analytics";
import { getApiBasePath } from "../../../lib/api-base-path";
import {
  DEFAULT_PAGE_SIZE,
  nextPageOptions,
  omitKey,
  paginationFromPage,
  previousPageOptions,
  resultFromLastRun,
} from "../editor-results";
import type { ExecuteOptions, QueryResult, TabPaginationState } from "../types";
import type { EditorFeedback } from "./useEditorFeedback";
import { useStableCallback } from "./useStableCallback";

interface UseConsoleExecutionArgs {
  workspaceId: string | undefined;
  consoleTabs: ConsoleTab[];
  feedback: EditorFeedback;
  /** Called after a successful run (mobile pane flip, Runs panel refresh). */
  onExecuted: (tabId: string) => void;
}

/**
 * Query execution for console tabs: per-tab results, pagination, running /
 * cancelling flags (parallel queries across tabs), CSV/NDJSON export, and the
 * agent-driven run events. Every returned handler has a stable identity.
 */
export function useConsoleExecution({
  workspaceId,
  consoleTabs,
  feedback,
  onExecuted,
}: UseConsoleExecutionArgs) {
  const executeQuery = useConsoleStore(state => state.executeQuery);
  const cancelQuery = useConsoleStore(state => state.cancelQuery);

  const [tabResults, setTabResults] = useState<
    Record<string, QueryResult | null>
  >({});
  const [tabPagination, setTabPagination] = useState<
    Record<string, TabPaginationState | null>
  >({});
  // Per-tab execution state to allow parallel queries across tabs
  const [executingTabs, setExecutingTabs] = useState<Record<string, boolean>>(
    {},
  );
  const [cancellingTabs, setCancellingTabs] = useState<Record<string, boolean>>(
    {},
  );

  // Refs for query cancellation (per-tab to support parallel queries)
  const abortControllersRef = useRef<Record<string, AbortController | null>>(
    {},
  );
  const executionIdsRef = useRef<Record<string, string | null>>({});

  const { showError, setErrorPreviewRetry, showSnackbar, hideSnackbar } =
    feedback;

  const execute = useStableCallback(
    async (
      tabId: string,
      contentToExecute: string,
      connectionId?: string,
      options?: ExecuteOptions,
    ) => {
      if (!contentToExecute.trim()) return;

      if (!workspaceId) {
        showError("No workspace selected");
        return;
      }

      if (!connectionId) {
        showError("No database connection selected");
        return;
      }

      // Create per-tab abort controller and execution ID
      const abortController = new AbortController();
      const executionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      abortControllersRef.current[tabId] = abortController;
      executionIdsRef.current[tabId] = executionId;

      setExecutingTabs(prev => ({ ...prev, [tabId]: true }));
      setCancellingTabs(prev => ({ ...prev, [tabId]: false }));
      const startTime = Date.now();
      try {
        const consoleTab = useConsoleStore.getState().tabs[tabId];
        const result = await executeQuery(
          workspaceId,
          connectionId,
          contentToExecute,
          {
            ...options,
            executionId,
            signal: abortController.signal,
            pageSize: options?.pageSize ?? DEFAULT_PAGE_SIZE,
            cursor: options?.cursor ?? null,
            confirmUnsafe: options?.confirmUnsafe,
            // Console tab ids are Mongo ObjectIds (generateObjectId / server id).
            ...(consoleTab?.kind === "console" || consoleTab?.kind === undefined
              ? { consoleId: tabId }
              : {}),
          },
        );
        const executionTime = Date.now() - startTime;
        if (result.success) {
          trackEvent("query_executed", {
            connection_id: connectionId,
            success: true,
            duration_ms: executionTime,
          });

          const fields =
            "fields" in result
              ? (
                  result as {
                    fields?: Array<
                      { name?: string; originalName?: string } | string
                    >;
                  }
                ).fields
              : undefined;

          setTabResults(prev => ({
            ...prev,
            [tabId]: {
              results: result.rows || [],
              executedAt: new Date().toISOString(),
              resultCount: Array.isArray(result.rows) ? result.rows.length : 0,
              executionTime,
              fields,
              pageInfo: result.pageInfo || null,
              currentPage: options?.currentPage ?? 1,
            },
          }));
          setTabPagination(prev => ({
            ...prev,
            [tabId]: paginationFromPage(result.pageInfo, options),
          }));
          onExecuted(tabId);
        } else if (result.error !== "Query cancelled") {
          const errText =
            typeof result.error === "string"
              ? result.error
              : JSON.stringify(result.error, null, 2);
          if (
            "code" in result &&
            result.code === "PREVIEW_BLOCKED" &&
            !options?.confirmUnsafe
          ) {
            setErrorPreviewRetry({
              tabId,
              contentToExecute,
              connectionId,
              options: {
                databaseId: options?.databaseId,
                databaseName: options?.databaseName,
                cursor: options?.cursor,
                currentPage: options?.currentPage,
                cursorHistory: options?.cursorHistory,
                pageSize: options?.pageSize,
              },
            });
          } else {
            setErrorPreviewRetry(null);
          }
          showError(errText);
          setTabResults(prev => ({ ...prev, [tabId]: null }));
          setTabPagination(prev => ({ ...prev, [tabId]: null }));
        }
      } catch (e: any) {
        if (e?.name !== "AbortError") {
          showError(JSON.stringify(e, null, 2));
          setTabResults(prev => ({ ...prev, [tabId]: null }));
          setTabPagination(prev => ({ ...prev, [tabId]: null }));
        }
      } finally {
        setExecutingTabs(prev => ({ ...prev, [tabId]: false }));
        setCancellingTabs(prev => ({ ...prev, [tabId]: false }));
        delete abortControllersRef.current[tabId];
        delete executionIdsRef.current[tabId];
      }
    },
  );

  const runPage = (
    tabId: string,
    pick: typeof nextPageOptions,
  ): Promise<void> | undefined => {
    const tab = useConsoleStore.getState().tabs[tabId];
    if (!tab?.connectionId) return;
    const options = pick(tab, tabPagination[tabId]);
    if (!options) return;
    return execute(tabId, tab.content, tab.connectionId, options);
  };

  const nextPage = useStableCallback(async (tabId: string) => {
    await runPage(tabId, nextPageOptions);
  });

  const previousPage = useStableCallback(async (tabId: string) => {
    await runPage(tabId, previousPageOptions);
  });

  const cancel = useStableCallback(async (tabId: string) => {
    const executionId = executionIdsRef.current[tabId];
    if (!workspaceId || !executionId) return;
    setCancellingTabs(prev => ({ ...prev, [tabId]: true }));
    abortControllersRef.current[tabId]?.abort();
    await cancelQuery(workspaceId, executionId);
  });

  const download = useStableCallback(
    async (tabId: string, format: "csv" | "ndjson") => {
      const tab = useConsoleStore.getState().tabs[tabId];
      if (!workspaceId) {
        showError("No workspace selected");
        return;
      }

      if (!tab?.connectionId) {
        showError("No database connection selected");
        return;
      }

      const action = `${getApiBasePath(import.meta.env.VITE_API_URL)}/workspaces/${workspaceId}/execute/export`;
      const baseName = tab.title || "query-results";

      showSnackbar(format === "csv" ? "Preparing CSV…" : "Preparing NDJSON…");

      try {
        // We use fetch (not a hidden-iframe form POST) so that server-side
        // errors — preview-safety rejections, BigQuery auth/permission
        // failures, etc. — surface to the user instead of being swallowed
        // by an invisible iframe that always shows a "download started" toast.
        const response = await fetch(action, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectionId: tab.connectionId,
            databaseId: tab.databaseId,
            databaseName: tab.databaseName,
            query: tab.content,
            format,
            filename: baseName,
          }),
        });

        if (!response.ok) {
          let message = `Export failed (HTTP ${response.status})`;
          try {
            const errorBody = await response.json();
            if (errorBody?.error) {
              message = errorBody.error;
            }
          } catch {
            const text = await response.text().catch(() => "");
            if (text) message = text;
          }
          hideSnackbar();
          showError(message);
          return;
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${baseName}.${format === "csv" ? "csv" : "ndjson"}`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);

        showSnackbar(format === "csv" ? "CSV downloaded" : "NDJSON downloaded");
      } catch (error) {
        hideSnackbar();
        showError(
          error instanceof Error
            ? error.message
            : "Failed to download query results",
        );
      }
    },
  );

  /** Forget a closed tab's results and pagination. */
  const dropTab = useStableCallback((tabId: string) => {
    setTabResults(prev => omitKey(prev, tabId));
    setTabPagination(prev => omitKey(prev, tabId));
  });

  // Listen for console execution events from AI (run_console tool)
  useEffect(() => {
    const handleExecutionStart = (event: Event) => {
      const { consoleId } = (event as CustomEvent<{ consoleId: string }>)
        .detail;
      if (consoleId) {
        setExecutingTabs(prev => ({ ...prev, [consoleId]: true }));
      }
    };

    const handleExecutionResult = (event: Event) => {
      const customEvent = event as CustomEvent<{
        consoleId: string;
        result: QueryResult | null;
      }>;
      const { consoleId, result } = customEvent.detail;
      if (consoleId) {
        setTabResults(prev => ({ ...prev, [consoleId]: result }));
        setExecutingTabs(prev => ({ ...prev, [consoleId]: false }));
      }
    };

    window.addEventListener("console-execution-start", handleExecutionStart);
    window.addEventListener("console-execution-result", handleExecutionResult);
    return () => {
      window.removeEventListener(
        "console-execution-start",
        handleExecutionStart,
      );
      window.removeEventListener(
        "console-execution-result",
        handleExecutionResult,
      );
    };
  }, []);

  // Persisted run artifacts (tab.lastRun) -> results panel; see
  // resultFromLastRun. The live console-execution-result path handles
  // connected windows; this is the durable backstop for a missed event.
  useEffect(() => {
    for (const tab of consoleTabs) {
      const lastRun = tab.lastRun;
      if (!lastRun || lastRun.status !== "success" || !lastRun.sampleRows) {
        continue;
      }
      setTabResults(prev => {
        const next = resultFromLastRun(lastRun, prev[tab.id]);
        return next ? { ...prev, [tab.id]: next } : prev;
      });
    }
  }, [consoleTabs]);

  return {
    tabResults,
    executingTabs,
    cancellingTabs,
    execute,
    cancel,
    nextPage,
    previousPage,
    download,
    dropTab,
  };
}
