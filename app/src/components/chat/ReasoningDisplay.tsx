import React from "react";
import { Brain } from "lucide-react";
import { StreamingMarkdown } from "../StreamingMarkdown";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
  TraceLine,
  TraceIcon,
  TraceTitle,
} from "../ui/trace";

// ReasoningDisplay for showing reasoning/thinking parts inline.
// - Auto-opens while streaming, auto-collapses when done.
// - Shows elapsed thinking time ("Thought for Xs").
// - Scrollable container with max height, auto-scrolls during streaming.
export const ReasoningDisplay = React.memo(
  ({
    reasoningText,
    isStreaming,
    /**
     * Local ACP only: keep empty Thinking placeholders label-only. Default
     * in-app chat keeps the historical auto-expand-while-streaming behavior.
     */
    collapseEmptyWhileStreaming = false,
    /**
     * Tightens the vertical margins so a run of consecutive thinking blocks
     * reads as ONE stack instead of several floating rows. A plain boolean, so
     * the default shallow `React.memo` comparison stays correct.
     */
    clustered = false,
  }: {
    reasoningText: string;
    isStreaming: boolean;
    /**
     * Load-bearing in `chat-message-comparator.ts` (a theme toggle must
     * re-render the row) even though this component reads its colors from CSS
     * custom properties and never uses the value directly.
     */
    paletteMode: "light" | "dark";
    collapseEmptyWhileStreaming?: boolean;
    clustered?: boolean;
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
      label = "Thought";
    }

    const line = (
      <TraceLine
        status={isStreaming ? "running" : undefined}
        className="min-h-7"
      >
        <TraceIcon>
          <Brain />
        </TraceIcon>
        <TraceTitle>{label}</TraceTitle>
      </TraceLine>
    );

    return (
      <Trace className={clustered ? "my-0.5" : "my-1"}>
        {hasText ? (
          <TraceCollapsible open={isOpen} onOpenChange={handleToggle}>
            <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
            <TraceCollapsibleContent>
              <div
                ref={scrollRef}
                className="max-h-72 overflow-y-auto text-sm leading-relaxed"
              >
                <StreamingMarkdown isStreaming={isStreaming}>
                  {reasoningText}
                </StreamingMarkdown>
              </div>
            </TraceCollapsibleContent>
          </TraceCollapsible>
        ) : (
          line
        )}
      </Trace>
    );
  },
);

ReasoningDisplay.displayName = "ReasoningDisplay";
