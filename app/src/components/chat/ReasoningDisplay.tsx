import React from "react";
import { Box, Button } from "@mui/material";
import { ChevronDown, ChevronRight } from "lucide-react";
import { StreamingMarkdown } from "../StreamingMarkdown";

// ReasoningDisplay for showing reasoning/thinking parts inline.
// - Auto-opens while streaming, auto-collapses when done.
// - Shows elapsed thinking time ("Thought for Xs").
// - Scrollable container with max height, auto-scrolls during streaming.
export const ReasoningDisplay = React.memo(
  ({
    reasoningText,
    isStreaming,
    paletteMode: _paletteMode,
  }: {
    reasoningText: string;
    isStreaming: boolean;
    paletteMode: "light" | "dark";
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
    const isOpen = userToggled ? userOpen : isStreaming && !finished;

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
      label = `Thinking${elapsedSeconds > 0 ? ` for ${elapsedSeconds}s` : ""}...`;
    } else if (wasLiveRef.current) {
      label = `Thought for ${elapsedSeconds || "<1"}s`;
    } else {
      label = "Thinking process";
    }

    return (
      <Box sx={{ my: 0.5 }}>
        <Button
          size="small"
          onClick={handleToggle}
          endIcon={
            isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          }
          sx={{
            color: "text.secondary",
            textTransform: "none",
            fontSize: "0.8rem",
            p: 0,
            minWidth: "auto",
            "& .MuiButton-endIcon": {
              opacity: isOpen ? 1 : 0,
              transition: "opacity 0.15s ease",
            },
            "&:hover .MuiButton-endIcon": {
              opacity: 1,
            },
            "&:hover": {
              backgroundColor: "transparent",
            },
          }}
          disableRipple
        >
          {label}
        </Button>
        {isOpen && (
          <Box
            ref={scrollRef}
            sx={{
              mt: 0.5,
              pl: 2,
              borderLeft: 2,
              borderColor: "divider",
              color: "text.secondary",
              fontSize: "0.85rem",
              maxHeight: 300,
              overflowY: "auto",
              "& p": { my: 0.5 },
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
