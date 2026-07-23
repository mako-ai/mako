import { Chip, CircularProgress, Tooltip } from "@mui/material";
import { RefreshCw } from "lucide-react";

/**
 * Shared Refresh control for app + dashboard toolbars. Always means the same
 * thing: force-rebuild every data source / binding from upstream, wait until
 * all settle, then update the UI once.
 */
export default function ResourceRefreshControl({
  onClick,
  busy = false,
  disabled = false,
  /** Used in the tooltip — e.g. "binding" or "data source". */
  subject,
}: {
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  subject: "binding" | "data source";
}) {
  const isDisabled = disabled || busy;
  return (
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
  );
}
