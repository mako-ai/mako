/**
 * What a chat with no messages shows.
 *
 * Previously mobile-only, which left the desktop chat pane a blank white void
 * above the composer. The two densities genuinely differ: a full-screen mobile
 * tab suits a centred chip cloud, while the ~540px desktop pane needs the
 * suggestions to read as a short menu rather than wrapped confetti.
 *
 * Rendered as an absolutely positioned overlay sibling of the virtual list, so
 * it never participates in the scroller.
 */

import React from "react";
import { Box, ButtonBase, Chip, Typography } from "@mui/material";
import { ArrowUpRight, Sparkles } from "lucide-react";

const ASK_SUGGESTIONS = [
  "What tables are in my database?",
  "Show me the 10 most recent records",
  "How many rows are in each table?",
  "Summarize my data with a chart",
];

interface ChatEmptyStateProps {
  isMobile: boolean;
  disabled: boolean;
  onSelect: (prompt: string) => void;
}

export const ChatEmptyState = React.memo(function ChatEmptyState({
  isMobile,
  disabled,
  onSelect,
}: ChatEmptyStateProps) {
  return (
    <Box
      sx={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        textAlign: "center",
        px: 3,
        py: 2,
        // The pane can be short — an ACP banner or the prompt queue docked
        // below it leaves as little as ~260px. `justify-content: center`
        // overflows symmetrically, so the hero used to bleed up into the
        // header and the last suggestion down over the banner. Scroll instead,
        // and centre via the inner block's auto margins, which pin content to
        // the top once it no longer fits rather than pushing it out of view.
        overflowY: "auto",
        overscrollBehavior: "contain",
        // Only rendered when the thread is empty, so there is nothing
        // underneath that still needs to receive clicks or wheel events.
        pointerEvents: "auto",
        // Virtuoso's scroller is a positioned sibling that comes LATER in DOM
        // order, so with `z-index: auto` it paints on top of this overlay and
        // swallows every click on a starter prompt — the intro screen looks
        // right and does nothing. Measured on the preview: a hit test at a
        // suggestion's centre returned Virtuoso's div, not the button.
        zIndex: 1,
      }}
    >
      <Box
        sx={{
          margin: "auto",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          width: "100%",
          gap: isMobile ? 3 : 2.5,
        }}
      >
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 1.5,
          }}
        >
          <Box
            aria-hidden
            sx={{
              width: 44,
              height: 44,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "var(--bui-inset)",
              color: "var(--bui-ink-3)",
            }}
          >
            <Sparkles size={20} />
          </Box>
          <Box>
            <Typography
              variant={isMobile ? "h5" : "h6"}
              sx={{ fontWeight: 700 }}
            >
              Ask your data
            </Typography>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 1, maxWidth: 360 }}
            >
              Ask a question in plain English — Mako writes and runs the query
              for you.
            </Typography>
          </Box>
        </Box>

        {isMobile ? (
          <Box
            sx={{
              display: "flex",
              flexWrap: "wrap",
              gap: 1,
              justifyContent: "center",
              maxWidth: 440,
            }}
          >
            {ASK_SUGGESTIONS.map(suggestion => (
              <Chip
                key={suggestion}
                label={suggestion}
                clickable
                variant="outlined"
                disabled={disabled}
                onClick={() => onSelect(suggestion)}
                sx={{
                  height: "auto",
                  py: 0.75,
                  "& .MuiChip-label": {
                    whiteSpace: "normal",
                    display: "block",
                    textAlign: "left",
                  },
                }}
              />
            ))}
          </Box>
        ) : (
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              gap: 0.75,
              width: "100%",
              maxWidth: 380,
            }}
          >
            {ASK_SUGGESTIONS.map(suggestion => (
              <ButtonBase
                key={suggestion}
                disabled={disabled}
                onClick={() => onSelect(suggestion)}
                sx={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 1,
                  width: "100%",
                  px: 1.5,
                  py: 1,
                  borderRadius: "8px",
                  textAlign: "left",
                  fontSize: "13px",
                  color: "var(--bui-ink)",
                  backgroundColor: "var(--bui-surface)",
                  boxShadow: "var(--bui-shadow-hairline)",
                  transition: "background-color 120ms ease-out",
                  "&:hover": { backgroundColor: "var(--bui-hover-2)" },
                  "&.Mui-disabled": { opacity: 0.5 },
                }}
              >
                <Box component="span">{suggestion}</Box>
                <Box
                  component="span"
                  aria-hidden
                  sx={{
                    display: "flex",
                    color: "var(--bui-ink-3)",
                    flexShrink: 0,
                  }}
                >
                  <ArrowUpRight size={14} />
                </Box>
              </ButtonBase>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
});
