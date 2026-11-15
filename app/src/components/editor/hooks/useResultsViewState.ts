import { useCallback, useEffect, useRef, useState } from "react";
import type { MakoChartSpec } from "../../../lib/chart-spec";
import { useConsoleStore } from "../../../store/consoleStore";
import type { ConsoleTab } from "../../../store/lib/types";
import { buildResultsContext } from "../editor-results";
import type {
  ChartSpecChangePayload,
  ConsoleResultsContext,
  QueryResult,
  ResultsViewMode,
} from "../types";
import { useStableCallback } from "./useStableCallback";

type RenderResult = { success: boolean; error?: string };

interface UseResultsViewStateArgs {
  tabs: Record<string, ConsoleTab>;
  consoleTabs: ConsoleTab[];
  activeTabId: string | null;
  tabResults: Record<string, QueryResult | null>;
  onChartSpecChangeRef?: React.MutableRefObject<
    ((payload: ChartSpecChangePayload) => void) | undefined
  >;
  resultsContextRef?: React.MutableRefObject<ConsoleResultsContext | null>;
}

/**
 * Per-tab results presentation (table / json / chart and the chart spec),
 * seeded from the persisted tab and mirrored back to the store, plus the two
 * bridges Chat uses: setting a chart spec on the active tab and reading the
 * active tab's results at request time.
 */
export function useResultsViewState({
  tabs,
  consoleTabs,
  activeTabId,
  tabResults,
  onChartSpecChangeRef,
  resultsContextRef,
}: UseResultsViewStateArgs) {
  const updateChartSpec = useConsoleStore(state => state.updateChartSpec);
  const updateResultsViewMode = useConsoleStore(
    state => state.updateResultsViewMode,
  );

  const [tabChartSpecs, setTabChartSpecs] = useState<
    Record<string, MakoChartSpec | null>
  >(() => {
    const initial: Record<string, MakoChartSpec | null> = {};
    for (const tab of Object.values(tabs)) {
      if (tab.chartSpec) {
        initial[tab.id] = tab.chartSpec as MakoChartSpec;
      }
    }
    return initial;
  });
  const [tabViewModes, setTabViewModes] = useState<
    Record<string, ResultsViewMode>
  >(() => {
    const initial: Record<string, ResultsViewMode> = {};
    for (const tab of Object.values(tabs)) {
      if (tab.resultsViewMode) {
        initial[tab.id] = tab.resultsViewMode;
      }
    }
    return initial;
  });
  const pendingRenderCallbackRef = useRef<
    Record<string, ((result: RenderResult) => void) | undefined>
  >({});

  const setChartSpecForTab = useCallback(
    (tabId: string, spec: MakoChartSpec | null) => {
      setTabChartSpecs(prev => ({ ...prev, [tabId]: spec }));
      updateChartSpec(tabId, spec as Record<string, unknown> | null);
    },
    [updateChartSpec],
  );

  const setViewModeForTab = useCallback(
    (tabId: string, mode: ResultsViewMode) => {
      setTabViewModes(prev => ({ ...prev, [tabId]: mode }));
      updateResultsViewMode(tabId, mode);
    },
    [updateResultsViewMode],
  );

  /** Resolve the agent's pending "did the chart render?" callback, once. */
  const reportChartRender = useStableCallback(
    (tabId: string, result: RenderResult) => {
      const cb = pendingRenderCallbackRef.current[tabId];
      if (cb) {
        cb(result);
        delete pendingRenderCallbackRef.current[tabId];
      }
    },
  );

  // Seed local chart spec / view mode state when tabs are loaded from the server
  useEffect(() => {
    for (const tab of consoleTabs) {
      if (tab.chartSpec) {
        setTabChartSpecs(prev => {
          if (prev[tab.id]) return prev;
          return {
            ...prev,
            [tab.id]: tab.chartSpec as MakoChartSpec,
          };
        });
      }
      if (tab.resultsViewMode) {
        const viewMode = tab.resultsViewMode;
        setTabViewModes(prev => {
          if (prev[tab.id]) return prev;
          return { ...prev, [tab.id]: viewMode };
        });
      }
    }
  }, [consoleTabs]);

  // Expose chart spec change handler so Chat can set the spec for the active tab
  useEffect(() => {
    if (onChartSpecChangeRef) {
      onChartSpecChangeRef.current = (payload: ChartSpecChangePayload) => {
        const tabId = activeTabId;
        if (!tabId) return;
        if (payload.onRenderResult) {
          pendingRenderCallbackRef.current[tabId] = payload.onRenderResult;
        }
        setChartSpecForTab(tabId, payload.spec);
        setViewModeForTab(tabId, "chart");
      };
    }
    return () => {
      if (onChartSpecChangeRef) {
        onChartSpecChangeRef.current = undefined;
      }
    };
  }, [
    activeTabId,
    onChartSpecChangeRef,
    setChartSpecForTab,
    setViewModeForTab,
  ]);

  // Keep resultsContextRef up to date so Chat can read results state at request time
  useEffect(() => {
    if (!resultsContextRef) return;
    const tabId = activeTabId;
    if (!tabId) {
      resultsContextRef.current = null;
      return;
    }
    resultsContextRef.current = buildResultsContext(
      tabResults[tabId],
      tabViewModes[tabId] ?? "table",
      tabChartSpecs[tabId] ?? null,
    );
  }, [activeTabId, tabResults, tabViewModes, tabChartSpecs, resultsContextRef]);

  return {
    tabChartSpecs,
    tabViewModes,
    setChartSpecForTab,
    setViewModeForTab,
    reportChartRender,
  };
}
