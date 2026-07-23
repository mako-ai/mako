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
import {
  consoleExecutionSourceLabel,
  isExternalConsoleExecutionSource,
} from "../lib/console-execution-source";

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

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function TriggerSourceCell({
  source,
  apiKeyId,
}: {
  source: string;
  apiKeyId: string | null;
}) {
  const label = consoleExecutionSourceLabel(source);
  const external = isExternalConsoleExecutionSource(source);
  const keySuffix =
    apiKeyId && (source === "api" || source === "mcp")
      ? ` · key …${apiKeyId.slice(-6)}`
      : "";

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
      <Chip
        label={label}
        size="small"
        color={external ? "primary" : "default"}
        variant={external ? "filled" : "outlined"}
        sx={{
          alignSelf: "flex-start",
          fontWeight: external ? 600 : 500,
        }}
      />
      {keySuffix ? (
        <Typography variant="caption" color="text.secondary">
          {keySuffix.replace(/^ · /, "")}
        </Typography>
      ) : null}
    </Box>
  );
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
            <TableCell>Trigger</TableCell>
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
                <TriggerSourceCell
                  source={execution.source}
                  apiKeyId={execution.apiKeyId}
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
