import React from "react";
import { Box, Tooltip, Typography } from "@mui/material";
import { Sparkles, ClipboardList } from "lucide-react";
import { useSettingsStore } from "../store/settingsStore";

/**
 * Compact Plan/Agent lifecycle-mode toggle for the chat composer.
 *
 * - Agent (default): the assistant acts directly.
 * - Plan: the assistant clarifies, explores read-only, and must get the user's
 *   approval on a plan before any mutating tool can run.
 *
 * Cursor-style: also toggleable with Shift+Tab from the composer.
 */
export const ChatModeSelector: React.FC = () => {
  const chatMode = useSettingsStore(s => s.chatMode);
  const toggleChatMode = useSettingsStore(s => s.toggleChatMode);
  const isPlan = chatMode === "plan";

  return (
    <Tooltip
      title={
        isPlan
          ? "Plan mode: clarify and plan before any changes (Shift+Tab)"
          : "Agent mode: act directly (Shift+Tab for Plan mode)"
      }
      placement="top"
    >
      <Box
        component="button"
        type="button"
        onClick={() => toggleChatMode()}
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: 0.5,
          px: 0.75,
          height: 24,
          borderRadius: 1.5,
          border: 1,
          borderColor: isPlan ? "primary.main" : "divider",
          bgcolor: isPlan ? "action.selected" : "transparent",
          color: isPlan ? "primary.main" : "text.secondary",
          cursor: "pointer",
          flexShrink: 0,
          "&:hover": {
            borderColor: isPlan ? "primary.main" : "text.secondary",
            color: isPlan ? "primary.main" : "text.primary",
          },
        }}
      >
        {isPlan ? <ClipboardList size={13} /> : <Sparkles size={13} />}
        <Typography
          variant="caption"
          sx={{ fontWeight: 600, lineHeight: 1, fontSize: 11 }}
        >
          {isPlan ? "Plan" : "Agent"}
        </Typography>
      </Box>
    </Tooltip>
  );
};
