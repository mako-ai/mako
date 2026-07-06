import { useCallback, useState, type ReactNode } from "react";
import {
  Box,
  Typography,
  Button,
  Chip,
  Tooltip,
  IconButton,
  Popover,
  Divider,
} from "@mui/material";
import {
  DatabaseZap as MaterializeIcon,
  CalendarClock as ScheduleIcon,
  History as HistoryIcon,
  Eye as PreviewIcon,
  CheckCircle2 as SuccessIcon,
  XCircle as ErrorIcon,
} from "lucide-react";
import MaterializationScheduleControls from "./MaterializationScheduleControls";
import type { MaterializationScheduleValue } from "../lib/materializationSchedule";

/**
 * Shared materialization toolbar for app data bindings and dashboard data
 * sources. Both surfaces present the same controls — Materialize button, build
 * status chip, freshness badge, snapshot preview, schedule popover, and history
 * popover — so the two editors look and behave identically. Surface-specific
 * wiring (where the schedule/cache live, how history is loaded) is passed in.
 */

export type MaterializationBuildStatus =
  | "missing"
  | "queued"
  | "building"
  | "ready"
  | "error";

/** Normalized history entry rendered in the history popover. */
export interface MaterializationHistoryItem {
  id: string;
  status: "ready" | "error";
  /** ISO timestamp the run was requested/finished. */
  at: string;
  rowCount?: number | null;
  durationMs?: number | null;
  error?: string | null;
}

interface Props {
  /** Optional leading controls (e.g. the app's Live/Materialized toggle). */
  leadingControls?: ReactNode;
  /**
   * When false, the materialize cluster (button, chip, preview, history) is
   * hidden — used by app live bindings, which have nothing to materialize. The
   * schedule control is always hidden in that case too.
   */
  showMaterializeControls?: boolean;

  buildStatus?: MaterializationBuildStatus | null;
  rowCount?: number | null;
  /** Epoch ms the artifact was last built — drives the freshness badge. */
  builtAtMs?: number | null;
  /** Freshness window in ms; when older than this the badge turns "Stale". */
  dataFreshnessTtlMs?: number | null;

  onMaterialize: () => void;
  materializing: boolean;

  canPreview?: boolean;
  onPreviewSnapshot?: () => void;
  previewing?: boolean;

  schedule: MaterializationScheduleValue;
  onScheduleChange: (next: MaterializationScheduleValue) => void;
  scheduleDisabled?: boolean;
  scheduleCaption: string;

  /** History rows to render. May be loaded lazily via `onOpenHistory`. */
  history: MaterializationHistoryItem[];
  /** Invoked when the history popover opens (e.g. to fetch runs). */
  onOpenHistory?: () => void | Promise<void>;
  /** Hide the history control entirely (e.g. nothing to show). */
  showHistory?: boolean;
}

const DEFAULT_FRESHNESS_TTL_MS = 24 * 60 * 60 * 1000;

function formatRelative(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export default function DataSourceMaterializationControls({
  leadingControls,
  showMaterializeControls = true,
  buildStatus,
  rowCount,
  builtAtMs,
  dataFreshnessTtlMs,
  onMaterialize,
  materializing,
  canPreview,
  onPreviewSnapshot,
  previewing,
  schedule,
  onScheduleChange,
  scheduleDisabled,
  scheduleCaption,
  history,
  onOpenHistory,
  showHistory = true,
}: Props) {
  const [scheduleAnchor, setScheduleAnchor] = useState<HTMLElement | null>(
    null,
  );
  const [historyAnchor, setHistoryAnchor] = useState<HTMLElement | null>(null);

  const openHistory = useCallback(
    (anchor: HTMLElement) => {
      setHistoryAnchor(anchor);
      void onOpenHistory?.();
    },
    [onOpenHistory],
  );

  // Freshness badge: only meaningful once a snapshot exists. Stale when the
  // artifact is older than the freshness window (default 24h, matching the
  // dashboard canvas badge).
  let freshness: { label: string; stale: boolean } | null = null;
  if (buildStatus === "ready" && builtAtMs) {
    const ageMs = Date.now() - builtAtMs;
    const ttl = dataFreshnessTtlMs ?? DEFAULT_FRESHNESS_TTL_MS;
    freshness = { label: formatRelative(ageMs), stale: ageMs > ttl };
  }

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, ml: 1 }}>
      {leadingControls}

      {showMaterializeControls && (
        <>
          <Tooltip title="Re-materialize this query's Parquet file">
            <span>
              <Button
                size="small"
                variant="outlined"
                color="inherit"
                startIcon={<MaterializeIcon size={16} strokeWidth={1.5} />}
                onClick={onMaterialize}
                disabled={materializing}
              >
                {materializing ? "Materializing…" : "Materialize"}
              </Button>
            </span>
          </Tooltip>
          {buildStatus && (
            <Chip
              size="small"
              variant="outlined"
              color={
                buildStatus === "ready"
                  ? "success"
                  : buildStatus === "error"
                    ? "error"
                    : "default"
              }
              label={
                buildStatus === "ready" && rowCount != null
                  ? `${rowCount.toLocaleString()} rows`
                  : buildStatus
              }
            />
          )}
          {freshness && (
            <Tooltip
              title={
                freshness.stale
                  ? "The snapshot is older than its freshness window — click Materialize to refresh."
                  : "The snapshot is up to date."
              }
            >
              <Chip
                size="small"
                variant="outlined"
                color={freshness.stale ? "warning" : "default"}
                label={
                  freshness.stale
                    ? `Stale · ${freshness.label}`
                    : `Updated ${freshness.label}`
                }
              />
            </Tooltip>
          )}
          {canPreview && onPreviewSnapshot && (
            <Tooltip title="Preview the materialized data">
              <span>
                <IconButton
                  size="small"
                  onClick={() => onPreviewSnapshot()}
                  disabled={previewing}
                >
                  <PreviewIcon size={18} strokeWidth={1.5} />
                </IconButton>
              </span>
            </Tooltip>
          )}
          <Tooltip title="Materialization schedule">
            <IconButton
              size="small"
              onClick={e => setScheduleAnchor(e.currentTarget)}
            >
              <ScheduleIcon size={18} strokeWidth={1.5} />
            </IconButton>
          </Tooltip>
          {showHistory && (
            <Tooltip title="Materialization history">
              <span>
                <IconButton
                  size="small"
                  onClick={e => openHistory(e.currentTarget)}
                  disabled={history.length === 0 && !onOpenHistory}
                >
                  <HistoryIcon size={18} strokeWidth={1.5} />
                </IconButton>
              </span>
            </Tooltip>
          )}
        </>
      )}

      <Popover
        open={Boolean(scheduleAnchor)}
        anchorEl={scheduleAnchor}
        onClose={() => setScheduleAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      >
        <Box sx={{ p: 1.5, width: 360 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Materialization settings
          </Typography>
          <MaterializationScheduleControls
            value={schedule}
            onChange={onScheduleChange}
            disabled={scheduleDisabled}
            caption={scheduleCaption}
          />
        </Box>
      </Popover>

      <Popover
        open={Boolean(historyAnchor)}
        anchorEl={historyAnchor}
        onClose={() => setHistoryAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      >
        <Box sx={{ p: 1.5, minWidth: 320, maxWidth: 460 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Materialization history
          </Typography>
          {history.length === 0 ? (
            <Typography variant="caption" color="text.secondary">
              No runs yet.
            </Typography>
          ) : (
            history.map((run, i) => {
              const durationMs = run.durationMs;
              return (
                <Box key={run.id}>
                  {i > 0 && <Divider sx={{ my: 0.5 }} />}
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    {run.status === "ready" ? (
                      <SuccessIcon
                        size={16}
                        strokeWidth={1.5}
                        style={{
                          color: "var(--mui-palette-success-main, green)",
                        }}
                      />
                    ) : (
                      <ErrorIcon
                        size={16}
                        strokeWidth={1.5}
                        style={{
                          color: "var(--mui-palette-error-main, crimson)",
                        }}
                      />
                    )}
                    <Typography variant="caption" sx={{ flex: 1 }}>
                      {new Date(run.at).toLocaleString()}
                    </Typography>
                    {run.status === "ready" && run.rowCount != null && (
                      <Typography variant="caption" color="text.secondary">
                        {run.rowCount.toLocaleString()} rows
                      </Typography>
                    )}
                    {durationMs != null && durationMs >= 0 && (
                      <Typography variant="caption" color="text.secondary">
                        {(durationMs / 1000).toFixed(1)}s
                      </Typography>
                    )}
                  </Box>
                  {run.error && (
                    <Typography
                      variant="caption"
                      color="error"
                      sx={{ display: "block", pl: 3, whiteSpace: "pre-wrap" }}
                    >
                      {run.error}
                    </Typography>
                  )}
                </Box>
              );
            })
          )}
        </Box>
      </Popover>
    </Box>
  );
}
