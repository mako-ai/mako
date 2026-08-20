import { useEffect, useState } from "react";
import { Chip, CircularProgress, Tooltip, Typography } from "@mui/material";
import { RefreshCw } from "lucide-react";
import { formatRelativeTime } from "../utils/relative-time";

/**
 * Muted "Updated X ago" caption for the app/dashboard toolbars, ticking so it
 * never goes stale on a long-lived tab. Renders nothing when the timestamp is
 * unknown (e.g. live-only bindings, never-materialized sources). Exported
 * standalone so viewers without the Refresh action still see data freshness.
 */
export function LastRefreshedLabel({
  lastRefreshedAt,
}: {
  lastRefreshedAt?: string | null;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!lastRefreshedAt) return;
    const id = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, [lastRefreshedAt]);

  const label = formatRelativeTime(lastRefreshedAt);
  if (!label || !lastRefreshedAt) return null;
  return (
    <Tooltip
      title={`Data last refreshed ${new Date(lastRefreshedAt).toLocaleString()}`}
    >
      <Typography
        variant="caption"
        color="text.secondary"
        noWrap
        sx={{ flexShrink: 0, mr: 0.5 }}
      >
        Updated {label}
      </Typography>
    </Tooltip>
  );
}

/**
 * Shared Refresh control for app + dashboard toolbars. Always means the same
 * thing: force-rebuild every data source / binding from upstream, wait until
 * all settle, then update the UI once. When `lastRefreshedAt` is provided, a
 * muted "Updated X ago" caption precedes the chip.
 */
export default function ResourceRefreshControl({
  onClick,
  busy = false,
  disabled = false,
  /** Used in the tooltip — e.g. "binding" or "data source". */
  subject,
  /** ISO timestamp of the oldest materialized artifact, if known. */
  lastRefreshedAt,
}: {
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  subject: "binding" | "data source";
  lastRefreshedAt?: string | null;
}) {
  const isDisabled = disabled || busy;
  return (
    <>
      {!busy && <LastRefreshedLabel lastRefreshedAt={lastRefreshedAt} />}
      <Tooltip title={`Refresh data from source (waits for every ${subject})`}>
        <span>
          <Chip
            icon={
              busy ? (
                <CircularProgress size={14} color="inherit" />
              ) : (
                <RefreshCw size={14} />
              )
            }
            label={busy ? "Refreshing…" : "Refresh"}
            size="small"
            variant="outlined"
            onClick={onClick}
            disabled={isDisabled}
            sx={{ cursor: isDisabled ? "default" : "pointer" }}
          />
        </span>
      </Tooltip>
    </>
  );
}
