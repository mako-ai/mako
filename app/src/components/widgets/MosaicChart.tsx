import React, { useMemo } from "react";
import { Box, CircularProgress } from "@mui/material";
import ResultsChart, { type CrossFilterSelection } from "../ResultsChart";
import type { MakoChartSpec } from "../../lib/chart-spec";
import { dashboardRuntimeEvents } from "../../dashboard-runtime/events";
import type {
  DashboardCrossFilterResolution,
  MosaicInstance,
} from "../../lib/mosaic";
import { useDashboardRuntimeStore } from "../../dashboard-runtime/store";
import { useMosaicClient } from "../../dashboard-runtime/useMosaicClient";

interface MosaicChartProps {
  dashboardId: string;
  widgetId: string;
  dataSourceId: string;
  localSql: string;
  initialRows?: Record<string, unknown>[];
  initialFields?: Array<{ name: string; type: string }>;
  vegaLiteSpec?: Record<string, unknown>;
  mosaicInstance?: MosaicInstance | null;
  crossFilterEnabled?: boolean;
  crossFilterResolution?: DashboardCrossFilterResolution;
  queryGeneration?: number;
  refreshGeneration?: number;
  onError?: (error: string) => void;
}

const MosaicChart: React.FC<MosaicChartProps> = ({
  dashboardId,
  widgetId,
  dataSourceId,
  localSql,
  initialRows,
  initialFields,
  vegaLiteSpec,
  mosaicInstance,
  crossFilterEnabled = true,
  crossFilterResolution = "intersect",
  queryGeneration = 0,
  refreshGeneration = 0,
  onError,
}) => {
  const { rows, fields, loading, updateSelection, currentSelection } =
    useMosaicClient({
      dashboardId,
      widgetId,
      dataSourceId,
      localSql,
      initialRows,
      initialFields,
      mosaicInstance,
      crossFilterEnabled,
      crossFilterResolution,
      queryGeneration,
      refreshGeneration,
      onError,
    });

  const handleSelectionChange = React.useCallback(
    (selection: CrossFilterSelection | null) => {
      updateSelection(selection);
    },
    [updateSelection],
  );

  const handleRenderSuccess = React.useCallback(() => {
    useDashboardRuntimeStore
      .getState()
      .dispatch(
        dashboardRuntimeEvents.widgetRenderSucceeded(dashboardId, widgetId),
      );
  }, [dashboardId, widgetId]);

  const handleRenderError = React.useCallback(
    (error: string) => {
      useDashboardRuntimeStore
        .getState()
        .dispatch(
          dashboardRuntimeEvents.widgetRenderFailed(
            dashboardId,
            widgetId,
            error,
            "vega_render_failed",
          ),
        );
      onError?.(error);
    },
    [dashboardId, onError, widgetId],
  );

  const enhancedSpec = useMemo(() => {
    if (!vegaLiteSpec) return undefined;

    const spec = JSON.parse(JSON.stringify(vegaLiteSpec));

    const hasTemporalX =
      spec.encoding?.x?.type === "temporal" || spec.encoding?.x?.timeUnit;

    if (hasTemporalX && crossFilterEnabled) {
      if (!spec.params) spec.params = [];
      const hasBrush = spec.params.some((p: any) => p.name === "brush");
      if (!hasBrush) {
        spec.params.push({
          name: "brush",
          select: { type: "interval", encodings: ["x"] },
        });

        if (spec.encoding && !spec.encoding.opacity) {
          spec.encoding.opacity = {
            condition: { param: "brush", value: 1 },
            value: 0.3,
          };
        }
      }
    }

    return spec;
  }, [vegaLiteSpec, crossFilterEnabled]);

  if (loading && rows.length === 0) {
    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
        }}
      >
        <CircularProgress size={24} />
      </Box>
    );
  }

  return (
    <ResultsChart
      data={rows}
      fields={fields}
      spec={enhancedSpec as MakoChartSpec | undefined}
      enableSelection={crossFilterEnabled}
      activeSelection={crossFilterEnabled ? currentSelection : undefined}
      onSelectionChange={crossFilterEnabled ? handleSelectionChange : undefined}
      onRenderSuccess={handleRenderSuccess}
      onRenderError={handleRenderError}
    />
  );
};

export default MosaicChart;
