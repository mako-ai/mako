import React, { useEffect, useState, useCallback } from "react";
import { Box, CircularProgress } from "@mui/material";
import ResultsChart from "../ResultsChart";
import { queryDuckDB } from "../../lib/duckdb";
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import type { MakoChartSpec } from "../../lib/chart-spec";

interface ChartWidgetProps {
  db: AsyncDuckDB;
  localSql: string;
  vegaLiteSpec?: Record<string, unknown>;
  onError?: (error: string) => void;
}

const ChartWidget: React.FC<ChartWidgetProps> = ({
  db,
  localSql,
  vegaLiteSpec,
  onError,
}) => {
  const [data, setData] = useState<any[]>([]);
  const [fields, setFields] = useState<Array<{ name: string; type: string }>>(
    [],
  );
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const result = await queryDuckDB(db, localSql);
      setData(result.rows);
      setFields(result.fields);
    } catch (e: any) {
      onError?.(e?.message || "Query failed");
    } finally {
      setLoading(false);
    }
  }, [db, localSql, onError]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

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
      data={data}
      fields={fields}
      spec={vegaLiteSpec as MakoChartSpec | undefined}
    />
  );
};

export default ChartWidget;
