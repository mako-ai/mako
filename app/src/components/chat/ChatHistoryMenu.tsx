import React from "react";
import {
  Box,
  IconButton,
  InputAdornment,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Menu,
  MenuItem,
  TextField,
  Typography,
} from "@mui/material";
import { MessageSquare, Search, Trash2 } from "lucide-react";
import { streamingIndicatorDotSx } from "./streaming-indicator-styles";
import { formatCostUsd } from "./response-cost";
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

/** Above this many sessions the list stops being scannable — offer search. */
const SEARCH_THRESHOLD = 8;

const UNTITLED_LABEL = "New chat";

type BucketKey = "today" | "yesterday" | "week" | "older" | "undated";

const BUCKET_LABELS: Record<BucketKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Previous 7 days",
  older: "Older",
  undated: "No date",
};

const BUCKET_ORDER: BucketKey[] = [
  "today",
  "yesterday",
  "week",
  "older",
  "undated",
];

/** The session's own clock: `updatedAt` when present, else `createdAt`. */
function sessionTimestamp(session: ChatSessionMeta): number | null {
  const raw = session.updatedAt ?? session.createdAt;
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Local-midnight bucketing, so "Today" means the reader's today. */
function bucketFor(timestamp: number | null, now: number): BucketKey {
  if (timestamp === null) return "undated";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayStart = startOfToday.getTime();
  if (timestamp >= dayStart) return "today";
  if (timestamp >= dayStart - 86_400_000) return "yesterday";
  if (timestamp >= dayStart - 7 * 86_400_000) return "week";
  return "older";
}

/** "2h ago" beats a full locale timestamp for a list you scan. */
function formatRelativeTime(timestamp: number | null, now: number): string {
  if (timestamp === null) return "";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Non-zero spend only — a $0.00 chip is noise on a chat that never ran. */
function sessionCostLabel(session: ChatSessionMeta): string | null {
  const cost = session.usage?.costUsd;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) {
    return null;
  }
  return formatCostUsd(cost);
}

function sessionTitle(session: ChatSessionMeta): string {
  const title = session.title?.trim();
  return title && title.length > 0 ? title : UNTITLED_LABEL;
}

/**
 * Chat history dropdown: every session (titled or not), grouped by day,
 * searchable, with its spend and live streaming indicator.
 */
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
  const [query, setQuery] = React.useState("");

  // Reset the filter each time the menu opens: a stale query would hide
  // chats that the user never chose to hide.
  React.useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  // One clock reading per open, so relative labels inside a single render
  // pass agree with each other.
  const now = React.useMemo(
    () => Date.now(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, sessions],
  );

  const showSearch = sessions.length > SEARCH_THRESHOLD;

  const groups = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = needle
      ? sessions.filter(session =>
          sessionTitle(session).toLowerCase().includes(needle),
        )
      : sessions;

    const buckets = new Map<BucketKey, ChatSessionMeta[]>();
    for (const session of matching) {
      const key = bucketFor(sessionTimestamp(session), now);
      const list = buckets.get(key);
      if (list) list.push(session);
      else buckets.set(key, [session]);
    }
    for (const list of buckets.values()) {
      // Newest first inside each bucket; undated sessions keep server order.
      list.sort(
        (a, b) => (sessionTimestamp(b) ?? 0) - (sessionTimestamp(a) ?? 0),
      );
    }
    return BUCKET_ORDER.filter(key => (buckets.get(key)?.length ?? 0) > 0).map(
      key => ({ key, sessions: buckets.get(key) as ChatSessionMeta[] }),
    );
  }, [sessions, query, now]);

  const hasResults = groups.length > 0;

  return (
    <Menu
      anchorEl={anchorEl}
      open={open}
      onClose={onClose}
      autoFocus={!showSearch}
      slotProps={{
        paper: { sx: { maxHeight: 460, width: 340 } },
        list: { dense: false },
      }}
    >
      {showSearch && (
        <Box sx={{ px: 1.5, pt: 0.5, pb: 1 }}>
          <TextField
            autoFocus
            fullWidth
            size="small"
            value={query}
            placeholder="Search chats"
            onChange={event => setQuery(event.target.value)}
            // The MUI Menu's own typeahead steals single keystrokes and
            // would move focus between items as you type.
            onKeyDown={event => event.stopPropagation()}
            slotProps={{
              htmlInput: { "aria-label": "Search chats" },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <Search size={14} />
                  </InputAdornment>
                ),
              },
            }}
          />
        </Box>
      )}

      {sessions.length === 0 && (
        <MenuItem disabled>
          <Typography variant="body2" color="text.secondary">
            No chat history yet
          </Typography>
        </MenuItem>
      )}

      {sessions.length > 0 && !hasResults && (
        <MenuItem disabled>
          <Typography variant="body2" color="text.secondary">
            No chats match “{query.trim()}”
          </Typography>
        </MenuItem>
      )}

      {groups.flatMap(group => [
        <ListSubheader
          key={`subheader-${group.key}`}
          disableSticky
          sx={{
            lineHeight: "24px",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.4,
            textTransform: "uppercase",
            color: "var(--bui-ink-3)",
            backgroundColor: "transparent",
          }}
        >
          {BUCKET_LABELS[group.key]}
        </ListSubheader>,
        ...group.sessions.map(session => {
          const title = sessionTitle(session);
          const cost = sessionCostLabel(session);
          const relative = formatRelativeTime(sessionTimestamp(session), now);
          const streaming = isSessionStreaming(session);

          return (
            <MenuItem
              key={session._id}
              onClick={() => onSelect(session._id)}
              selected={session._id === currentChatId}
              sx={{
                display: "flex",
                alignItems: "flex-start",
                gap: 0.5,
                "&:hover .chat-history-delete, &:focus-visible .chat-history-delete, & .chat-history-delete:focus-visible":
                  { opacity: 1 },
              }}
            >
              <Box
                sx={{
                  display: "flex",
                  alignItems: "flex-start",
                  flex: 1,
                  minWidth: 0,
                }}
              >
                <ListItemIcon sx={{ mt: 0.25 }}>
                  {streaming ? (
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
                <ListItemText
                  primary={title}
                  secondary={
                    <Box
                      component="span"
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 0.75,
                      }}
                    >
                      <Box component="span">{relative}</Box>
                      {cost && (
                        <Box
                          component="span"
                          sx={{
                            fontVariantNumeric: "tabular-nums",
                            color: "var(--bui-ink-3)",
                          }}
                        >
                          {cost}
                        </Box>
                      )}
                    </Box>
                  }
                  slotProps={{
                    primary: {
                      sx: {
                        display: "-webkit-box",
                        WebkitBoxOrient: "vertical",
                        WebkitLineClamp: 2,
                        overflow: "hidden",
                        whiteSpace: "normal",
                        wordBreak: "break-word",
                        fontStyle:
                          title === UNTITLED_LABEL ? "italic" : undefined,
                        color:
                          title === UNTITLED_LABEL
                            ? "var(--bui-ink-2)"
                            : "var(--bui-ink)",
                      },
                    },
                    secondary: { sx: { fontSize: 11 } },
                  }}
                />
              </Box>
              {sessions.length > 1 && (
                <IconButton
                  className="chat-history-delete"
                  size="small"
                  aria-label={`Delete chat “${title}”`}
                  onClick={e => onDelete(session._id, e)}
                  sx={{
                    ml: 1,
                    mt: 0.25,
                    flexShrink: 0,
                    opacity: 0,
                    transition: "opacity 120ms ease",
                    color: "var(--bui-ink-3)",
                    "&:hover": {
                      color: "var(--bui-red)",
                      backgroundColor: "var(--bui-red-tint)",
                    },
                    "&:focus-visible": { opacity: 1 },
                  }}
                >
                  <Trash2 size={16} />
                </IconButton>
              )}
            </MenuItem>
          );
        }),
      ])}
    </Menu>
  );
}
