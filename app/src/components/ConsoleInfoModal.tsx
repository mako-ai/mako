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
} from "@mui/material";
import { ContentCopy } from "@mui/icons-material";
import { apiClient } from "../lib/api-client";

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

export default function ConsoleInfoModal({
  open,
  onClose,
  consoleId,
  workspaceId,
}: ConsoleInfoModalProps) {
  const [details, setDetails] = useState<ConsoleDetails | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  const handleCopyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
  }, []);

  useEffect(() => {
    if (!open || !workspaceId || !consoleId) {
      setDetails(null);
      return;
    }

    let cancelled = false;
    setLoadingDetails(true);

    apiClient
      .get<{ success: boolean; console?: ConsoleDetails }>(
        `/workspaces/${workspaceId}/consoles/${consoleId}/details`,
      )
      .then(data => {
        if (!cancelled && data.console) {
          setDetails(data.console);
        }
      })
      .catch(() => {
        // Ignore errors for details fetch
      })
      .finally(() => {
        if (!cancelled) setLoadingDetails(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, consoleId]);

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
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
