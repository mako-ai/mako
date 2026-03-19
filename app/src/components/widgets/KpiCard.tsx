import React from "react";
import { Box, Typography, CircularProgress } from "@mui/material";
import { TrendingUp, TrendingDown } from "lucide-react";
import { useDashboardQuery } from "../../dashboard-runtime/useDashboardQuery";
import type { DashboardQueryExecutor } from "../../dashboard-runtime/types";

interface KpiCardProps {
  queryExecutor?: DashboardQueryExecutor;
  dataSourceId?: string;
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

const KpiCardComponent: React.FC<KpiCardProps> = ({
  queryExecutor,
  dataSourceId,
  localSql,
  kpiConfig,
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

  const row = result?.rows[0];
  const mainRaw = row?.[kpiConfig.valueField];
  const mainValue =
    typeof mainRaw === "number"
      ? mainRaw
      : mainRaw != null
        ? Number(mainRaw)
        : null;
  const comparisonRaw = kpiConfig.comparisonField
    ? row?.[kpiConfig.comparisonField]
    : null;
  const comparisonValue =
    typeof comparisonRaw === "number"
      ? comparisonRaw
      : comparisonRaw != null
        ? Number(comparisonRaw)
        : null;

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

const KpiCard = React.memo(KpiCardComponent);
KpiCard.displayName = "KpiCard";

export default KpiCard;
