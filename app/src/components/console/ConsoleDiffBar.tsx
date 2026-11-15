import { Alert, Box, Button, CircularProgress, Fab } from "@mui/material";
import { PlayArrow as PlayIcon } from "@mui/icons-material";
import {
  Check as CheckIcon,
  X as CloseIcon,
  Square as StopIcon,
} from "lucide-react";

/** Accept / reject bar shown under the toolbar while reviewing an AI diff. */
export function ConsoleDiffBar({
  onAccept,
  onReject,
}: {
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        px: 1,
        pb: 1,
        backgroundColor: "background.paper",
        gap: 0.5,
        justifyContent: "space-between",
      }}
    >
      <Alert
        severity="info"
        sx={{
          p: 0,
          pl: 1,
          pr: 2,
          "& .MuiAlert-icon": {
            fontSize: "1.25rem",
          },
        }}
      >
        AI suggested changes - Review the diff below
      </Alert>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Button
          variant="contained"
          color="success"
          size="small"
          startIcon={<CheckIcon strokeWidth={2} size={22} />}
          onClick={onAccept}
          disableElevation
        >
          Accept
        </Button>
        <Button
          variant="outlined"
          color="error"
          size="small"
          startIcon={<CloseIcon strokeWidth={2} size={22} />}
          onClick={onReject}
          disableElevation
        >
          Reject
        </Button>
      </Box>
    </Box>
  );
}

/**
 * Mobile run FAB — the primary "execute" affordance on a phone, where the
 * toolbar Run button is compact and the keyboard shortcut is unavailable.
 */
export function ConsoleRunFab({
  isExecuting,
  isCancelling,
  canRun,
  onExecute,
  onCancel,
}: {
  isExecuting: boolean;
  isCancelling?: boolean;
  canRun: boolean;
  onExecute: () => void;
  onCancel?: () => void;
}) {
  return (
    <Fab
      color={isExecuting ? "error" : "primary"}
      aria-label={isExecuting ? "Cancel query" : "Run query"}
      onClick={isExecuting ? onCancel : onExecute}
      disabled={isExecuting ? isCancelling : !canRun}
      sx={{
        position: "absolute",
        right: 16,
        bottom: "calc(16px + env(safe-area-inset-bottom))",
        zIndex: 5,
      }}
    >
      {isExecuting ? (
        isCancelling ? (
          <CircularProgress size={24} color="inherit" />
        ) : (
          <StopIcon size={22} />
        )
      ) : (
        <PlayIcon />
      )}
    </Fab>
  );
}
