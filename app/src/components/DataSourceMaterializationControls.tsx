import { useCallback, useState, type ReactNode } from "react";
import {
  Box,
  Typography,
  Button,
  Chip,
  Tooltip,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Popover,
  Divider,
} from "@mui/material";
import {
  RefreshCw as RefreshIcon,
  CalendarClock as ScheduleIcon,
  History as HistoryIcon,
  Eye as PreviewIcon,
  CheckCircle2 as SuccessIcon,
  XCircle as ErrorIcon,
  MoreVertical as MoreIcon,
} from "lucide-react";
import MaterializationScheduleControls from "./MaterializationScheduleControls";
import type { MaterializationScheduleValue } from "../lib/materializationSchedule";
import { formatRelativeTimeCompact } from "../utils/relative-time";

/**
 * Shared materialization toolbar for app data bindings and dashboard data
 * sources. Both surfaces present the same controls — Refresh button, one
 * combined status/freshness chip, and a ⋮ menu holding the snapshot preview,
 * schedule, and history — so the two editors look and behave identically and
 * the (already crowded) data-source toolbar keeps a small footprint.
 * Surface-specific wiring (where the schedule/cache live, how history is
 * loaded) is passed in.
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
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
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

  // Freshness: only meaningful once a snapshot exists. Stale when the
  // artifact is older than the freshness window (default 24h, matching the
  // dashboard canvas badge).
  let freshness: { label: string; stale: boolean } | null = null;
  if (buildStatus === "ready" && builtAtMs) {
    const ageMs = Date.now() - builtAtMs;
    const ttl = dataFreshnessTtlMs ?? DEFAULT_FRESHNESS_TTL_MS;
    freshness = {
      label: formatRelativeTimeCompact(builtAtMs),
      stale: ageMs > ttl,
    };
  }

  // One combined chip carries build status + row count + freshness (the old
  // separate chips ate too much toolbar width on normal screens).
  let statusChip: {
    label: string;
    color: "success" | "error" | "warning" | "default";
    tooltip: string;
  } | null = null;
  if (buildStatus === "ready") {
    const rows = rowCount != null ? `${rowCount.toLocaleString()} rows` : null;
    const age = freshness
      ? freshness.stale
        ? `stale · ${freshness.label}`
        : freshness.label
      : null;
    statusChip = {
      label: [rows, age].filter(Boolean).join(" · ") || "ready",
      color: freshness?.stale ? "warning" : "success",
      tooltip: freshness?.stale
        ? "The snapshot is older than its freshness window — click Refresh."
        : "The snapshot is up to date.",
    };
  } else if (buildStatus) {
    statusChip = {
      label: buildStatus,
      color: buildStatus === "error" ? "error" : "default",
      tooltip:
        buildStatus === "error"
          ? "The last materialization failed — see the history for details."
          : "Snapshot build status.",
    };
  }

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, ml: 1 }}>
      {leadingControls}

      {showMaterializeControls && (
        <>
          <Tooltip title="Refresh this query's data from source">
            <span>
              <Button
                size="small"
                variant="outlined"
                color="inherit"
                startIcon={<RefreshIcon size={16} strokeWidth={1.5} />}
                onClick={onMaterialize}
                disabled={materializing}
              >
                {materializing ? "Refreshing…" : "Refresh"}
              </Button>
            </span>
          </Tooltip>
          {statusChip && (
            <Tooltip title={statusChip.tooltip}>
              <Chip
                size="small"
                variant="outlined"
                color={statusChip.color}
                label={statusChip.label}
              />
            </Tooltip>
          )}
          <Tooltip title="Snapshot options">
            <IconButton
              size="small"
              onClick={e => setMenuAnchor(e.currentTarget)}
            >
              <MoreIcon size={18} strokeWidth={1.5} />
            </IconButton>
          </Tooltip>
          <Menu
            anchorEl={menuAnchor}
            open={!!menuAnchor}
            onClose={() => setMenuAnchor(null)}
          >
            {onPreviewSnapshot && (
              <MenuItem
                disabled={!canPreview || previewing}
                onClick={() => {
                  setMenuAnchor(null);
                  onPreviewSnapshot();
                }}
              >
                <ListItemIcon>
                  <PreviewIcon size={16} strokeWidth={1.5} />
                </ListItemIcon>
                <ListItemText
                  primary="Preview snapshot"
                  secondary={canPreview ? undefined : "Refresh the data first"}
                />
              </MenuItem>
            )}
            {/* Popovers anchor on the ⋮ button (menuAnchor): menu items
                unmount when the menu closes, so they can't be anchors. */}
            <MenuItem
              onClick={() => {
                setScheduleAnchor(menuAnchor);
                setMenuAnchor(null);
              }}
            >
              <ListItemIcon>
                <ScheduleIcon size={16} strokeWidth={1.5} />
              </ListItemIcon>
              <ListItemText>Schedule…</ListItemText>
            </MenuItem>
            {showHistory && (
              <MenuItem
                disabled={history.length === 0 && !onOpenHistory}
                onClick={() => {
                  if (menuAnchor) openHistory(menuAnchor);
                  setMenuAnchor(null);
                }}
              >
                <ListItemIcon>
                  <HistoryIcon size={16} strokeWidth={1.5} />
                </ListItemIcon>
                <ListItemText>History…</ListItemText>
              </MenuItem>
            )}
          </Menu>
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
