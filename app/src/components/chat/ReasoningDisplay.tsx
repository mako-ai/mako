import React from "react";
import { Box, ButtonBase } from "@mui/material";
import { ChevronDown } from "lucide-react";
import { StreamingMarkdown } from "../StreamingMarkdown";
import { buiShimmerLabelSx } from "./bui-styles";

// Beautiful UI "Thinking" sparkle glyph.
function SparkleIcon({ dim }: { dim: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill={dim ? "var(--bui-ink-3)" : "var(--bui-ink-2)"}
      aria-hidden
    >
      <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
    </svg>
  );
}

// ReasoningDisplay for showing reasoning/thinking parts inline.
// - Auto-opens while streaming, auto-collapses when done.
// - Shows elapsed thinking time ("Thought for Xs").
// - Scrollable container with max height, auto-scrolls during streaming.
export const ReasoningDisplay = React.memo(
  ({
    reasoningText,
    isStreaming,
    paletteMode: _paletteMode,
    /**
     * Local ACP only: keep empty Thinking placeholders label-only. Default
     * in-app chat keeps the historical auto-expand-while-streaming behavior.
     */
    collapseEmptyWhileStreaming = false,
  }: {
    reasoningText: string;
    isStreaming: boolean;
    paletteMode: "light" | "dark";
    collapseEmptyWhileStreaming?: boolean;
  }) => {
    const [userToggled, setUserToggled] = React.useState(false);
    const [userOpen, setUserOpen] = React.useState(false);
    const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
    // Latches true once this block has streamed and then stopped. A finished
    // thinking block must NEVER auto-reopen: reopening it would grow a block
    // sitting ABOVE the currently-streaming one, shifting everything below and
    // making the chat jump. Once done it stays collapsed unless the user opens
    // it. (A given reasoning group streams exactly once, so latching is safe.)
    const [finished, setFinished] = React.useState(false);
    // Track whether this component was live-streamed (vs loaded from history)
    const wasLiveRef = React.useRef(false);
    const startTimeRef = React.useRef<number | null>(null);
    const scrollRef = React.useRef<HTMLDivElement>(null);

    // Auto-open only while THIS block is actively streaming and not yet
    // finished; auto-close the moment it finishes. If the user manually
    // toggled, respect their choice.
    const hasText = reasoningText.trim().length > 0;
    const streamingOpen =
      isStreaming && !finished && (!collapseEmptyWhileStreaming || hasText);
    const isOpen = userToggled ? userOpen : streamingOpen;

    const handleToggle = () => {
      setUserToggled(true);
      setUserOpen(!isOpen);
    };

    // Timer: start counting when streaming begins, freeze when it stops
    React.useEffect(() => {
      // Never restart a block that already finished (guards against a spurious
      // `isStreaming` flip re-opening / re-timing a completed block).
      if (isStreaming && !finished) {
        // Mark that this component saw a live session
        wasLiveRef.current = true;
        // Reset for new streaming session
        setUserToggled(false);
        startTimeRef.current = Date.now();
        setElapsedSeconds(0);

        const interval = setInterval(() => {
          if (startTimeRef.current) {
            setElapsedSeconds(
              Math.round((Date.now() - startTimeRef.current) / 1000),
            );
          }
        }, 1000);

        return () => clearInterval(interval);
      }
      // Streaming just stopped — freeze the elapsed time
      // (elapsedSeconds already holds the last value) and latch this block as
      // done so it can never auto-reopen.
      startTimeRef.current = null;
      if (wasLiveRef.current) setFinished(true);
    }, [isStreaming, finished]);

    // Auto-scroll the reasoning container to the bottom while streaming
    React.useEffect(() => {
      if (isStreaming && isOpen && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }, [reasoningText, isStreaming, isOpen]);

    // Build the label text
    let label: string;
    if (isStreaming) {
      label = `Thinking${elapsedSeconds > 0 ? ` for ${elapsedSeconds}s` : ""}`;
    } else if (wasLiveRef.current) {
      label = `Thought for ${elapsedSeconds || "<1"}s`;
    } else {
      label = "Thinking process";
    }

    return (
      <Box sx={{ my: 0.5 }}>
        <ButtonBase
          onClick={handleToggle}
          aria-expanded={isOpen}
          disableRipple
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 0.75,
            py: 0.5,
            mx: -0.75,
            borderRadius: "8px",
            width: "fit-content",
            transition: "background-color 0.1s",
            "&:hover": {
              backgroundColor: "var(--bui-hover-2)",
            },
          }}
        >
          <SparkleIcon dim={!isStreaming} />
          <Box
            component="span"
            sx={{
              fontSize: "13px",
              fontWeight: 500,
              whiteSpace: "nowrap",
              ...(isStreaming
                ? buiShimmerLabelSx
                : { color: "var(--bui-ink-2)" }),
            }}
          >
            {label}
          </Box>
          <ChevronDown
            size={14}
            style={{
              color: "var(--bui-ink-3)",
              transition: "transform 0.3s",
              transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
              flexShrink: 0,
            }}
          />
        </ButtonBase>
        {isOpen && (
          <Box
            ref={scrollRef}
            sx={{
              mt: 0.5,
              ml: "6px",
              pl: 2,
              borderLeft: "1px solid var(--bui-line-strong)",
              color: "var(--bui-ink-2)",
              fontSize: "12.5px",
              lineHeight: 1.65,
              maxHeight: 300,
              overflowY: "auto",
              "& p": { my: 0.5 },
              "& [data-streamdown]": { fontSize: "12.5px" },
            }}
          >
            <StreamingMarkdown>{reasoningText}</StreamingMarkdown>
          </Box>
        )}
      </Box>
    );
  },
);

ReasoningDisplay.displayName = "ReasoningDisplay";
