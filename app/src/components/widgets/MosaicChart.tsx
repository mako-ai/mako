import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";
import { Box, CircularProgress } from "@mui/material";
import ResultsChart, { type CrossFilterSelection } from "../ResultsChart";
import { useMosaicClient } from "../../dashboard-runtime/useMosaicClient";
import type { DashboardQueryExecutor } from "../../dashboard-runtime/types";
import type { MakoChartSpec } from "../../lib/chart-spec";
import { createSelectionClause, type MosaicInstance } from "../../lib/mosaic";

interface MosaicChartProps {
  queryExecutor?: DashboardQueryExecutor;
  widgetId: string;
  dataSourceId?: string;
  tableName: string;
  localSql: string;
  vegaLiteSpec?: Record<string, unknown>;
  mosaicInstance?: MosaicInstance | null;
  crossFilterEnabled?: boolean;
  crossFilterResolution?: "intersect" | "union";
  onError?: (error: string) => void;
}

const MosaicChart: React.FC<MosaicChartProps> = ({
  queryExecutor,
  widgetId,
  dataSourceId,
  tableName: _tableName,
  localSql,
  vegaLiteSpec,
  mosaicInstance,
  crossFilterEnabled = true,
  crossFilterResolution = "intersect",
  onError,
}) => {
  const {
    rows: mosaicRows,
    fields: mosaicFields,
    loading: mosaicLoading,
  } = useMosaicClient({
    widgetId,
    localSql,
    dataSourceId,
    mosaicInstance: mosaicInstance ?? null,
    crossFilterEnabled,
    crossFilterResolution,
  });

  const [fallbackData, setFallbackData] = useState<any[]>([]);
  const [fallbackFields, setFallbackFields] = useState<
    Array<{ name: string; type: string }>
  >([]);
  const [fallbackLoading, setFallbackLoading] = useState(true);
  const activeSelectionRef = useRef<CrossFilterSelection | null>(null);

  const fetchData = useCallback(async () => {
    if (mosaicInstance && crossFilterEnabled) return;
    setFallbackLoading(true);
    try {
      if (!queryExecutor) {
        throw new Error("Query executor is not available");
      }
      const result = await queryExecutor(localSql);
      setFallbackData(result.rows);
      setFallbackFields(result.fields);
    } catch (e: any) {
      onError?.(e?.message || "Query failed");
    } finally {
      setFallbackLoading(false);
    }
  }, [localSql, onError, queryExecutor, mosaicInstance, crossFilterEnabled]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const useMosaicData = Boolean(mosaicInstance && crossFilterEnabled);
  const data = useMosaicData ? mosaicRows : fallbackData;
  const fields = useMosaicData ? mosaicFields : fallbackFields;
  const loading = useMosaicData ? mosaicLoading : fallbackLoading;

  const handleSelectionChange = useCallback(
    (selection: CrossFilterSelection | null) => {
      if (!mosaicInstance || !crossFilterEnabled) return;

      const { selection: mosaicSelection } = mosaicInstance;

      if (!selection) {
        if (activeSelectionRef.current) {
          activeSelectionRef.current = null;
          try {
            mosaicSelection.update?.({
              source: widgetId,
              value: null,
            });
          } catch {
            // silent
          }
        }
        return;
      }

      const clause = createSelectionClause(selection);
      if (!clause) return;

      if (
        activeSelectionRef.current &&
        activeSelectionRef.current.field === selection.field &&
        activeSelectionRef.current.type === selection.type &&
        JSON.stringify(activeSelectionRef.current.values) ===
          JSON.stringify(selection.values)
      ) {
        activeSelectionRef.current = null;
        try {
          mosaicSelection.update?.({
            source: widgetId,
            value: null,
          });
        } catch {
          // silent
        }
        return;
      }

      activeSelectionRef.current = selection;
      try {
        mosaicSelection.update?.({
          source: widgetId,
          value: clause,
        });
      } catch {
        // silent
      }
    },
    [mosaicInstance, crossFilterEnabled, widgetId],
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

  if (loading && data.length === 0) {
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
      spec={enhancedSpec as MakoChartSpec | undefined}
      enableSelection={crossFilterEnabled}
      onSelectionChange={crossFilterEnabled ? handleSelectionChange : undefined}
    />
  );
};

export default MosaicChart;
