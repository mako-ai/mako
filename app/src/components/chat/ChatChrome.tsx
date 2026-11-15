import { Alert, Box, IconButton, Tooltip, Typography } from "@mui/material";
import { Check, ChevronDown, Copy, History, Plus, X } from "lucide-react";
import { UpgradePrompt } from "../UpgradePrompt";
import { describeChatError } from "./chat-helpers";

// Claude-style floating round button used in the mobile pane headers. Each
// control carries its own paper fill + blur + hairline so it reads as floating
// chrome over the content rather than sitting in a solid app bar.
const MOBILE_FLOAT_BTN_SX = {
  width: 38,
  height: 38,
  borderRadius: "50%",
  color: "text.secondary",
  bgcolor: "background.paper",
  border: 1,
  borderColor: "divider",
  boxShadow: "0 1px 3px rgba(0, 0, 0, 0.08)",
  backdropFilter: "blur(8px)",
  "&:hover": { bgcolor: "action.hover" },
} as const;

interface ChatHeaderProps {
  isMobile: boolean;
  copied: boolean;
  canCopy: boolean;
  onCopy: () => void;
  onNewChat: () => void;
  onOpenHistory: (event: React.MouseEvent<HTMLElement>) => void;
  onClose: () => void;
}

/**
 * Header with copy / new chat / history (and close on desktop). On mobile
 * this is Claude-style floating chrome: a transparent strip with round
 * buttons on the right. Desktop keeps the bordered title bar.
 */
export function ChatHeader({
  isMobile,
  copied,
  canCopy,
  onCopy,
  onNewChat,
  onOpenHistory,
  onClose,
}: ChatHeaderProps) {
  const buttonSize = isMobile ? "medium" : "small";
  const buttonSx = isMobile ? MOBILE_FLOAT_BTN_SX : undefined;
  return (
    <Box
      sx={{
        px: 1,
        py: isMobile ? 0.75 : 0.25,
        minHeight: isMobile ? 52 : 37,
        borderBottom: isMobile ? 0 : 1,
        borderColor: "divider",
      }}
    >
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          height: "100%",
          minHeight: 32,
        }}
      >
        <Box
          sx={{
            flexGrow: 1,
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            gap: 1,
          }}
        >
          {/* On mobile the explorer is the Browse tab, so the header's
              left side is empty: floating actions on the right only. */}
          {!isMobile && (
            <Typography
              variant="h6"
              sx={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              Chat
            </Typography>
          )}
        </Box>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: isMobile ? 1 : 0.5,
          }}
        >
          <Tooltip title={copied ? "Copied!" : "Copy chat history as JSON"}>
            <span>
              <IconButton
                size={buttonSize}
                aria-label="Copy chat history as JSON"
                onClick={onCopy}
                disabled={!canCopy}
                sx={buttonSx}
              >
                {copied ? <Check size={20} /> : <Copy size={20} />}
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="New chat">
            <IconButton
              size={buttonSize}
              aria-label="New chat"
              onClick={onNewChat}
              sx={buttonSx}
            >
              <Plus size={20} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Chat history">
            <IconButton
              size={buttonSize}
              aria-label="Chat history"
              onClick={onOpenHistory}
              sx={buttonSx}
            >
              <History size={20} />
            </IconButton>
          </Tooltip>
          {/* Desktop only: on mobile the chat is a tab, not a pane. The
              sidebar shows an "Open Chat" button while the pane is closed. */}
          {!isMobile && (
            <Tooltip title="Close chat">
              <IconButton
                size="small"
                aria-label="Close chat"
                onClick={onClose}
              >
                <X size={20} />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      </Box>
    </Box>
  );
}

/** Error display — billing errors get an upgrade prompt. */
export function ChatErrorBanner({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  const display = describeChatError(message);
  return (
    <Box sx={{ p: 1 }}>
      {display.kind === "upgrade" ? (
        <UpgradePrompt
          errorCode={display.errorCode}
          message={display.message}
          plan={display.plan}
          currentUsageUsd={display.currentUsageUsd}
          quotaUsd={display.quotaUsd}
        />
      ) : (
        <Alert
          severity="error"
          onClose={onClose}
          sx={{
            fontSize: "0.875rem",
            maxHeight: 200,
            overflowY: "auto",
            "& .MuiAlert-message": {
              overflow: "auto",
            },
          }}
        >
          {display.message}
        </Alert>
      )}
    </Box>
  );
}

/** Floating "scroll to latest" button over the message list. */
export function ScrollToLatestButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip title="Scroll to latest" placement="top">
      <IconButton
        aria-label="Scroll to latest message"
        onClick={onClick}
        size="small"
        sx={{
          position: "absolute",
          bottom: 8,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 1,
          backgroundColor: "background.paper",
          border: 1,
          borderColor: "divider",
          boxShadow: 2,
          "&:hover": { backgroundColor: "action.hover" },
          width: 32,
          height: 32,
        }}
      >
        <ChevronDown size={18} />
      </IconButton>
    </Tooltip>
  );
}
