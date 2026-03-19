import React from "react";
import { Box, CircularProgress } from "@mui/material";
import ResultsChart from "../ResultsChart";
import type { MakoChartSpec } from "../../lib/chart-spec";
import { useDashboardQuery } from "../../dashboard-runtime/useDashboardQuery";
import type { DashboardQueryExecutor } from "../../dashboard-runtime/types";

interface ChartWidgetProps {
  queryExecutor?: DashboardQueryExecutor;
  dataSourceId?: string;
  localSql: string;
  vegaLiteSpec?: Record<string, unknown>;
  onError?: (error: string) => void;
}

const ChartWidgetComponent: React.FC<ChartWidgetProps> = ({
  queryExecutor,
  dataSourceId,
  localSql,
  vegaLiteSpec,
  onError,
}) => {
  const { result, loading, error } = useDashboardQuery({
    sql: localSql,
    dataSourceId,
    queryExecutor,
    enabled: Boolean(localSql.trim()),
  });

  React.useEffect(() => {
    if (error) {
      onError?.(error);
    }
  }, [error, onError]);

  if (loading) {
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
      data={result?.rows || []}
      fields={result?.fields || []}
      spec={vegaLiteSpec as MakoChartSpec | undefined}
    />
  );
};

const ChartWidget = React.memo(ChartWidgetComponent);
ChartWidget.displayName = "ChartWidget";

export default ChartWidget;
