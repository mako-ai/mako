import { useMemo } from "react";
import {
  Box,
  Typography,
  Button,
  Chip,
  Tooltip,
  Alert,
  Stack,
  CircularProgress,
} from "@mui/material";
import { RotateCw as BuildIcon } from "lucide-react";
import { useAppStore } from "../store/appStore";

interface EnvironmentArtifactStatusProps {
  appId: string;
  bindingId: string;
  /** dbt environment the preview is pinned to (never the prod-like one). */
  environment: string;
  onBuildClick: () => void;
  buildInProgress: boolean;
  /** Render as a single inline chip (for tight toolbars). */
  compact?: boolean;
}

type BuildStatus = "missing" | "queued" | "building" | "ready" | "error";

function formatRelative(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/**
 * Build state of a parquet binding's artifact for ONE dbt environment.
 *
 * Parquet bindings materialize prod data by default, so a dev/staging preview
 * has nothing to read until an environment artifact is built. This surfaces
 * that explicitly — ready / building / failed / not built — and offers the
 * build, rather than silently degrading to a row-capped live query.
 */
export default function EnvironmentArtifactStatus({
  appId,
  bindingId,
  environment,
  onBuildClick,
  buildInProgress,
  compact = false,
}: EnvironmentArtifactStatusProps) {
  // Subscribe (not getState) so the chip tracks a build as it progresses.
  const artifact = useAppStore(
    state =>
      state.openApps[appId]?.dataBindings.find(b => b.id === bindingId)?.cache
        ?.environments?.[environment],
  );
  // In-flight status from the poller lands here before the app is refetched.
  const polled = useAppStore(
    state => state.bindingBuildStatusByEnv[appId]?.[bindingId]?.[environment],
  );

  const status = (polled?.status ??
    artifact?.status ??
    "missing") as BuildStatus;
  const error = polled?.error ?? artifact?.error ?? null;

  const detail = useMemo(() => {
    if (status !== "ready") return null;
    const rows =
      artifact?.rowCount != null
        ? `${artifact.rowCount.toLocaleString()} rows`
        : null;
    const age = artifact?.builtAt
      ? formatRelative(Date.now() - new Date(artifact.builtAt).getTime())
      : null;
    return [rows, age].filter(Boolean).join(" · ") || null;
  }, [status, artifact?.rowCount, artifact?.builtAt]);

  const chip = useMemo(() => {
    switch (status) {
      case "ready":
        return {
          label: detail ?? "Ready",
          color: "success" as const,
          tooltip: `Previewing the full "${environment}" dataset.`,
        };
      case "building":
        return {
          label: "Building…",
          color: "info" as const,
          tooltip: `Materializing "${environment}" data.`,
        };
      case "queued":
        return {
          label: "Queued",
          color: "info" as const,
          tooltip: "Waiting for a build slot.",
        };
      case "error":
        return {
          label: "Build failed",
          color: "error" as const,
          tooltip: error || "The last build failed.",
        };
      default:
        return {
          label: "Not built",
          color: "default" as const,
          tooltip: `No "${environment}" data has been built for this data source yet.`,
        };
    }
  }, [status, detail, error, environment]);

  const busy = status === "building" || status === "queued";
  // Only these two states have nothing to read, so the preview degrades.
  const fallingBack = status === "missing" || status === "error";

  if (compact) {
    return (
      <Tooltip title={chip.tooltip}>
        <Chip
          size="small"
          variant="outlined"
          color={chip.color}
          icon={busy ? <CircularProgress size={12} /> : undefined}
          label={`${environment}: ${chip.label}`}
        />
      </Tooltip>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Tooltip title={chip.tooltip}>
          <Chip
            size="small"
            variant="outlined"
            color={chip.color}
            icon={busy ? <CircularProgress size={12} /> : undefined}
            label={chip.label}
          />
        </Tooltip>
        {fallingBack && (
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

      {fallingBack && (
        <Alert severity="info" sx={{ py: 0.5 }}>
          <Typography variant="caption">
            {status === "error"
              ? `The last "${environment}" build failed, so the preview is running the query live.`
              : `No "${environment}" data built yet, so the preview is running the query live.`}{" "}
            Live previews are capped at 500 rows — build to see the full
            dataset.
          </Typography>
        </Alert>
      )}

      {status === "error" && error && (
        <Typography variant="caption" color="error">
          {error}
        </Typography>
      )}

      {status === "ready" && artifact?.sourceSchema && (
        <Typography variant="caption" color="textSecondary">
          Built from <strong>{artifact.sourceSchema}</strong>
        </Typography>
      )}
    </Box>
  );
}
