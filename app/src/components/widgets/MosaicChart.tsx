import React, {
  useMemo,
} from "react";
import { Box, CircularProgress } from "@mui/material";
import ResultsChart, { type CrossFilterSelection } from "../ResultsChart";
import type { MakoChartSpec } from "../../lib/chart-spec";
import type {
  DashboardCrossFilterResolution,
  MosaicInstance,
} from "../../lib/mosaic";
import { useMosaicClient } from "../../dashboard-runtime/useMosaicClient";

interface MosaicChartProps {
  widgetId: string;
  dataSourceId: string;
  localSql: string;
  vegaLiteSpec?: Record<string, unknown>;
  mosaicInstance?: MosaicInstance | null;
  crossFilterEnabled?: boolean;
  crossFilterResolution?: DashboardCrossFilterResolution;
  onError?: (error: string) => void;
}

const MosaicChart: React.FC<MosaicChartProps> = ({
  widgetId,
  dataSourceId,
  localSql,
  vegaLiteSpec,
  mosaicInstance,
  crossFilterEnabled = true,
  crossFilterResolution = "intersect",
  onError,
}) => {
  const { rows, fields, loading, updateSelection } = useMosaicClient({
    widgetId,
    dataSourceId,
    localSql,
    mosaicInstance,
    crossFilterEnabled,
    crossFilterResolution,
    onError,
  });

  const handleSelectionChange = React.useCallback(
    (selection: CrossFilterSelection | null) => {
      updateSelection(selection);
    },
    [updateSelection],
  );

  const enhancedSpec = useMemo(() => {
    if (!vegaLiteSpec) return undefined;

    const spec = { ...vegaLiteSpec } as any;

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

        if (spec.encoding) {
          if (!spec.encoding.opacity) {
            spec.encoding.opacity = {
              condition: { param: "brush", value: 1 },
              value: 0.3,
            };
          }
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
      onSelectionChange={
        crossFilterEnabled ? handleSelectionChange : undefined
      }
    />
  );
};

export default MosaicChart;
