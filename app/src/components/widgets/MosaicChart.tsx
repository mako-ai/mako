import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";
import { Box, CircularProgress } from "@mui/material";
import ResultsChart from "../ResultsChart";
import { queryDuckDB } from "../../lib/duckdb";
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import type { MakoChartSpec } from "../../lib/chart-spec";
import type { MosaicInstance } from "../../lib/mosaic";

interface MosaicChartProps {
  db: AsyncDuckDB;
  widgetId: string;
  tableName: string;
  localSql: string;
  vegaLiteSpec?: Record<string, unknown>;
  mosaicInstance?: MosaicInstance | null;
  crossFilterEnabled?: boolean;
  onError?: (error: string) => void;
}

const MosaicChart: React.FC<MosaicChartProps> = ({
  db,
  widgetId,
  tableName: _tableName,
  localSql,
  vegaLiteSpec,
  mosaicInstance,
  crossFilterEnabled = true,
  onError,
}) => {
  const [data, setData] = useState<any[]>([]);
  const [fields, setFields] = useState<Array<{ name: string; type: string }>>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const clientRef = useRef<any>(null);

  const fetchData = useCallback(
    async (filterClause?: string) => {
      setLoading(true);
      try {
        let sql = localSql;
        if (filterClause) {
          if (sql.toLowerCase().includes("where")) {
            sql += ` AND (${filterClause})`;
          } else {
            const groupIdx = sql.toLowerCase().indexOf("group by");
            const orderIdx = sql.toLowerCase().indexOf("order by");
            const insertIdx = Math.min(
              groupIdx === -1 ? sql.length : groupIdx,
              orderIdx === -1 ? sql.length : orderIdx,
            );
            sql =
              sql.slice(0, insertIdx) +
              ` WHERE ${filterClause} ` +
              sql.slice(insertIdx);
          }
        }
        const result = await queryDuckDB(db, sql);
        setData(result.rows);
        setFields(result.fields);
      } catch (e: any) {
        onError?.(e?.message || "Query failed");
      } finally {
        setLoading(false);
      }
    },
    [db, localSql, onError],
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!mosaicInstance || !crossFilterEnabled) return;

    const { coordinator, selection } = mosaicInstance;

    const client = {
      _id: widgetId,
      filterBy: selection,

      query(filter?: any): { sql: string } {
        let sql = localSql;
        if (filter) {
          const clause =
            typeof filter === "string" ? filter : filter.toString?.() || "";
          if (clause) {
            if (sql.toLowerCase().includes("where")) {
              sql += ` AND (${clause})`;
            } else {
              sql += ` WHERE ${clause}`;
            }
          }
        }
        return { sql };
      },

      queryResult(resultData: any): void {
        if (!resultData) return;
        const rows: Record<string, unknown>[] = [];
        if (resultData.numRows) {
          const schema = resultData.schema?.fields || [];
          for (let i = 0; i < resultData.numRows; i++) {
            const row: Record<string, unknown> = {};
            for (const f of schema) {
              const col = resultData.getChild(f.name);
              row[f.name] = col?.get(i);
            }
            rows.push(row);
          }
        }
        setData(rows);
        setLoading(false);
      },

      update(): void {
        coordinator.requestQuery?.(client);
      },
    };

    try {
      coordinator.connect?.(client);
      clientRef.current = client;
    } catch {
      // Mosaic connection failed — fall back to non-filtered mode
    }

    return () => {
      try {
        coordinator.disconnect?.(clientRef.current);
      } catch {
        // Silent cleanup
      }
      clientRef.current = null;
    };
  }, [mosaicInstance, crossFilterEnabled, widgetId, localSql]);

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
    />
  );
};

export default MosaicChart;
