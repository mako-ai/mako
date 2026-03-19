import React, { useEffect, useState, useCallback } from "react";
import { Box, Typography, CircularProgress } from "@mui/material";
import { TrendingUp, TrendingDown } from "lucide-react";
import { queryDuckDB } from "../../lib/duckdb";
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";

interface KpiCardProps {
  db: AsyncDuckDB;
  localSql: string;
  kpiConfig: {
    valueField: string;
    format?: string;
    comparisonField?: string;
    comparisonLabel?: string;
  };
  onError?: (error: string) => void;
}

function formatValue(value: number | null, format?: string): string {
  if (value == null) return "—";
  if (!format) return value.toLocaleString();
  try {
    if (format.includes("$")) {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(value);
    }
    if (format.includes("%")) {
      return new Intl.NumberFormat("en-US", {
        style: "percent",
        minimumFractionDigits: 1,
      }).format(value);
    }
    return value.toLocaleString();
  } catch {
    return String(value);
  }
}

const KpiCard: React.FC<KpiCardProps> = ({
  db,
  localSql,
  kpiConfig,
  onError,
}) => {
  const [mainValue, setMainValue] = useState<number | null>(null);
  const [comparisonValue, setComparisonValue] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const result = await queryDuckDB(db, localSql);
      if (result.rows.length > 0) {
        const row = result.rows[0];
        const val = row[kpiConfig.valueField];
        setMainValue(typeof val === "number" ? val : Number(val));
        if (kpiConfig.comparisonField) {
          const comp = row[kpiConfig.comparisonField];
          setComparisonValue(typeof comp === "number" ? comp : Number(comp));
        }
      }
    } catch (e: any) {
      onError?.(e?.message || "KPI query failed");
    } finally {
      setLoading(false);
    }
  }, [db, localSql, kpiConfig, onError]);

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

  const delta =
    comparisonValue != null && comparisonValue !== 0
      ? ((mainValue || 0) - comparisonValue) / Math.abs(comparisonValue)
      : null;
  const isPositive = delta != null && delta >= 0;

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        p: 2,
        gap: 0.5,
      }}
    >
      <Typography
        variant="h4"
        sx={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
      >
        {formatValue(mainValue, kpiConfig.format)}
      </Typography>
      {delta != null && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          {isPositive ? (
            <TrendingUp size={16} color="green" />
          ) : (
            <TrendingDown size={16} color="red" />
          )}
          <Typography
            variant="caption"
            sx={{
              color: isPositive ? "success.main" : "error.main",
              fontWeight: 600,
            }}
          >
            {(delta * 100).toFixed(1)}%
          </Typography>
          {kpiConfig.comparisonLabel && (
            <Typography variant="caption" color="text.secondary">
              {kpiConfig.comparisonLabel}
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
};

export default KpiCard;
