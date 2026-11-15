import React, { memo, useMemo, useCallback, useEffect, useRef } from "react";
import { Box, Typography, Snackbar, Alert, Button } from "@mui/material";
import { DataGridPremium } from "@mui/x-data-grid-premium";
import Editor from "../lib/monaco/MonacoEditor";
import { EDITOR_OPTIONS, useMonacoTheme } from "../lib/monaco-presets";
import { useIsMobile } from "../hooks/useIsMobile";
import type { MakoChartSpec } from "../lib/chart-spec";
import ResultsChart from "./ResultsChart";
import { attachOverlayScrollbars } from "./VSScrollArea";
import {
  onRenderDebug,
  useRenderCount,
  useWhyChanged,
} from "../utils/renderDebug";
import {
  buildGridModel,
  MONO_FONT_FAMILY,
  normalizeToArray,
  resultsToTsv,
  type QueryResult,
} from "./results-table/grid-model";
import {
  ResultsCards,
  ResultsSummaryBand,
} from "./results-table/MobileResults";
import {
  ResultsToolbar,
  type ResultsViewMode,
  type ViewMode,
} from "./results-table/ResultsToolbar";

const PINNED_RESULT_COLUMNS = { left: ["__rowIndex"], right: [] };
const RESULTS_TABLE_LOCALE_TEXT = { noRowsLabel: "No rows returned" };
const GRID_STYLE = { height: "100%", width: "auto" };
const GRID_SX = {
  "& .MuiDataGrid-cell": {
    fontSize: "12px",
    fontFamily: MONO_FONT_FAMILY,
    overflow: "hidden",
    textOverflow: "ellipsis",
    borderRight: "1px solid",
    borderColor: "divider",
  },
  "& .MuiDataGrid-columnHeaders": {
    backgroundColor: "background.default",
    fontFamily: MONO_FONT_FAMILY,
  },
  "& .MuiDataGrid-columnHeader": {
    backgroundColor: "background.default",
    fontFamily: MONO_FONT_FAMILY,
  },
  "& .MuiDataGrid-root": {
    overflow: "hidden",
  },
  "& .MuiDataGrid-row:first-of-type .MuiDataGrid-cell": {
    borderTop: "none",
  },
  "& .MuiDataGrid-main": {
    overflow: "hidden",
    backgroundColor: "background.default",
  },
  "& .MuiDataGrid-virtualScroller": {
    overflow: "auto",
  },
  "& .MuiDataGrid-virtualScrollerContent": {
    backgroundColor: "background.paper",
  },
  borderRadius: 0,
  border: "none",
} as const;

const CENTERED_MESSAGE_SX = {
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "text.secondary",
} as const;

const FULL_WIDTH_SX = { width: "100%", maxWidth: "100%" } as const;

interface ResultsTableProps {
  results?: QueryResult | null;
  chartSpec?: MakoChartSpec | null;
  onChartSpecChange?: (spec: MakoChartSpec | null) => void;
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  onChartRenderError?: (error: string) => void;
  onChartRenderSuccess?: () => void;
  onNextPage?: () => void;
  onPreviousPage?: () => void;
  onDownload?: (format: "csv" | "ndjson") => void;
  /**
   * Optional content for an extra "Structure" view mode (e.g. table DDL).
   * Only supported when viewMode is uncontrolled.
   */
  structureView?: React.ReactNode;
  /**
   * Hide the chart view. For surfaces where results are a correctness check
   * rather than something to visualize — the dbt editor's Preview grid, where
   * you are reading the rows a model returns, not charting them.
   */
  hideChartView?: boolean;
}

/**
 * Query results as a grid, JSON, chart, mobile cards, or a caller-supplied
 * structure view. Memoized: callers pass stable callbacks (see the Editor's
 * ConsoleResultsPane) so streaming/typing elsewhere does not re-render it.
 */
const ResultsTable: React.FC<ResultsTableProps> = ({
  results,
  chartSpec,
  onChartSpecChange,
  viewMode: controlledViewMode,
  onViewModeChange,
  onChartRenderError,
  onChartRenderSuccess,
  onNextPage,
  onPreviousPage,
  onDownload,
  structureView,
  hideChartView = false,
}) => {
  const isMobile = useIsMobile();
  const [snackbarOpen, setSnackbarOpen] = React.useState(false);
  const [internalViewMode, setInternalViewMode] =
    React.useState<ResultsViewMode>("table");
  // "cards" is a local override that takes precedence over the controlled
  // `viewMode` prop, so the mobile record-card view works even when the parent
  // (Editor) drives table/json/chart. Defaults on for mobile.
  const [localOverride, setLocalOverride] = React.useState<"cards" | null>(
    isMobile ? "cards" : null,
  );
  const monacoTheme = useMonacoTheme();

  const requestedViewMode: ResultsViewMode =
    localOverride ?? controlledViewMode ?? internalViewMode;
  // A caller that hides the chart must never end up rendering one — a
  // persisted "chart" mode from another surface would otherwise show a chart
  // with no way to switch back.
  const viewMode: ResultsViewMode =
    hideChartView && requestedViewMode === "chart"
      ? "table"
      : requestedViewMode;
  const setViewMode = useCallback(
    (mode: ResultsViewMode) => {
      if (mode === "cards") {
        // Local-only; never propagated to the persisted console view mode.
        setLocalOverride("cards");
        return;
      }
      setLocalOverride(null);
      if (mode === "structure" || !onViewModeChange) {
        setInternalViewMode(mode);
      } else {
        onViewModeChange(mode);
      }
    },
    [onViewModeChange],
  );
  const currentPage = results?.currentPage ?? 1;
  const canGoBack = currentPage > 1 && Boolean(onPreviousPage);
  const canGoForward = Boolean(results?.pageInfo?.hasMore && onNextPage);
  const lastTableResetExecutedAtRef = React.useRef<string | undefined>(
    undefined,
  );

  // Reset the view whenever new results arrive: cards on mobile (answer-first),
  // table on desktop.
  const executedAt = results?.executedAt;
  useEffect(() => {
    if (!executedAt || lastTableResetExecutedAtRef.current === executedAt) {
      return;
    }

    lastTableResetExecutedAtRef.current = executedAt;
    if (isMobile) {
      setLocalOverride("cards");
    } else {
      setLocalOverride(null);
      if (viewMode !== "table") {
        setViewMode("table");
      }
    }
  }, [executedAt, isMobile, setViewMode, viewMode]);

  const { columns, rows, hasFieldColumns } = useMemo(
    () => buildGridModel(results),
    [results],
  );

  const copyToClipboard = useCallback(async () => {
    const tsv = resultsToTsv(results, columns);
    if (tsv === null) return;
    try {
      await navigator.clipboard.writeText(tsv);
      setSnackbarOpen(true);
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
    }
  }, [results, columns]);

  // Serializing a large result set is expensive: only do it for the JSON
  // view, and only when the results change (not on every render).
  const jsonContent = useMemo(
    () => (viewMode === "json" ? JSON.stringify(results, null, 2) : ""),
    [viewMode, results],
  );

  // Data columns excluding the synthetic row-index column, used by the mobile
  // record-card view.
  const dataColumns = useMemo(
    () => columns.filter(col => col.field !== "__rowIndex"),
    [columns],
  );

  useRenderCount("ResultsTable", {
    executedAt,
    viewMode,
    rowCount: rows.length,
    columnCount: columns.length,
  });
  useWhyChanged("ResultsTable", {
    resultsRef: results,
    resultsPayloadRef: results?.results,
    fieldsRef: results?.fields,
    executedAt,
    resultCount: results?.resultCount,
    chartSpec,
    viewMode,
    onChartSpecChange,
    onViewModeChange,
    onNextPage,
    onPreviousPage,
    onDownload,
    rowsRef: rows,
    columnsRef: columns,
    rowCount: rows.length,
    columnCount: columns.length,
  });

  // The DataGrid owns its scroller (.MuiDataGrid-virtualScroller), so the
  // zero-gutter overlay attaches to that element in place — viewport-mode
  // init, no DOM restructuring, virtualization keeps reading scrollTop from
  // its own node. Retry briefly: the grid mounts its internals a frame or
  // two after this effect first runs.
  const gridAreaRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (viewMode !== "table" || !results) return;
    let destroy: (() => void) | null = null;
    let cancelled = false;
    let attempts = 0;
    const tryAttach = () => {
      if (cancelled) return;
      const scroller = gridAreaRef.current?.querySelector(
        ".MuiDataGrid-virtualScroller",
      );
      if (scroller instanceof HTMLElement) {
        destroy = attachOverlayScrollbars(scroller);
      } else if (attempts++ < 20) {
        requestAnimationFrame(tryAttach);
      }
    };
    tryAttach();
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [viewMode, results?.executedAt]);

  if (!results) {
    return (
      <Box sx={CENTERED_MESSAGE_SX}>
        <Typography>Execute a query to see results here</Typography>
      </Box>
    );
  }

  if (normalizeToArray(results.results).length === 0 && !hasFieldColumns) {
    return (
      <Box sx={CENTERED_MESSAGE_SX}>
        <Typography>No results found</Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        height: "100%",
        ...FULL_WIDTH_SX,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <ResultsToolbar
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        isMobile={isMobile}
        hideChartView={hideChartView}
        hasStructureView={structureView !== undefined}
        onCopy={copyToClipboard}
        onDownload={onDownload}
      />

      {/* Answer-first summary band (mobile) */}
      {isMobile && viewMode !== "structure" ? (
        <ResultsSummaryBand
          results={results}
          rows={rows}
          dataColumns={dataColumns}
        />
      ) : null}

      {/* Results content */}
      <Box
        ref={gridAreaRef}
        sx={{ flexGrow: 1, overflow: "hidden", ...FULL_WIDTH_SX }}
      >
        {viewMode === "cards" && (
          <ResultsCards rows={rows} dataColumns={dataColumns} />
        )}
        {viewMode === "table" && (
          <React.Profiler id="ResultsTable.DataGrid" onRender={onRenderDebug}>
            <DataGridPremium
              key={results.executedAt}
              rows={rows}
              columns={columns}
              pinnedColumns={PINNED_RESULT_COLUMNS}
              density="compact"
              disableRowSelectionOnClick
              hideFooter
              localeText={RESULTS_TABLE_LOCALE_TEXT}
              columnHeaderHeight={40}
              rowHeight={40}
              style={GRID_STYLE}
              sx={GRID_SX}
            />
          </React.Profiler>
        )}
        {viewMode === "json" && (
          <Box sx={{ height: "100%", ...FULL_WIDTH_SX, overflow: "hidden" }}>
            <Editor
              height="100%"
              defaultLanguage="json"
              value={jsonContent}
              theme={monacoTheme}
              options={{ ...EDITOR_OPTIONS.readOnly, fontSize: 14 }}
            />
          </Box>
        )}
        {viewMode === "chart" && (
          <ResultsChart
            data={normalizeToArray(results.results)}
            fields={results.fields}
            spec={chartSpec}
            onSpecChange={onChartSpecChange}
            onRenderError={onChartRenderError}
            onRenderSuccess={onChartRenderSuccess}
          />
        )}
        {viewMode === "structure" && structureView}
      </Box>

      {/* Footer with results info (data views only) */}
      {viewMode !== "structure" && (
        <Box
          sx={{
            p: 1,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: "1px solid",
            borderColor: "divider",
            gap: 2,
          }}
        >
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {results.resultCount} result(s) •{" "}
            {results.executionTime !== undefined &&
              `executed in ${results.executionTime} ms at `}
            {results.executionTime === undefined && "Executed at "}
            {new Date(results.executedAt).toLocaleString()}
            {results.pageInfo && ` • Page ${currentPage}`}
            {results.pageInfo?.capApplied && " • capped at 500 rows/page"}
          </Typography>
          {results.pageInfo && (
            <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
              <Button
                size="small"
                variant="outlined"
                onClick={onPreviousPage}
                disabled={!canGoBack}
              >
                Previous
              </Button>
              <Button
                size="small"
                variant="outlined"
                onClick={onNextPage}
                disabled={!canGoForward}
              >
                Next
              </Button>
            </Box>
          )}
        </Box>
      )}
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={3000}
        onClose={() => setSnackbarOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert
          onClose={() => setSnackbarOpen(false)}
          severity="success"
          sx={{ width: "100%" }}
        >
          Table copied to clipboard! You can now paste it in Google Sheets.
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default memo(ResultsTable);
