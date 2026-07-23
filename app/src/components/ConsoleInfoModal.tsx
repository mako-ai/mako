import { useCallback, useEffect, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Typography,
  Stack,
  IconButton,
  Skeleton,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from "@mui/material";
import { ContentCopy } from "@mui/icons-material";
import { useConsoleStore } from "../store/consoleStore";

interface ConsoleInfoModalProps {
  open: boolean;
  onClose: () => void;
  consoleId: string;
  workspaceId?: string;
}

interface ConsoleDetails {
  description?: string;
  ownerDisplayName?: string;
  owner_id?: string;
  access?: string;
  createdAt?: string;
  updatedAt?: string;
  executionCount?: number;
  lastExecutedAt?: string;
}

interface ConsoleExecutionLog {
  id: string;
  executedAt: string;
  source: string;
  status: string;
  executionTimeMs: number;
  rowCount: number | null;
  errorType: string | null;
  apiKeyId: string | null;
}

interface MonospaceFieldProps {
  value: string;
  onCopy?: () => void;
  disabled?: boolean;
}

const MonospaceField = ({ value, onCopy, disabled }: MonospaceFieldProps) => {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
      <Typography
        variant="body2"
        sx={{
          fontFamily: "monospace",
          backgroundColor: "action.selected",
          px: 1,
          py: 0.5,
          borderRadius: 1,
          flex: 1,
          overflowX: "auto",
          fontSize: "0.875rem",
        }}
      >
        {value}
      </Typography>
      {onCopy && (
        <IconButton
          size="small"
          onClick={onCopy}
          title="Copy to clipboard"
          disabled={disabled}
          sx={{ p: 0.5 }}
        >
          <ContentCopy sx={{ fontSize: 18 }} />
        </IconButton>
      )}
    </Box>
  );
};

const accessLabels: Record<string, string> = {
  private: "Private",
  workspace: "Shared with workspace",
};

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

function formatExecutedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function ConsoleInfoModal({
  open,
  onClose,
  consoleId,
  workspaceId,
}: ConsoleInfoModalProps) {
  const fetchConsoleDetails = useConsoleStore(s => s.fetchConsoleDetails);
  const fetchConsoleExecutions = useConsoleStore(s => s.fetchConsoleExecutions);
  const [details, setDetails] = useState<ConsoleDetails | null>(null);
  const [executions, setExecutions] = useState<ConsoleExecutionLog[]>([]);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [loadingExecutions, setLoadingExecutions] = useState(false);

  const handleCopyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
  }, []);

  useEffect(() => {
    if (!open || !workspaceId || !consoleId) {
      setDetails(null);
      setExecutions([]);
      return;
    }

    let cancelled = false;
    setLoadingDetails(true);
    setLoadingExecutions(true);

    void fetchConsoleDetails(workspaceId, consoleId)
      .then(consoleDetails => {
        if (!cancelled) setDetails(consoleDetails);
      })
      .finally(() => {
        if (!cancelled) setLoadingDetails(false);
      });

    void fetchConsoleExecutions(workspaceId, consoleId, { limit: 10 })
      .then(rows => {
        if (!cancelled) setExecutions(rows);
      })
      .finally(() => {
        if (!cancelled) setLoadingExecutions(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    open,
    workspaceId,
    consoleId,
    fetchConsoleDetails,
    fetchConsoleExecutions,
  ]);

  const apiEndpoint = `/workspaces/${workspaceId || ":id"}/consoles/${consoleId}/execute`;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>Console Information</DialogTitle>
      <DialogContent sx={{ pt: 1 }}>
        <Stack spacing={2}>
          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
              Console ID
            </Typography>
            <MonospaceField
              value={consoleId}
              onCopy={() => handleCopyToClipboard(consoleId)}
            />
          </Box>

          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
              Workspace ID
            </Typography>
            <MonospaceField
              value={workspaceId || "N/A"}
              onCopy={
                workspaceId
                  ? () => handleCopyToClipboard(workspaceId)
                  : undefined
              }
              disabled={!workspaceId}
            />
          </Box>

          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
              Description
            </Typography>
            {loadingDetails ? (
              <Skeleton variant="text" width="80%" height={24} />
            ) : (
              <Typography
                variant="body2"
                sx={
                  details?.description
                    ? { fontStyle: "italic" }
                    : { color: "text.disabled" }
                }
              >
                {details?.description || "No description"}
              </Typography>
            )}
          </Box>

          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
              Created by
            </Typography>
            {loadingDetails ? (
              <Skeleton variant="text" width="60%" height={24} />
            ) : (
              <Typography variant="body2">
                {details?.ownerDisplayName || details?.owner_id || "Unknown"}
              </Typography>
            )}
          </Box>

          {details?.access && (
            <Box>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mb: 0.5 }}
              >
                Access
              </Typography>
              <Chip
                label={accessLabels[details.access] || details.access}
                size="small"
                variant="outlined"
              />
            </Box>
          )}

          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
              API Endpoint
            </Typography>
            <MonospaceField
              value={apiEndpoint}
              onCopy={() => handleCopyToClipboard(apiEndpoint)}
            />
          </Box>

          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Recent executions
            </Typography>
            {loadingExecutions ? (
              <Stack spacing={0.5}>
                <Skeleton variant="rounded" height={28} />
                <Skeleton variant="rounded" height={28} />
                <Skeleton variant="rounded" height={28} />
              </Stack>
            ) : executions.length === 0 ? (
              <Typography variant="body2" color="text.disabled">
                No executions recorded in the last 90 days.
              </Typography>
            ) : (
              <Box
                sx={{
                  border: 1,
                  borderColor: "divider",
                  borderRadius: 1,
                  overflow: "hidden",
                }}
              >
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>When</TableCell>
                      <TableCell>Source</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell align="right">Duration</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {executions.map(execution => (
                      <TableRow key={execution.id}>
                        <TableCell sx={{ whiteSpace: "nowrap" }}>
                          {formatExecutedAt(execution.executedAt)}
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={
                              sourceLabels[execution.source] || execution.source
                            }
                            size="small"
                            variant="outlined"
                            color={
                              execution.source === "api" ||
                              execution.source === "mcp"
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
                            {execution.errorType
                              ? ` (${execution.errorType})`
                              : ""}
                          </Typography>
                        </TableCell>
                        <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                          {formatDuration(execution.executionTimeMs)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            )}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
