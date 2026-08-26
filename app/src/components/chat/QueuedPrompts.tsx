import React, { useState } from "react";
import { Box, IconButton, Tooltip, Typography } from "@mui/material";
import { keyframes } from "@mui/material/styles";
import { ArrowUp, ChevronDown, Circle, Pencil, Trash2 } from "lucide-react";
import type { FileUIPart } from "ai";

// Queue card slides up from behind the chat input as it reveals
const queueSlideUp = keyframes`
  from { opacity: 0; transform: translateY(100%); }
  to { opacity: 1; transform: translateY(0); }
`;

export interface QueuedPrompt {
  id: string;
  text: string;
  files?: FileUIPart[];
  consoleId: string | null;
  dashboardId: string | null;
}

interface QueuedPromptListProps {
  prompts: QueuedPrompt[];
  editingId: string | null;
  onStartEdit: (id: string) => void;
  onSendNow: (id: string) => void;
  onRemove: (id: string) => void;
}

interface QueuedPromptRowProps {
  prompt: QueuedPrompt;
  isEditing: boolean;
  onStartEdit: (id: string) => void;
  onSendNow: (id: string) => void;
  onRemove: (id: string) => void;
}

const QUEUED_ROW_ACTION_BTN_SX = {
  width: 22,
  height: 22,
  flexShrink: 0,
  color: "var(--bui-ink-3)",
  "&:hover": {
    color: "var(--bui-ink)",
    backgroundColor: "var(--bui-hover-2)",
  },
} as const;

// One queued prompt. Editing happens in the main composer (Cursor-style), so
// the row itself only renders the prompt + hover actions.
const QueuedPromptRow = React.memo(
  ({
    prompt,
    isEditing,
    onStartEdit,
    onSendNow,
    onRemove,
  }: QueuedPromptRowProps) => {
    const imageCount = prompt.files?.length ?? 0;
    const display = prompt.text || (imageCount > 0 ? "Image attachment" : "");

    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1,
          py: 0.5,
          borderRadius: "8px",
          minHeight: 32,
          transition: "background-color 0.1s",
          backgroundColor: isEditing ? "var(--bui-hover-2)" : "transparent",
          "&:hover": {
            backgroundColor: isEditing
              ? "var(--bui-hover-2)"
              : "var(--bui-hover)",
          },
          "&:hover .queued-prompt-actions": { opacity: 1 },
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            color: "var(--bui-ink-3)",
            flexShrink: 0,
          }}
        >
          <Circle size={10} />
        </Box>

        <Typography
          variant="body2"
          sx={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 13,
            color: "var(--bui-ink)",
          }}
        >
          {display}
        </Typography>

        {imageCount > 0 && (
          <Typography
            variant="caption"
            sx={{ color: "var(--bui-ink-3)", flexShrink: 0 }}
          >
            {imageCount} {imageCount === 1 ? "image" : "images"}
          </Typography>
        )}

        <Box
          className="queued-prompt-actions"
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.25,
            flexShrink: 0,
            opacity: 0,
            transition: "opacity 120ms ease",
          }}
        >
          <IconButton
            type="button"
            aria-label="Edit queued prompt"
            onClick={() => onStartEdit(prompt.id)}
            size="small"
            sx={QUEUED_ROW_ACTION_BTN_SX}
          >
            <Pencil size={14} />
          </IconButton>
          <Tooltip title="Send now (interrupts the running chat)">
            <IconButton
              type="button"
              aria-label="Send now (interrupts the running chat)"
              onClick={() => onSendNow(prompt.id)}
              size="small"
              sx={QUEUED_ROW_ACTION_BTN_SX}
            >
              <ArrowUp size={14} />
            </IconButton>
          </Tooltip>
          <IconButton
            type="button"
            aria-label="Remove queued prompt"
            onClick={() => onRemove(prompt.id)}
            size="small"
            sx={QUEUED_ROW_ACTION_BTN_SX}
          >
            <Trash2 size={14} />
          </IconButton>
        </Box>
      </Box>
    );
  },
);
QueuedPromptRow.displayName = "QueuedPromptRow";

export const QueuedPromptList = React.memo(
  ({
    prompts,
    editingId,
    onStartEdit,
    onSendNow,
    onRemove,
  }: QueuedPromptListProps) => {
    const [expanded, setExpanded] = useState(true);

    if (prompts.length === 0) return null;

    return (
      <Box
        sx={{
          mx: 3.25,
          mb: 0,
          borderRadius: "14px",
          borderBottomLeftRadius: 0,
          borderBottomRightRadius: 0,
          backgroundColor: "var(--bui-surface)",
          boxShadow: "var(--bui-shadow-card)",
          p: 0.5,
          transformOrigin: "bottom",
          animation: `${queueSlideUp} 220ms cubic-bezier(0.4, 0, 0.2, 1)`,
        }}
      >
        <Box
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={() => setExpanded(prev => !prev)}
          onKeyDown={e => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setExpanded(prev => !prev);
            }
          }}
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.5,
            px: 1,
            py: 0.5,
            cursor: "pointer",
            color: "var(--bui-ink-2)",
            borderRadius: "8px",
            transition: "background-color 0.1s",
            "&:hover": { backgroundColor: "var(--bui-hover-2)" },
          }}
        >
          <ChevronDown
            size={14}
            style={{
              transition: "transform 0.2s",
              transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
            }}
          />
          <Typography
            variant="caption"
            sx={{ fontWeight: 600, letterSpacing: 0.2 }}
          >
            {prompts.length} Queued
          </Typography>
        </Box>

        {expanded && (
          <Box sx={{ display: "flex", flexDirection: "column" }}>
            {prompts.map(prompt => (
              <QueuedPromptRow
                key={prompt.id}
                prompt={prompt}
                isEditing={prompt.id === editingId}
                onStartEdit={onStartEdit}
                onSendNow={onSendNow}
                onRemove={onRemove}
              />
            ))}
          </Box>
        )}
      </Box>
    );
  },
);
QueuedPromptList.displayName = "QueuedPromptList";
