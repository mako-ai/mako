import {
  Alert,
  Box,
  CircularProgress,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import type { ScheduledQueryRunItem } from "../lib/api-types";
import {
  ResultBadge,
  SpinnerRingBadge,
  StatusPill,
  type BuiPillTone,
} from "./bui-status";

const STATUS_TONE: Record<ScheduledQueryRunItem["status"], BuiPillTone> = {
  queued: "neutral",
  running: "accent",
  success: "green",
  error: "red",
};

const STATUS_LABEL: Record<ScheduledQueryRunItem["status"], string> = {
  queued: "Queued",
  running: "Running",
  success: "Completed",
  error: "Failed",
};

interface ScheduledRunsPanelProps {
  loading: boolean;
  error?: string | null;
  runs: ScheduledQueryRunItem[];
}

export default function ScheduledRunsPanel({
  loading,
  error,
  runs,
}: ScheduledRunsPanelProps) {
  if (loading) {
    return (
      <Box sx={{ height: "100%", display: "grid", placeItems: "center" }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  if (error) {
    return <Alert severity="error">{error}</Alert>;
  }

  if (runs.length === 0) {
    return (
      <Box sx={{ p: 3 }}>
        <Typography variant="body2" color="text.secondary">
          No scheduled runs yet.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ height: "100%", overflow: "auto" }}>
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            <TableCell>Triggered</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Duration</TableCell>
            <TableCell>Rows</TableCell>
            <TableCell>Trigger</TableCell>
            <TableCell>Error</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {runs.map(run => (
            <TableRow key={run.id} hover>
              <TableCell>
                {new Date(run.triggeredAt).toLocaleString()}
              </TableCell>
              <TableCell>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  {run.status === "running" ? (
                    <SpinnerRingBadge size={16} />
                  ) : (
                    <ResultBadge
                      size={16}
                      tone={
                        run.status === "success"
                          ? "green"
                          : run.status === "error"
                            ? "red"
                            : "neutral"
                      }
                    />
                  )}
                  <StatusPill tone={STATUS_TONE[run.status]}>
                    {STATUS_LABEL[run.status]}
                  </StatusPill>
                </Box>
              </TableCell>
              <TableCell>
                {typeof run.durationMs === "number"
                  ? `${(run.durationMs / 1000).toFixed(1)}s`
                  : "-"}
              </TableCell>
              <TableCell>{run.rowCount ?? run.rowsAffected ?? "-"}</TableCell>
              <TableCell>{run.triggerType}</TableCell>
              <TableCell
                sx={{
                  maxWidth: 320,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {run.error?.message || "-"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}
