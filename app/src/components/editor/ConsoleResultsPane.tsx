import { memo, useCallback } from "react";
import { Box, Typography } from "@mui/material";
import type { MakoChartSpec } from "../../lib/chart-spec";
import type { ScheduledQueryRunItem } from "../../lib/api-types";
import ConsoleExecutionsPanel, {
  type ConsoleExecutionRow,
} from "../ConsoleExecutionsPanel";
import ScheduledRunsPanel from "../ScheduledRunsPanel";
import { ResultsTable } from "./lazy-tabs";
import { CompactTabs, FILL_COLUMN_SX, ResultsPaneTab } from "./styles";
import type { BottomPanel, QueryResult, ResultsViewMode } from "./types";

export interface ConsoleResultsActions {
  selectBottomPanel: (tabId: string, panel: BottomPanel) => void;
  setChartSpec: (tabId: string, spec: MakoChartSpec | null) => void;
  setViewMode: (tabId: string, mode: ResultsViewMode) => void;
  reportChartRender: (
    tabId: string,
    result: { success: boolean; error?: string },
  ) => void;
  previousPage: (tabId: string) => void;
  nextPage: (tabId: string) => void;
  download: (tabId: string, format: "csv" | "ndjson") => void;
}

export interface ConsoleRunsData {
  executions: ConsoleExecutionRow[];
  executionsLoading: boolean;
  executionsError: string | null | undefined;
  scheduledRuns: ScheduledQueryRunItem[];
  scheduledRunsLoading: boolean;
  scheduledRunsError: string | null | undefined;
}

interface ConsoleResultsPaneProps extends ConsoleRunsData {
  tabId: string;
  isSaved: boolean | undefined;
  hasSchedule: boolean;
  bottomPanel: BottomPanel;
  results: QueryResult | null;
  chartSpec: MakoChartSpec | null;
  viewMode: ResultsViewMode;
  actions: ConsoleResultsActions;
}

/**
 * A console's bottom pane: the results grid, or the Runs panel (recent
 * executions + scheduled runs). Every callback handed to ResultsTable is
 * bound once per tab so the memoized grid only re-renders for its own data.
 */
export const ConsoleResultsPane = memo(function ConsoleResultsPane({
  tabId,
  isSaved,
  hasSchedule,
  bottomPanel,
  results,
  chartSpec,
  viewMode,
  actions,
  executions,
  executionsLoading,
  executionsError,
  scheduledRuns,
  scheduledRunsLoading,
  scheduledRunsError,
}: ConsoleResultsPaneProps) {
  const {
    selectBottomPanel,
    setChartSpec,
    setViewMode,
    reportChartRender,
    previousPage,
    nextPage,
    download,
  } = actions;
  const onChartSpecChange = useCallback(
    (spec: MakoChartSpec | null) => setChartSpec(tabId, spec),
    [setChartSpec, tabId],
  );
  const onViewModeChange = useCallback(
    (mode: ResultsViewMode) => setViewMode(tabId, mode),
    [setViewMode, tabId],
  );
  const onChartRenderError = useCallback(
    (error: string) => reportChartRender(tabId, { success: false, error }),
    [reportChartRender, tabId],
  );
  const onChartRenderSuccess = useCallback(
    () => reportChartRender(tabId, { success: true }),
    [reportChartRender, tabId],
  );
  const onPreviousPage = useCallback(
    () => previousPage(tabId),
    [previousPage, tabId],
  );
  const onNextPage = useCallback(() => nextPage(tabId), [nextPage, tabId]);
  const onDownload = useCallback(
    (format: "csv" | "ndjson") => void download(tabId, format),
    [download, tabId],
  );

  return (
    <Box sx={{ ...FILL_COLUMN_SX, overflow: "hidden" }}>
      <Box
        sx={{
          px: 1.5,
          borderBottom: 1,
          borderColor: "divider",
          minHeight: 36,
          display: "flex",
          alignItems: "center",
        }}
      >
        <CompactTabs
          value={bottomPanel}
          onChange={(_event, value: BottomPanel) =>
            selectBottomPanel(tabId, value)
          }
        >
          <ResultsPaneTab value="results" label="Results" disableRipple />
          <ResultsPaneTab
            value="runs"
            label="Runs"
            disabled={!isSaved}
            disableRipple
          />
        </CompactTabs>
      </Box>
      <Box sx={{ flexGrow: 1, minHeight: 0 }}>
        {bottomPanel === "runs" ? (
          <Box sx={{ ...FILL_COLUMN_SX, minHeight: 0 }}>
            <Box sx={{ flex: 1, minHeight: 0 }}>
              <ConsoleExecutionsPanel
                loading={executionsLoading}
                error={executionsError}
                executions={executions}
              />
            </Box>
            {hasSchedule ? (
              <Box
                sx={{
                  borderTop: 1,
                  borderColor: "divider",
                  maxHeight: "45%",
                  minHeight: 120,
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                    px: 1.5,
                    py: 0.75,
                    fontWeight: 600,
                  }}
                >
                  Scheduled runs
                </Typography>
                <Box sx={{ flex: 1, minHeight: 0 }}>
                  <ScheduledRunsPanel
                    loading={scheduledRunsLoading}
                    error={scheduledRunsError}
                    runs={scheduledRuns}
                  />
                </Box>
              </Box>
            ) : null}
          </Box>
        ) : (
          <ResultsTable
            results={results}
            chartSpec={chartSpec}
            onChartSpecChange={onChartSpecChange}
            viewMode={viewMode}
            onViewModeChange={onViewModeChange}
            onChartRenderError={onChartRenderError}
            onChartRenderSuccess={onChartRenderSuccess}
            onPreviousPage={onPreviousPage}
            onNextPage={onNextPage}
            onDownload={onDownload}
          />
        )}
      </Box>
    </Box>
  );
});
