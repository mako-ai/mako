import { useCallback, useMemo } from "react";
import {
  Box,
  Typography,
  Button,
  Chip,
  Tooltip,
  Alert,
  Stack,
  CircularProgress,
  Divider,
} from "@mui/material";
import {
  RotateCw as BuildIcon,
  AlertCircle as WarningIcon,
  CheckCircle2 as ReadyIcon,
  Clock as PendingIcon,
} from "lucide-react";
import { useAppStore } from "../store/appStore";

interface EnvironmentArtifactStatusProps {
  appId: string;
  bindingId: string;
  environment: string;
  onBuildClick: () => void;
  buildInProgress: boolean;
  compact?: boolean;
}

/**
 * Shows the materialization status of a parquet binding for a specific
 * dbt environment. Used in the preview environment selector to indicate
 * whether dev/staging artifacts are ready or need to be built.
 *
 * Displays:
 * - Build status indicator (ready, building, queued, error, missing)
 * - Row count and freshness (if ready)
 * - "Build now?" button (if missing/error)
 * - Warning banner (if falling back to live query)
 */
export default function EnvironmentArtifactStatus({
  appId,
  bindingId,
  environment,
  onBuildClick,
  buildInProgress,
  compact = false,
}: EnvironmentArtifactStatusProps) {
  const store = useAppStore.getState();
  const app = store.openApps[appId];
  const binding = app?.dataBindings.find(b => b.id === bindingId);

  const envStatus = useMemo(() => {
    return binding?.cache?.environments?.[environment] || {
      status: "missing" as const,
    };
  }, [binding, environment]);

  const isFallbackToLiveQuery = useMemo(() => {
    // If the preview override is set for this environment and no artifact is
    // ready, we're falling back to a row-capped live query
    return (
      envStatus.status !== "ready" &&
      ["missing", "error"].includes(envStatus.status || "missing")
    );
  }, [envStatus.status]);

  const rowCount = envStatus.rowCount
    ? `${envStatus.rowCount.toLocaleString()} rows`
    : null;

  const builtAtMs = envStatus.builtAt
    ? new Date(envStatus.builtAt).getTime()
    : null;

  const age = useMemo(() => {
    if (!builtAtMs) return null;
    const ageMs = Date.now() - builtAtMs;
    const sec = Math.round(ageMs / 1000);
    if (sec < 60) return "just now";
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.round(hr / 24)}d ago`;
  }, [builtAtMs]);

  const statusInfo = useCallback(() => {
    switch (envStatus.status) {
      case "ready":
        return {
          icon: ReadyIcon,
          label: [rowCount, age].filter(Boolean).join(" · ") || "Ready",
          color: "success" as const,
          tooltip: "Environment artifact ready for preview",
        };
      case "building":
        return {
          icon: CircularProgress,
          label: "Building…",
          color: "info" as const,
          tooltip: "Materialization in progress",
        };
      case "queued":
        return {
          icon: PendingIcon,
          label: "Queued",
          color: "warning" as const,
          tooltip: "Build queued, waiting to start",
        };
      case "error":
        return {
          icon: WarningIcon,
          label: "Error",
          color: "error" as const,
          tooltip: envStatus.error || "Build failed",
        };
      default:
        return {
          icon: WarningIcon,
          label: "No artifact",
          color: "default" as const,
          tooltip: "Build now to use full-fidelity environment data",
        };
    }
  }, [envStatus.status, envStatus.error, rowCount, age]);

  const info = statusInfo();
  const Icon = info.icon;

  if (compact) {
    return (
      <Tooltip title={info.tooltip}>
        <Stack direction="row" alignItems="center" spacing={0.5}>
          <Icon size={16} strokeWidth={1.5} />
          <Typography variant="caption">{info.label}</Typography>
        </Stack>
      </Tooltip>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Tooltip title={info.tooltip}>
          <Chip
            size="small"
            icon={
              Icon === CircularProgress ? <CircularProgress size={16} /> : undefined
            }
            label={info.label}
            color={info.color}
            variant="outlined"
          />
        </Tooltip>
        {(envStatus.status === "missing" || envStatus.status === "error") && (
          <Button
            size="small"
            variant="outlined"
            startIcon={
              buildInProgress ? (
                <CircularProgress size={14} />
              ) : (
                <BuildIcon size={14} strokeWidth={1.5} />
              )
            }
            onClick={onBuildClick}
            disabled={buildInProgress}
          >
            {buildInProgress ? "Building…" : "Build now"}
          </Button>
        )}
      </Stack>

      {isFallbackToLiveQuery && (
        <Alert severity="info" sx={{ py: 0.5 }} icon={<WarningIcon size={16} />}>
          <Typography variant="caption">
            Falling back to live query (
            {envStatus.status === "error" ? "build failed" : "no artifact built yet"}
            ). Results limited to ~500 rows.
          </Typography>
        </Alert>
      )}

      {envStatus.sourceSchema && (
        <Typography variant="caption" color="textSecondary">
          Source schema: <strong>{envStatus.sourceSchema}</strong>
        </Typography>
      )}
    </Box>
  );
}
