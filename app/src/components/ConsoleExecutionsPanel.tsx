import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";

export interface ConsoleExecutionRow {
  id: string;
  executedAt: string;
  source: string;
  status: string;
  executionTimeMs: number;
  rowCount: number | null;
  errorType: string | null;
  apiKeyId: string | null;
}

interface ConsoleExecutionsPanelProps {
  loading: boolean;
  error?: string | null;
  executions: ConsoleExecutionRow[];
}

const sourceLabels: Record<string, string> = {
  console_ui: "App",
  console_ui_admin_override: "App (admin)",
  api: "API",
  mcp: "MCP",
  agent: "Agent",
  flow: "Flow",
  scheduled_query: "Schedule",
};

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export default function ConsoleExecutionsPanel({
  loading,
  error,
  executions,
}: ConsoleExecutionsPanelProps) {
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

  if (executions.length === 0) {
    return (
      <Box sx={{ p: 3 }}>
        <Typography variant="body2" color="text.secondary">
          No executions recorded in the last 90 days.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ height: "100%", overflow: "auto" }}>
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            <TableCell>When</TableCell>
            <TableCell>Source</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Duration</TableCell>
            <TableCell align="right">Rows</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {executions.map(execution => (
            <TableRow key={execution.id} hover>
              <TableCell sx={{ whiteSpace: "nowrap" }}>
                {new Date(execution.executedAt).toLocaleString()}
              </TableCell>
              <TableCell>
                <Chip
                  label={sourceLabels[execution.source] || execution.source}
                  size="small"
                  variant="outlined"
                  color={
                    execution.source === "api" || execution.source === "mcp"
                      ? "primary"
                      : "default"
                  }
                />
              </TableCell>
              <TableCell>
                <Typography
                  variant="body2"
                  color={
                    execution.status === "success"
                      ? "success.main"
                      : execution.status === "cancelled"
                        ? "text.secondary"
                        : "error.main"
                  }
                >
                  {execution.status}
                  {execution.errorType ? ` (${execution.errorType})` : ""}
                </Typography>
              </TableCell>
              <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                {formatDuration(execution.executionTimeMs)}
              </TableCell>
              <TableCell align="right">{execution.rowCount ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}
