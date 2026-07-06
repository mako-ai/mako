import React from "react";
import {
  Box,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Typography,
} from "@mui/material";
import { MessageSquare, Trash2 } from "lucide-react";
import { streamingIndicatorDotSx } from "./streaming-indicator-styles";
import type { ChatSessionMeta } from "./hooks/useChatSessions";

interface ChatHistoryMenuProps {
  anchorEl: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  sessions: ChatSessionMeta[];
  currentChatId: string;
  isSessionStreaming: (session: ChatSessionMeta) => boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
}

/** Chat history dropdown: session list with live streaming indicators. */
export function ChatHistoryMenu({
  anchorEl,
  open,
  onClose,
  sessions,
  currentChatId,
  isSessionStreaming,
  onSelect,
  onDelete,
}: ChatHistoryMenuProps) {
  return (
    <Menu
      anchorEl={anchorEl}
      open={open}
      onClose={onClose}
      PaperProps={{
        sx: { maxHeight: 400, width: 300 },
      }}
    >
      {sessions
        .filter(
          session =>
            session._id === currentChatId ||
            isSessionStreaming(session) ||
            (session.title && session.title.length > 0),
        )
        .map(session => (
          <MenuItem
            key={session._id}
            onClick={() => onSelect(session._id)}
            selected={session._id === currentChatId}
            sx={{ display: "flex", justifyContent: "space-between" }}
          >
            <Box sx={{ display: "flex", alignItems: "center", flex: 1 }}>
              <ListItemIcon>
                {isSessionStreaming(session) ? (
                  // Turn in flight server-side — pulsing indicator instead
                  // of the static chat icon.
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 18,
                      height: 18,
                    }}
                  >
                    <Box sx={streamingIndicatorDotSx} />
                  </Box>
                ) : (
                  <MessageSquare size={18} />
                )}
              </ListItemIcon>
              <Box>
                <ListItemText
                  primary={session.title || session._id.substring(0, 8)}
                  secondary={
                    session.updatedAt
                      ? new Date(session.updatedAt).toLocaleString()
                      : session.createdAt
                        ? new Date(session.createdAt).toLocaleString()
                        : ""
                  }
                  primaryTypographyProps={{
                    noWrap: true,
                    sx: { maxWidth: 200 },
                  }}
                />
              </Box>
            </Box>
            {sessions.length > 1 && (
              <IconButton
                size="small"
                onClick={e => onDelete(session._id, e)}
                sx={{ ml: 1 }}
              >
                <Trash2 size={18} />
              </IconButton>
            )}
          </MenuItem>
        ))}
      {sessions.length === 0 && (
        <MenuItem disabled>
          <Typography variant="body2" color="text.secondary">
            No chat history yet
          </Typography>
        </MenuItem>
      )}
    </Menu>
  );
}
