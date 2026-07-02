import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Box, Typography } from "@mui/material";

const userMessageTextSx = {
  maxWidth: "100%",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  overflowWrap: "break-word",
} as const;

// Sent user messages are collapsed in the history so a long prompt doesn't
// dominate the transcript. Show at most this many lines before clamping.
const USER_MESSAGE_COLLAPSED_LINES = 3;

const userMessageToggleSx = {
  display: "inline-block",
  mt: 0.5,
  border: "none",
  background: "none",
  p: 0,
  cursor: "pointer",
  color: "text.secondary",
  fontWeight: 600,
  "&:hover": { color: "text.primary", textDecoration: "underline" },
} as const;

/**
 * Renders a sent user message's text, collapsed to a few lines with an ellipsis
 * when it's long. Clicking the text (or the Show more/less toggle) expands and
 * re-collapses it. The toggle only appears when the text actually overflows the
 * collapsed clamp, so short messages render unchanged.
 */
export function CollapsibleUserText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const textRef = useRef<HTMLDivElement | null>(null);

  // Measure whether the clamped text overflows. Only meaningful while
  // collapsed, where the clamp limits height; comparing the full content
  // height (scrollHeight) against the visible height (clientHeight) tells us
  // if there's hidden content worth a toggle.
  useLayoutEffect(() => {
    if (expanded) return;
    const el = textRef.current;
    if (!el) return;
    setIsOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);

  const canToggle = isOverflowing || expanded;
  const toggle = useCallback(() => setExpanded(prev => !prev), []);

  return (
    <Box>
      <Typography
        ref={textRef}
        variant="body2"
        color="text.primary"
        onClick={canToggle ? toggle : undefined}
        sx={{
          ...userMessageTextSx,
          ...(canToggle && { cursor: "pointer" }),
          ...(!expanded && {
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: USER_MESSAGE_COLLAPSED_LINES,
            overflow: "hidden",
          }),
        }}
      >
        {text}
      </Typography>
      {canToggle && (
        <Typography
          component="button"
          type="button"
          onClick={toggle}
          variant="caption"
          sx={userMessageToggleSx}
        >
          {expanded ? "Show less" : "Show more"}
        </Typography>
      )}
    </Box>
  );
}
